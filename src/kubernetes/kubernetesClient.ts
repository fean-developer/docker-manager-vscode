import * as k8s from '@kubernetes/client-node';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Informações de um contexto Kubernetes lido do kubeconfig.
 */
export interface ContextoInfo {
    nome: string;
    cluster: string;
    usuario: string;
    ativo: boolean;
}

/**
 * Singleton que fornece acesso ao cluster Kubernetes via kubeconfig local.
 * Conecta exclusivamente via ~/.kube/config (ou KUBECONFIG env var).
 *
 * SEGURANÇA: Nunca logar conteúdo do kubeconfig. Alertar sobre clusters não-locais.
 */
export class KubernetesClient {
    private static instance: KubernetesClient | null = null;
    private kc: k8s.KubeConfig;
    private _namespaceAtivo: string = 'default';
    // Contexto escolhido explicitamente pelo usuário.
    // Reaplicado após cada loadFromDefault() para não ser sobrescrito pelo disco.
    private _contextoOverride: string | null = null;

    private constructor() {
        this.kc = new k8s.KubeConfig();
    }

    /**
     * Retorna a instância singleton do cliente Kubernetes.
     */
    public static getInstance(): KubernetesClient {
        if (!KubernetesClient.instance) {
            KubernetesClient.instance = new KubernetesClient();
        }
        return KubernetesClient.instance;
    }

    /**
     * Verifica se o arquivo kubeconfig existe no local padrão
     * (~/.kube/config ou variável de ambiente KUBECONFIG).
     */
    public verificarKubeconfig(): boolean {
        const kubeConfigEnv = process.env['KUBECONFIG'];
        if (kubeConfigEnv) {
            const arquivos = kubeConfigEnv.split(path.delimiter);
            return arquivos.some(f => {
                try {
                    return fs.existsSync(f);
                } catch {
                    return false;
                }
            });
        }
        const kubeconfigPadrao = path.join(os.homedir(), '.kube', 'config');
        try {
            return fs.existsSync(kubeconfigPadrao);
        } catch {
            return false;
        }
    }

    /**
     * Carrega o kubeconfig padrão do sistema.
     * Deve ser chamado antes de usar qualquer API.
     * @throws {KubernetesConfigError} se kubeconfig não existir ou for inválido
     */
    public carregar(): void {
        try {
            this.kc.loadFromDefault();
            // O Extension Host do VS Code (Electron) não consegue conectar a
            // 0.0.0.0 como servidor HTTPS. Para clusters kind que usam esse endereço:
            // 1. Substitui 0.0.0.0 → 127.0.0.1 em memória (não altera o disco)
            // 2. Habilita skipTLSVerify, pois o cert foi emitido para 0.0.0.0 e não 127.0.0.1
            // Isso é seguro: clusters com 0.0.0.0 são sempre locais (kind/minikube/k3d).
            for (const cluster of this.kc.getClusters()) {
                if (cluster.server?.includes('0.0.0.0')) {
                    // server e skipTLSVerify são readonly no tipo mas writable no objeto em runtime
                    (cluster as unknown as Record<string, unknown>)['server'] =
                        cluster.server.replace('0.0.0.0', '127.0.0.1');
                    (cluster as unknown as Record<string, unknown>)['skipTLSVerify'] = true;
                }
            }
            // Reaplica o contexto escolhido pelo usuário, pois loadFromDefault()
            // sobrescreve o currentContext com o valor gravado no disco.
            if (this._contextoOverride) {
                try {
                    this.kc.setCurrentContext(this._contextoOverride);
                } catch {
                    // Contexto sumiu do kubeconfig — limpa o override
                    this._contextoOverride = null;
                }
            }
        } catch (err) {
            throw new KubernetesConfigError(interpretarErroKubernetes(err));
        }
    }

    /**
     * Lista todos os contextos disponíveis no kubeconfig.
     */
    public listarContextos(): ContextoInfo[] {
        try {
            const contextoAtivo = this.kc.getCurrentContext();
            const contextos = this.kc.getContexts();
            return contextos.map(c => ({
                nome: c.name,
                cluster: c.cluster,
                usuario: c.user,
                ativo: c.name === contextoAtivo,
            }));
        } catch {
            return [];
        }
    }

    /**
     * Retorna o nome do contexto atualmente ativo.
     */
    public getContextoAtivo(): string {
        try {
            return this.kc.getCurrentContext() ?? '';
        } catch {
            return '';
        }
    }

    /**
     * Expõe o KubeConfig para uso interno (ex: Metrics API).
     */
    public getKubeConfig(): k8s.KubeConfig {
        return this.kc;
    }

    /**
     * Define o contexto ativo e reinicializa os clientes de API.
     * @throws {KubernetesConfigError} se o contexto não existir
     */
    public definirContexto(nome: string): void {
        try {
            this._contextoOverride = nome;
            this.kc.setCurrentContext(nome);
        } catch (err) {
            this._contextoOverride = null;
            throw new KubernetesConfigError(`Contexto "${nome}" não encontrado no kubeconfig.`);
        }
    }

    /**
     * Define o namespace ativo para filtrar recursos.
     * Persiste durante a sessão ativa.
     */
    public definirNamespace(namespace: string): void {
        this._namespaceAtivo = namespace;
    }

    /**
     * Retorna o namespace atualmente selecionado.
     */
    public getNamespaceAtivo(): string {
        return this._namespaceAtivo;
    }

    /**
     * Verifica se o cluster Kubernetes está acessível via endpoint de versão
     * (não requer permissões RBAC específicas).
     * Usa timeout de 5s para evitar bloqueio do processo.
     * @throws {KubernetesConnectionError} se cluster não acessível
     */
    public async verificarConexao(): Promise<void> {
        try {
            // /version é um endpoint de descoberta sem require RBAC
            const versionApi = this.kc.makeApiClient(k8s.VersionApi);
            await Promise.race([
                versionApi.getCode(),
                new Promise<never>((_, reject) =>
                    setTimeout(
                        () => reject(new Error('Timeout ao conectar ao cluster Kubernetes (5s)')),
                        5000,
                    ),
                ),
            ]);
        } catch (err) {
            throw new KubernetesConnectionError(interpretarErroKubernetes(err));
        }
    }

    /**
     * Verifica se o endpoint do cluster ativo aponta para um host local.
     * SEGURANÇA: Alertar usuário se for cluster remoto.
     */
    public eClusterLocal(): boolean {
        try {
            const contextoAtivo = this.kc.getCurrentContext();
            if (!contextoAtivo) { return false; }

            const contexto = this.kc.getContexts().find(c => c.name === contextoAtivo);
            if (!contexto) { return false; }

            const cluster = this.kc.getClusters().find(c => c.name === contexto.cluster);
            if (!cluster?.server) { return false; }

            const server = cluster.server.toLowerCase();
            return (
                server.includes('localhost') ||
                server.includes('127.0.0.1') ||
                server.includes('0.0.0.0') ||
                server.includes('host.docker.internal') ||
                // Portas altas típicas de clusters locais (minikube, kind, k3d)
                /https?:\/\/([\w.-]+):\d{4,5}/.test(server) && (
                    server.includes('192.168.') ||
                    server.includes('172.') ||
                    server.includes('10.')
                )
            );
        } catch {
            return false;
        }
    }

    /**
     * Retorna o nome do servidor do contexto ativo (para exibição no alerta de cluster remoto).
     */
    public getServidorAtivo(): string {
        try {
            const contextoAtivo = this.kc.getCurrentContext();
            const contexto = this.kc.getContexts().find(c => c.name === contextoAtivo);
            const cluster = this.kc.getClusters().find(c => c.name === contexto?.cluster);
            const server = cluster?.server ?? 'desconhecido';
            // Normaliza 0.0.0.0 → 127.0.0.1 para exibição
            return server.replace('0.0.0.0', '127.0.0.1');
        } catch {
            return 'desconhecido';
        }
    }

    /**
     * Retorna cliente da Core API (pods, services, namespaces, nodes, configmaps, secrets, pvcs).
     */
    public getCoreApi(): k8s.CoreV1Api {
        return this.kc.makeApiClient(k8s.CoreV1Api);
    }

    /**
     * Retorna cliente da Apps API (deployments, statefulsets, daemonsets).
     */
    public getAppsApi(): k8s.AppsV1Api {
        return this.kc.makeApiClient(k8s.AppsV1Api);
    }

    /**
     * Reinicia o cliente, forçando recarga do kubeconfig na próxima operação.
     * Usado após troca de contexto.
     */
    public reset(): void {
        this.kc = new k8s.KubeConfig();
        this._namespaceAtivo = 'default';
        this._contextoOverride = null;
    }
}

/**
 * Erro específico para falhas de configuração do kubeconfig.
 */
export class KubernetesConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'KubernetesConfigError';
    }
}

/**
 * Erro específico para falhas de conexão com o cluster Kubernetes.
 */
export class KubernetesConnectionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'KubernetesConnectionError';
    }
}

/**
 * Interpreta erros da API Kubernetes e retorna mensagens legíveis em português.
 */
export function interpretarErroKubernetes(err: unknown): string {
    if (err instanceof Error) {
        const msg = err.message.toLowerCase();

        if (msg.includes('timeout')) {
            return 'Timeout ao conectar ao cluster. Verifique se o cluster está em execução.';
        }
        if (msg.includes('econnrefused') || msg.includes('connection refused')) {
            return 'Conexão recusada pelo cluster. Verifique se o cluster está rodando e acessível.';
        }
        if (msg.includes('enotfound') || msg.includes('no such host')) {
            return 'Host do cluster não encontrado. Verifique o endereço no kubeconfig.';
        }
        if (msg.includes('unauthorized') || msg.includes('401')) {
            return 'Sem autorização para acessar o cluster. Verifique as credenciais no kubeconfig.';
        }
        if (msg.includes('forbidden') || msg.includes('403')) {
            return 'Acesso negado pelo cluster (RBAC). Verifique as permissões do usuário/service account.';
        }
        if (msg.includes('certificate') || msg.includes('cert') || msg.includes('tls')) {
            return 'Erro de certificado TLS. Verifique a configuração do cluster no kubeconfig.';
        }
        if (msg.includes('no config') || msg.includes('kubeconfig')) {
            return 'Kubeconfig não encontrado ou inválido. Configure ~/.kube/config com um cluster local.';
        }
        return err.message;
    }
    return 'Erro desconhecido ao comunicar com o cluster Kubernetes.';
}
