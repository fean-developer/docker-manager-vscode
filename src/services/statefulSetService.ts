import * as k8s from '@kubernetes/client-node';
import { KubernetesClient, interpretarErroKubernetes } from '../kubernetes/kubernetesClient';

/**
 * Representação tipada de um StatefulSet Kubernetes.
 */
export interface StatefulSetInfo {
    nome: string;
    namespace: string;
    replicasDesejadas: number;
    replicasProntas: number;
    imagens: string[];
    criado: Date;
}

/**
 * Serviço responsável por operações de StatefulSets Kubernetes.
 */
export class StatefulSetService {
    private readonly client: KubernetesClient;

    constructor() {
        this.client = KubernetesClient.getInstance();
    }

    /**
     * Lista todos os StatefulSets de um namespace.
     */
    public async listar(namespace: string): Promise<StatefulSetInfo[]> {
        try {
            const api = this.client.getAppsApi();
            const resposta = await api.listNamespacedStatefulSet({ namespace });
            const itens = resposta.items ?? [];
            return itens.map(ss => this.mapearStatefulSetInfo(ss));
        } catch (err) {
            throw new Error(`Erro ao listar StatefulSets: ${interpretarErroKubernetes(err)}`);
        }
    }

    /**
     * Escala um StatefulSet para o número desejado de réplicas.
     */
    public async escalar(namespace: string, nome: string, replicas: number): Promise<void> {
        try {
            const api = this.client.getAppsApi();
            // Usa o subresource /scale — apenas atualiza spec.replicas, não aciona rollout
            await api.replaceNamespacedStatefulSetScale({
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
                `Erro ao escalar StatefulSet "${nome}" para ${replicas} réplica(s): ${interpretarErroKubernetes(err)}`,
            );
        }
    }

    /**
     * Deleta um StatefulSet do cluster.
     */
    public async deletar(namespace: string, nome: string): Promise<void> {
        try {
            const api = this.client.getAppsApi();
            await api.deleteNamespacedStatefulSet({ name: nome, namespace });
        } catch (err) {
            throw new Error(
                `Erro ao deletar StatefulSet "${nome}": ${interpretarErroKubernetes(err)}`,
            );
        }
    }

    /**
     * Mapeia um objeto StatefulSet da API Kubernetes para StatefulSetInfo.
     */
    private mapearStatefulSetInfo(ss: k8s.V1StatefulSet): StatefulSetInfo {
        return {
            nome: ss.metadata?.name ?? 'desconhecido',
            namespace: ss.metadata?.namespace ?? 'default',
            replicasDesejadas: ss.spec?.replicas ?? 0,
            replicasProntas: ss.status?.readyReplicas ?? 0,
            imagens: (ss.spec?.template?.spec?.containers ?? []).map(c => c.image ?? ''),
            criado: ss.metadata?.creationTimestamp
                ? new Date(ss.metadata.creationTimestamp)
                : new Date(),
        };
    }
}
