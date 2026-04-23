import Dockerode from 'dockerode';
import * as os from 'os';

/**
 * Singleton que fornece acesso ao daemon Docker via socket local.
 * Conecta via Unix socket no Linux/macOS ou named pipe no Windows.
 * Acesso ao socket Docker é equivalente a root — use com cautela.
 */
export class DockerClient {
    private static instance: DockerClient | null = null;
    private readonly docker: Dockerode;

    private constructor() {
        if (os.platform() === 'win32') {
            // Named pipe no Windows
            this.docker = new Dockerode({ socketPath: '//./pipe/docker_engine' });
        } else {
            // Unix socket padrão no Linux/macOS
            this.docker = new Dockerode({ socketPath: '/var/run/docker.sock' });
        }
    }

    /**
     * Retorna a instância singleton do cliente Docker.
     */
    public static getInstance(): DockerClient {
        if (!DockerClient.instance) {
            DockerClient.instance = new DockerClient();
        }
        return DockerClient.instance;
    }

    /**
     * Retorna a instância bruta do Dockerode para uso nos serviços.
     */
    public getDockerode(): Dockerode {
        return this.docker;
    }

    /**
     * Verifica se o daemon Docker está acessível e em execução.
     * @throws {DockerConnectionError} quando o Docker não está disponível
     */
    public async verificarConexao(): Promise<void> {
        try {
            await this.docker.ping();
        } catch (err) {
            throw new DockerConnectionError(interpretarErrodocker(err));
        }
    }

    /**
     * Retorna a versão do Docker Engine.
     */
    public async obterVersao(): Promise<Dockerode.DockerVersion> {
        try {
            return await this.docker.version();
        } catch (err) {
            throw new DockerConnectionError(interpretarErrodocker(err));
        }
    }

    /**
     * Retorna informações do sistema (CPU, memória, OS, etc.).
     */
    public async obterInfoSistema(): Promise<Record<string, unknown>> {
        try {
            return await this.docker.info() as Record<string, unknown>;
        } catch (err) {
            throw new DockerConnectionError(interpretarErrodocker(err));
        }
    }
}

/**
 * Erro específico para falhas de conexão com o Docker.
 */
export class DockerConnectionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DockerConnectionError';
    }
}

/**
 * Interpreta erros do daemon Docker e retorna mensagens legíveis em português.
 */
export function interpretarErrodocker(err: unknown): string {
    if (err instanceof Error) {
        const msg = err.message.toLowerCase();

        if (msg.includes('enoent') || msg.includes('no such file')) {
            return 'Socket do Docker não encontrado. Verifique se o Docker está instalado.';
        }
        if (msg.includes('eacces') || msg.includes('permission denied')) {
            return 'Sem permissão para acessar o Docker. Adicione seu usuário ao grupo "docker" ou execute como administrador.';
        }
        if (msg.includes('econnrefused') || msg.includes('connect econnrefused')) {
            return 'Conexão recusada. Verifique se o daemon Docker está em execução.';
        }
        if (msg.includes('etimedout') || msg.includes('timeout')) {
            return 'Tempo de conexão esgotado. O daemon Docker pode estar sobrecarregado.';
        }
        return err.message;
    }
    return 'Erro desconhecido ao conectar ao Docker.';
}
