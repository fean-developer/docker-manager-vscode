import { KubernetesClient, interpretarErroKubernetes } from '../kubernetes/kubernetesClient';

/**
 * Representação tipada de um node Kubernetes.
 */
export interface NodeInfo {
    nome: string;
    status: 'Ready' | 'NotReady' | 'Unknown';
    roles: string[];
    versao: string;
    cpu: { capacidade: string; alocavel: string };
    memoria: { capacidade: string; alocavel: string };
    criado: Date;
}

/**
 * Serviço responsável por operações de nodes Kubernetes.
 */
export class NodeService {
    private readonly client: KubernetesClient;

    constructor() {
        this.client = KubernetesClient.getInstance();
    }

    /**
     * Lista todos os nodes do cluster com status e capacidade.
     */
    public async listar(): Promise<NodeInfo[]> {
        try {
            const api = this.client.getCoreApi();
            const resposta = await api.listNode();
            const itens = resposta.items ?? [];
            return itens.map(node => {
                const condicoes = node.status?.conditions ?? [];
                const condicaoReady = condicoes.find(c => c.type === 'Ready');
                let status: NodeInfo['status'] = 'Unknown';
                if (condicaoReady?.status === 'True') { status = 'Ready'; }
                else if (condicaoReady?.status === 'False') { status = 'NotReady'; }

                // Extrair roles dos labels (node-role.kubernetes.io/xxx)
                const labels = node.metadata?.labels ?? {};
                const roles = Object.keys(labels)
                    .filter(k => k.startsWith('node-role.kubernetes.io/'))
                    .map(k => k.replace('node-role.kubernetes.io/', ''));
                if (roles.length === 0) { roles.push('worker'); }

                return {
                    nome: node.metadata?.name ?? 'desconhecido',
                    status,
                    roles,
                    versao: node.status?.nodeInfo?.kubeletVersion ?? 'desconhecida',
                    cpu: {
                        capacidade: node.status?.capacity?.['cpu'] ?? '0',
                        alocavel: node.status?.allocatable?.['cpu'] ?? '0',
                    },
                    memoria: {
                        capacidade: node.status?.capacity?.['memory'] ?? '0',
                        alocavel: node.status?.allocatable?.['memory'] ?? '0',
                    },
                    criado: node.metadata?.creationTimestamp
                        ? new Date(node.metadata.creationTimestamp)
                        : new Date(),
                };
            });
        } catch (err) {
            throw new Error(`Erro ao listar nodes: ${interpretarErroKubernetes(err)}`);
        }
    }
}
