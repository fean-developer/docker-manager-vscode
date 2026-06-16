import * as k8s from '@kubernetes/client-node';
import { KubernetesClient, interpretarErroKubernetes } from '../kubernetes/kubernetesClient';

/**
 * Informações de uma porta de Service Kubernetes.
 */
export interface PortaServiceInfo {
    nome?: string;
    porta: number;
    targetPort: string | number;
    protocolo: string;
    nodePort?: number;
}

/**
 * Representação tipada de um Service Kubernetes.
 */
export interface ServiceK8sInfo {
    nome: string;
    namespace: string;
    tipo: 'ClusterIP' | 'NodePort' | 'LoadBalancer' | 'ExternalName' | string;
    clusterIP: string;
    portas: PortaServiceInfo[];
    criado: Date;
    selector: Record<string, string>;
}

/**
 * Serviço responsável por operações de Services Kubernetes.
 * Nota: "Service" aqui é o recurso Kubernetes, não um serviço da extensão.
 */
export class KubernetesServiceService {
    private readonly client: KubernetesClient;

    constructor() {
        this.client = KubernetesClient.getInstance();
    }

    /**
     * Lista todos os Services de um namespace.
     */
    public async listar(namespace: string): Promise<ServiceK8sInfo[]> {
        try {
            const api = this.client.getCoreApi();
            const resposta = await api.listNamespacedService({ namespace });
            const itens = resposta.items ?? [];
            return itens.map(svc => this.mapearServiceInfo(svc));
        } catch (err) {
            throw new Error(`Erro ao listar services: ${interpretarErroKubernetes(err)}`);
        }
    }

    /**
     * Inspeciona um Service específico com detalhes completos.
     */
    public async inspecionar(namespace: string, nome: string): Promise<ServiceK8sInfo> {
        try {
            const api = this.client.getCoreApi();
            const resposta = await api.readNamespacedService({ name: nome, namespace });
            return this.mapearServiceInfo(resposta);
        } catch (err) {
            throw new Error(
                `Erro ao inspecionar service "${nome}": ${interpretarErroKubernetes(err)}`,
            );
        }
    }

    /**
     * Mapeia um objeto Service da API Kubernetes para ServiceK8sInfo.
     */
    private mapearServiceInfo(svc: k8s.V1Service): ServiceK8sInfo {
        const portas = (svc.spec?.ports ?? []).map(p => ({
            nome: p.name,
            porta: p.port,
            targetPort:
                typeof p.targetPort === 'object'
                    ? String((p.targetPort as { value?: string | number })?.value ?? p.targetPort)
                    : p.targetPort ?? p.port,
            protocolo: p.protocol ?? 'TCP',
            nodePort: p.nodePort,
        }));

        return {
            nome: svc.metadata?.name ?? 'desconhecido',
            namespace: svc.metadata?.namespace ?? 'default',
            tipo: (svc.spec?.type ?? 'ClusterIP') as ServiceK8sInfo['tipo'],
            clusterIP: svc.spec?.clusterIP ?? '',
            portas,
            criado: svc.metadata?.creationTimestamp
                ? new Date(svc.metadata.creationTimestamp)
                : new Date(),
            selector: svc.spec?.selector ?? {},
        };
    }
}
