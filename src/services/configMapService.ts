import * as k8s from '@kubernetes/client-node';
import { KubernetesClient, interpretarErroKubernetes } from '../kubernetes/kubernetesClient';

/**
 * Representação tipada de um ConfigMap Kubernetes.
 */
export interface ConfigMapInfo {
    nome: string;
    namespace: string;
    chaves: string[];
    criado: Date;
}

/**
 * ConfigMap com dados completos (para inspeção).
 */
export interface ConfigMapDetalhado extends ConfigMapInfo {
    dados: Record<string, string>;
}

/**
 * Serviço responsável por operações de ConfigMaps Kubernetes.
 */
export class ConfigMapService {
    private readonly client: KubernetesClient;

    constructor() {
        this.client = KubernetesClient.getInstance();
    }

    /**
     * Lista todos os ConfigMaps de um namespace.
     */
    public async listar(namespace: string): Promise<ConfigMapInfo[]> {
        try {
            const api = this.client.getCoreApi();
            const resposta = await api.listNamespacedConfigMap({ namespace });
            const itens = resposta.items ?? [];
            return itens.map(cm => ({
                nome: cm.metadata?.name ?? 'desconhecido',
                namespace: cm.metadata?.namespace ?? 'default',
                chaves: Object.keys(cm.data ?? {}),
                criado: cm.metadata?.creationTimestamp
                    ? new Date(cm.metadata.creationTimestamp)
                    : new Date(),
            }));
        } catch (err) {
            throw new Error(`Erro ao listar configmaps: ${interpretarErroKubernetes(err)}`);
        }
    }

    /**
     * Inspeciona um ConfigMap com todos os pares chave-valor.
     */
    public async inspecionar(namespace: string, nome: string): Promise<ConfigMapDetalhado> {
        try {
            const api = this.client.getCoreApi();
            const resposta = await api.readNamespacedConfigMap({ name: nome, namespace });
            return this.mapearConfigMapDetalhado(resposta);
        } catch (err) {
            throw new Error(
                `Erro ao inspecionar configmap "${nome}": ${interpretarErroKubernetes(err)}`,
            );
        }
    }

    /**
     * Mapeia um ConfigMap da API para o formato detalhado.
     */
    private mapearConfigMapDetalhado(cm: k8s.V1ConfigMap): ConfigMapDetalhado {
        const dados = cm.data ?? {};
        return {
            nome: cm.metadata?.name ?? 'desconhecido',
            namespace: cm.metadata?.namespace ?? 'default',
            chaves: Object.keys(dados),
            dados,
            criado: cm.metadata?.creationTimestamp
                ? new Date(cm.metadata.creationTimestamp)
                : new Date(),
        };
    }
}
