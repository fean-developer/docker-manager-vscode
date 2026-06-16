import * as k8s from '@kubernetes/client-node';
import { KubernetesClient, interpretarErroKubernetes } from '../kubernetes/kubernetesClient';

/**
 * Representação tipada de um PersistentVolumeClaim Kubernetes.
 */
export interface PVCInfo {
    nome: string;
    namespace: string;
    status: 'Bound' | 'Pending' | 'Lost' | string;
    capacidade: string;
    storageClass: string;
    accessModes: string[];
    volumeName: string;
    volumeMode: string;
    criado: Date;
}

/**
 * Serviço responsável por operações de PersistentVolumeClaims Kubernetes.
 */
export class PVCService {
    private readonly client: KubernetesClient;

    constructor() {
        this.client = KubernetesClient.getInstance();
    }

    /**
     * Lista todos os PVCs de um namespace.
     */
    public async listar(namespace: string): Promise<PVCInfo[]> {
        try {
            const api = this.client.getCoreApi();
            const resposta = await api.listNamespacedPersistentVolumeClaim({ namespace });
            const itens = resposta.items ?? [];
            return itens.map(pvc => this.mapearPVCInfo(pvc));
        } catch (err) {
            throw new Error(`Erro ao listar PVCs: ${interpretarErroKubernetes(err)}`);
        }
    }

    /**
     * Deleta um PVC do cluster.
     * Ação destrutiva — confirmação deve ser feita no command handler.
     */
    public async deletar(namespace: string, nome: string): Promise<void> {
        try {
            const api = this.client.getCoreApi();
            await api.deleteNamespacedPersistentVolumeClaim({ name: nome, namespace });
        } catch (err) {
            throw new Error(
                `Erro ao deletar PVC "${nome}": ${interpretarErroKubernetes(err)}`,
            );
        }
    }

    /**
     * Mapeia um objeto PVC da API Kubernetes para PVCInfo.
     */
    private mapearPVCInfo(pvc: k8s.V1PersistentVolumeClaim): PVCInfo {
        const capacidadeRaw = pvc.status?.capacity?.['storage'] ?? pvc.spec?.resources?.requests?.['storage'] ?? '';
        return {
            nome: pvc.metadata?.name ?? 'desconhecido',
            namespace: pvc.metadata?.namespace ?? 'default',
            status: (pvc.status?.phase ?? 'Pending') as PVCInfo['status'],
            capacidade: capacidadeRaw,
            storageClass: pvc.spec?.storageClassName ?? '',
            accessModes: pvc.spec?.accessModes ?? [],
            volumeName: pvc.spec?.volumeName ?? '',
            volumeMode: pvc.spec?.volumeMode ?? 'Filesystem',
            criado: pvc.metadata?.creationTimestamp
                ? new Date(pvc.metadata.creationTimestamp)
                : new Date(),
        };
    }
}
