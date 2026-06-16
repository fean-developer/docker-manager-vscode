import { KubernetesClient, interpretarErroKubernetes } from '../kubernetes/kubernetesClient';

/**
 * Representação tipada de um namespace Kubernetes.
 */
export interface NamespaceInfo {
    nome: string;
    status: 'Active' | 'Terminating' | string;
    criado: Date;
}

/**
 * Serviço responsável por operações de namespaces Kubernetes.
 */
export class NamespaceService {
    private readonly client: KubernetesClient;

    constructor() {
        this.client = KubernetesClient.getInstance();
    }

    /**
     * Lista todos os namespaces do cluster.
     */
    public async listar(): Promise<NamespaceInfo[]> {
        try {
            const api = this.client.getCoreApi();
            const resposta = await api.listNamespace();
            const itens = resposta.items ?? [];
            return itens.map(ns => ({
                nome: ns.metadata?.name ?? 'desconhecido',
                status: (ns.status?.phase ?? 'Active') as NamespaceInfo['status'],
                criado: ns.metadata?.creationTimestamp
                    ? new Date(ns.metadata.creationTimestamp)
                    : new Date(),
            }));
        } catch (err) {
            throw new Error(`Erro ao listar namespaces: ${interpretarErroKubernetes(err)}`);
        }
    }
}
