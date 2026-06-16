import * as vscode from 'vscode';
import * as k8s from '@kubernetes/client-node';
import { KubernetesClient, interpretarErroKubernetes } from '../kubernetes/kubernetesClient';

/**
 * Representação tipada de um Pod Kubernetes.
 */
export interface PodInfo {
    nome: string;
    namespace: string;
    status: 'Running' | 'Pending' | 'Failed' | 'Succeeded' | 'Unknown' | 'CrashLoopBackOff';
    imagens: string[];
    restarts: number;
    criado: Date;
    nodeName: string;
    pronto: boolean;
}

/**
 * Serviço responsável por operações de Pods Kubernetes.
 */
export class PodService {
    private readonly client: KubernetesClient;

    constructor() {
        this.client = KubernetesClient.getInstance();
    }

    /**
     * Lista todos os pods de um namespace.
     */
    public async listar(namespace: string): Promise<PodInfo[]> {
        try {
            const api = this.client.getCoreApi();
            const resposta = await api.listNamespacedPod({ namespace });
            const itens = resposta.items ?? [];
            return itens.map(pod => this.mapearPodInfo(pod));
        } catch (err) {
            throw new Error(`Erro ao listar pods: ${interpretarErroKubernetes(err)}`);
        }
    }

    /**
     * Obtém os logs de um pod.
     * @param namespace Namespace do pod
     * @param nome Nome do pod
     * @param container Container específico (opcional — usa o primeiro se omitido)
     * @returns String com as últimas linhas de log
     */
    public async obterLogs(namespace: string, nome: string, container?: string): Promise<string> {
        try {
            const api = this.client.getCoreApi();
            const params: Parameters<typeof api.readNamespacedPodLog>[0] = {
                name: nome,
                namespace,
                tailLines: 200,
                timestamps: true,
            };
            if (container) { params.container = container; }
            const resposta = await api.readNamespacedPodLog(params);
            return typeof resposta === 'string' ? resposta : String(resposta);
        } catch (err) {
            throw new Error(`Erro ao obter logs do pod "${nome}": ${interpretarErroKubernetes(err)}`);
        }
    }

    /**
     * Exibe os logs de um pod em um terminal integrado do VS Code (streaming).
     */
    public async abrirLogsNoTerminal(namespace: string, nome: string, container?: string): Promise<void> {
        const kc = new k8s.KubeConfig();
        kc.loadFromDefault();

        const log = new k8s.Log(kc);
        const labelTerminal = container
            ? `Logs: ${nome} [${container}]`
            : `Logs: ${nome}`;
        const terminal = vscode.window.createTerminal({ name: labelTerminal });
        terminal.show();

        // Mostra os logs históricos via sendText
        try {
            const logsHistoricos = await this.obterLogs(namespace, nome, container);
            if (logsHistoricos.trim()) {
                const linhas = logsHistoricos.split('\n').slice(0, 100);
                terminal.sendText(`echo "=== Logs: ${nome} (${namespace}) ==="`, true);
                for (const linha of linhas) {
                    if (linha.trim()) {
                        terminal.sendText(`echo ${JSON.stringify(linha)}`, true);
                    }
                }
            }
        } catch {
            // Ignora erro de histórico — streaming pode ainda funcionar
        }

        // Inicia streaming de logs (follow) — retorna AbortController para cancelar
        try {
            const { Writable } = await import('stream');
            const writableStream = new Writable({
                write(chunk, _encoding, callback) {
                    terminal.sendText(`echo ${JSON.stringify(String(chunk))}`, true);
                    callback();
                },
            });

            const abortController = await log.log(namespace, nome, container ?? '', writableStream, {
                follow: true,
                tailLines: 50,
                timestamps: true,
            });

            // Para o streaming quando o terminal for fechado
            vscode.window.onDidCloseTerminal(t => {
                if (t === terminal) {
                    abortController.abort();
                }
            });
        } catch {
            // Sem streaming — os logs históricos já foram exibidos
        }
    }

    /**
     * Abre um shell interativo em um pod via terminal integrado do VS Code.
     * Utiliza kubectl exec para máxima compatibilidade (bash ou sh).
     * @param namespace Namespace do pod
     * @param nome Nome do pod
     * @param container Container específico (opcional — usa o primeiro se omitido)
     */
    public async exec(namespace: string, nome: string, container?: string): Promise<void> {
        const containerArg = container ? ` -c ${container}` : '';
        // Tenta bash; cai para sh se não disponível
        const cmd = `kubectl exec -it ${nome} -n ${namespace}${containerArg} -- sh -c 'bash 2>/dev/null || sh'`;
        const terminal = vscode.window.createTerminal({ name: `Shell: ${nome}` });
        terminal.sendText(cmd);
        terminal.show();
    }

    /**
     * Deleta um pod do cluster.
     * @param namespace Namespace do pod
     * @param nome Nome do pod
     */
    public async deletar(namespace: string, nome: string): Promise<void> {
        try {
            const api = this.client.getCoreApi();
            await api.deleteNamespacedPod({ name: nome, namespace });
        } catch (err) {
            throw new Error(`Erro ao deletar pod "${nome}": ${interpretarErroKubernetes(err)}`);
        }
    }

    /**
     * Mapeia um objeto Pod da API Kubernetes para a interface PodInfo.
     */
    private mapearPodInfo(pod: k8s.V1Pod): PodInfo {
        const faseK8s = pod.status?.phase ?? 'Unknown';
        const containerStatuses = pod.status?.containerStatuses ?? [];

        // Detectar CrashLoopBackOff
        const temCrashLoop = containerStatuses.some(
            cs => cs.state?.waiting?.reason === 'CrashLoopBackOff',
        );

        let status: PodInfo['status'];
        if (temCrashLoop) {
            status = 'CrashLoopBackOff';
        } else {
            switch (faseK8s) {
                case 'Running': status = 'Running'; break;
                case 'Pending': status = 'Pending'; break;
                case 'Failed': status = 'Failed'; break;
                case 'Succeeded': status = 'Succeeded'; break;
                default: status = 'Unknown';
            }
        }

        const totalRestarts = containerStatuses.reduce(
            (acc, cs) => acc + (cs.restartCount ?? 0),
            0,
        );

        const prontos = containerStatuses.filter(cs => cs.ready).length;
        const totalContainers = containerStatuses.length;

        return {
            nome: pod.metadata?.name ?? 'desconhecido',
            namespace: pod.metadata?.namespace ?? 'default',
            status,
            imagens: (pod.spec?.containers ?? []).map(c => c.image ?? ''),
            restarts: totalRestarts,
            criado: pod.metadata?.creationTimestamp
                ? new Date(pod.metadata.creationTimestamp)
                : new Date(),
            nodeName: pod.spec?.nodeName ?? '',
            pronto: prontos === totalContainers && totalContainers > 0,
        };
    }
}
