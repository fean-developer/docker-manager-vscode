import * as k8s from '@kubernetes/client-node';
import { KubernetesClient, interpretarErroKubernetes } from '../kubernetes/kubernetesClient';

/**
 * Representação tipada de um DaemonSet Kubernetes.
 */
export interface DaemonSetInfo {
    nome: string;
    namespace: string;
    desiredNumberScheduled: number;
    numberAvailable: number;
    imagens: string[];
    criado: Date;
}

/**
 * Serviço responsável por operações de DaemonSets Kubernetes.
 */
export class DaemonSetService {
    private readonly client: KubernetesClient;

    constructor() {
        this.client = KubernetesClient.getInstance();
    }

    /**
     * Lista todos os DaemonSets de um namespace.
     */
    public async listar(namespace: string): Promise<DaemonSetInfo[]> {
        try {
            const api = this.client.getAppsApi();
            const resposta = await api.listNamespacedDaemonSet({ namespace });
            const itens = resposta.items ?? [];
            return itens.map(ds => this.mapearDaemonSetInfo(ds));
        } catch (err) {
            throw new Error(`Erro ao listar DaemonSets: ${interpretarErroKubernetes(err)}`);
        }
    }

    /**
     * Deleta um DaemonSet do cluster.
     */
    public async deletar(namespace: string, nome: string): Promise<void> {
        try {
            const api = this.client.getAppsApi();
            await api.deleteNamespacedDaemonSet({ name: nome, namespace });
        } catch (err) {
            throw new Error(
                `Erro ao deletar DaemonSet "${nome}": ${interpretarErroKubernetes(err)}`,
            );
        }
    }

    /**
     * Mapeia um objeto DaemonSet da API Kubernetes para DaemonSetInfo.
     */
    private mapearDaemonSetInfo(ds: k8s.V1DaemonSet): DaemonSetInfo {
        return {
            nome: ds.metadata?.name ?? 'desconhecido',
            namespace: ds.metadata?.namespace ?? 'default',
            desiredNumberScheduled: ds.status?.desiredNumberScheduled ?? 0,
            numberAvailable: ds.status?.numberAvailable ?? 0,
            imagens: (ds.spec?.template?.spec?.containers ?? []).map(c => c.image ?? ''),
            criado: ds.metadata?.creationTimestamp
                ? new Date(ds.metadata.creationTimestamp)
                : new Date(),
        };
    }
}
