import * as k8s from '@kubernetes/client-node';
import { KubernetesClient, interpretarErroKubernetes } from '../kubernetes/kubernetesClient';

/**
 * Representação tipada de um Deployment Kubernetes.
 */
export interface DeploymentInfo {
    nome: string;
    namespace: string;
    replicasDesejadas: number;
    replicasDisponiveis: number;
    replicasProntas: number;
    imagens: string[];
    criado: Date;
}

/**
 * Serviço responsável por operações de Deployments Kubernetes.
 */
export class DeploymentService {
    private readonly client: KubernetesClient;

    constructor() {
        this.client = KubernetesClient.getInstance();
    }

    /**
     * Lista todos os deployments de um namespace.
     */
    public async listar(namespace: string): Promise<DeploymentInfo[]> {
        try {
            const api = this.client.getAppsApi();
            const resposta = await api.listNamespacedDeployment({ namespace });
            const itens = resposta.items ?? [];
            return itens.map(d => this.mapearDeploymentInfo(d));
        } catch (err) {
            throw new Error(`Erro ao listar deployments: ${interpretarErroKubernetes(err)}`);
        }
    }

    /**
     * Escala um deployment para o número desejado de réplicas.
     */
    public async escalar(namespace: string, nome: string, replicas: number): Promise<void> {
        try {
            const api = this.client.getAppsApi();
            // Usa o subresource /scale — apenas atualiza spec.replicas, não aciona rollout
            await api.replaceNamespacedDeploymentScale({
                name: nome,
                namespace,
                body: {
                    apiVersion: 'autoscaling/v1',
                    kind: 'Scale',
                    metadata: { name: nome, namespace },
                    spec: { replicas },
                },
            });
        } catch (err) {
            throw new Error(
                `Erro ao escalar deployment "${nome}" para ${replicas} réplica(s): ${interpretarErroKubernetes(err)}`,
            );
        }
    }

    /**
     * Faz restart rollout de um deployment usando JSON Patch.
     * Muda APENAS a annotation kubectl.kubernetes.io/restartedAt — não toca em spec.replicas
     * nem em qualquer outro campo, equivalente a `kubectl rollout restart`.
     */
    public async reiniciarRollout(namespace: string, nome: string): Promise<void> {
        try {
            const api = this.client.getAppsApi();
            const agora = new Date().toISOString();

            // Verifica se o objeto spec.template.metadata.annotations já existe para
            // montar o patch JSON correto sem derrubar as annotations existentes.
            const atual = await api.readNamespacedDeployment({ name: nome, namespace });
            const anotacoesExistem = !!atual.spec?.template?.metadata?.annotations;

            // Usa JSON Patch (RFC 6902) — o padrão Content-Type selecionado pelo client-node
            // para métodos patch*. Precisão cirúrgica: apenas a anotação é alterada.
            const patchOps: Array<{ op: string; path: string; value: unknown }> = anotacoesExistem
                ? [
                    {
                        op: 'add',
                        path: '/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt',
                        value: agora,
                    },
                ]
                : [
                    // Cria o mapa de annotations inteiro quando não existe ainda
                    {
                        op: 'add',
                        path: '/spec/template/metadata/annotations',
                        value: { 'kubectl.kubernetes.io/restartedAt': agora },
                    },
                ];

            await api.patchNamespacedDeployment({ name: nome, namespace, body: patchOps });
        } catch (err) {
            throw new Error(
                `Erro ao reiniciar rollout do deployment "${nome}": ${interpretarErroKubernetes(err)}`,
            );
        }
    }

    /**
     * Deleta um deployment do cluster.
     */
    public async deletar(namespace: string, nome: string): Promise<void> {
        try {
            const api = this.client.getAppsApi();
            await api.deleteNamespacedDeployment({ name: nome, namespace });
        } catch (err) {
            throw new Error(
                `Erro ao deletar deployment "${nome}": ${interpretarErroKubernetes(err)}`,
            );
        }
    }

    /**
     * Mapeia um objeto Deployment da API Kubernetes para DeploymentInfo.
     */
    private mapearDeploymentInfo(d: k8s.V1Deployment): DeploymentInfo {
        return {
            nome: d.metadata?.name ?? 'desconhecido',
            namespace: d.metadata?.namespace ?? 'default',
            replicasDesejadas: d.spec?.replicas ?? 0,
            replicasDisponiveis: d.status?.availableReplicas ?? 0,
            replicasProntas: d.status?.readyReplicas ?? 0,
            imagens: (d.spec?.template?.spec?.containers ?? []).map(c => c.image ?? ''),
            criado: d.metadata?.creationTimestamp
                ? new Date(d.metadata.creationTimestamp)
                : new Date(),
        };
    }
}
