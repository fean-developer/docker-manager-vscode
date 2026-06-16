import { KubernetesClient, interpretarErroKubernetes } from '../kubernetes/kubernetesClient';

/**
 * Representação tipada de um Secret Kubernetes.
 *
 * SEGURANÇA: Os valores dos secrets NUNCA são incluídos — apenas as chaves.
 * Isso previne exposição acidental de tokens, senhas e certificados na UI.
 */
export interface SecretInfo {
    nome: string;
    namespace: string;
    tipo: string;
    numeroCHaves: number;
    criado: Date;
}

/**
 * Serviço responsável por listagem de Secrets Kubernetes.
 *
 * SEGURANÇA: Este serviço retorna APENAS metadados dos secrets.
 * Os valores das chaves nunca são retornados ou logados.
 */
export class SecretService {
    private readonly client: KubernetesClient;

    constructor() {
        this.client = KubernetesClient.getInstance();
    }

    /**
     * Lista todos os Secrets de um namespace.
     * Retorna apenas metadados — sem valores das chaves.
     */
    public async listar(namespace: string): Promise<SecretInfo[]> {
        try {
            const api = this.client.getCoreApi();
            const resposta = await api.listNamespacedSecret({ namespace });
            const itens = resposta.items ?? [];
            return itens.map(secret => ({
                nome: secret.metadata?.name ?? 'desconhecido',
                namespace: secret.metadata?.namespace ?? 'default',
                tipo: secret.type ?? 'Opaque',
                // Conta as chaves sem retornar os valores
                numeroCHaves: Object.keys(secret.data ?? {}).length,
                criado: secret.metadata?.creationTimestamp
                    ? new Date(secret.metadata.creationTimestamp)
                    : new Date(),
            }));
        } catch (err) {
            throw new Error(`Erro ao listar secrets: ${interpretarErroKubernetes(err)}`);
        }
    }
}
