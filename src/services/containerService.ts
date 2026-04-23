import Dockerode from 'dockerode';
import { DockerClient, interpretarErrodocker } from '../docker/dockerClient';

/**
 * Representação tipada de um container Docker com campos relevantes para a UI.
 */
export interface ContainerInfo {
    id: string;
    nome: string;
    imagem: string;
    status: string;
    estado: 'running' | 'exited' | 'paused' | 'restarting' | 'created' | 'dead' | 'removing';
    portas: PortaInfo[];
    criado: Date;
}

export interface PortaInfo {
    ip?: string;
    portaPrivada: number;
    portaPublica?: number;
    protocolo: string;
}

/**
 * Serviço responsável por todas as operações de containers Docker.
 * Usa o DockerClient singleton para comunicação com o daemon.
 */
export class ContainerService {
    private readonly docker: Dockerode;

    constructor() {
        this.docker = DockerClient.getInstance().getDockerode();
    }

    /**
     * Lista todos os containers (em execução e parados).
     */
    public async listar(): Promise<ContainerInfo[]> {
        try {
            const containers = await this.docker.listContainers({ all: true });
            return containers.map(c => this.mapearContainerInfo(c));
        } catch (err) {
            throw new Error(interpretarErrodocker(err));
        }
    }

    /**
     * Inicia um container parado.
     */
    public async iniciar(id: string): Promise<void> {
        try {
            const container = this.docker.getContainer(id);
            await container.start();
        } catch (err) {
            throw new Error(`Erro ao iniciar container: ${interpretarErrodocker(err)}`);
        }
    }

    /**
     * Para um container em execução.
     */
    public async parar(id: string): Promise<void> {
        try {
            const container = this.docker.getContainer(id);
            await container.stop();
        } catch (err) {
            throw new Error(`Erro ao parar container: ${interpretarErrodocker(err)}`);
        }
    }

    /**
     * Reinicia um container.
     */
    public async reiniciar(id: string): Promise<void> {
        try {
            const container = this.docker.getContainer(id);
            await container.restart();
        } catch (err) {
            throw new Error(`Erro ao reiniciar container: ${interpretarErrodocker(err)}`);
        }
    }

    /**
     * Remove um container (deve estar parado, ou forçar remoção).
     * @param force Se true, força a remoção mesmo que esteja em execução
     */
    public async remover(id: string, force = false): Promise<void> {
        try {
            const container = this.docker.getContainer(id);
            await container.remove({ force });
        } catch (err) {
            throw new Error(`Erro ao remover container: ${interpretarErrodocker(err)}`);
        }
    }

    /**
     * Mata um container enviando SIGKILL imediato.
     */
    public async matar(id: string): Promise<void> {
        try {
            const container = this.docker.getContainer(id);
            await container.kill();
        } catch (err) {
            throw new Error(`Erro ao matar container: ${interpretarErrodocker(err)}`);
        }
    }

    /**
     * Pausa a execução de um container.
     */
    public async pausar(id: string): Promise<void> {
        try {
            const container = this.docker.getContainer(id);
            await container.pause();
        } catch (err) {
            throw new Error(`Erro ao pausar container: ${interpretarErrodocker(err)}`);
        }
    }

    /**
     * Retoma a execução de um container pausado.
     */
    public async retomar(id: string): Promise<void> {
        try {
            const container = this.docker.getContainer(id);
            await container.unpause();
        } catch (err) {
            throw new Error(`Erro ao retomar container: ${interpretarErrodocker(err)}`);
        }
    }

    /**
     * Obtém os logs de um container.
     *
     * No dockerode v4, container.logs({ follow: false }) retorna um Buffer diretamente
     * quando resolvido via Promise — não é um ReadableStream.
     */
    public async obterLogs(id: string, linhas = 500): Promise<string> {
        try {
            const container = this.docker.getContainer(id);
            const resultado = await container.logs({
                stdout: true,
                stderr: true,
                tail: linhas,
                timestamps: true,
                follow: false,
            });
            const buffer = resultado as unknown as Buffer;
            return this.desmultiplexarLogs(buffer);
        } catch (err) {
            throw new Error(`Erro ao obter logs: ${interpretarErrodocker(err)}`);
        }
    }

    /**
     * Inspeciona um container e retorna dados detalhados.
     */
    public async inspecionar(id: string): Promise<Dockerode.ContainerInspectInfo> {
        try {
            const container = this.docker.getContainer(id);
            return await container.inspect();
        } catch (err) {
            throw new Error(`Erro ao inspecionar container: ${interpretarErrodocker(err)}`);
        }
    }

    /**
     * Obtém estatísticas de um container (snapshot único).
     *
     * No dockerode v4, container.stats({ stream: false }) retorna o objeto de stats
     * diretamente quando resolvido via Promise — não é um ReadableStream.
     */
    public async obterStats(id: string): Promise<Dockerode.ContainerStats> {
        try {
            const container = this.docker.getContainer(id);
            return await container.stats({ stream: false }) as unknown as Dockerode.ContainerStats;
        } catch (err) {
            throw new Error(`Erro ao obter stats do container: ${interpretarErrodocker(err)}`);
        }
    }

    /**
     * Interpreta o buffer de logs do Docker.
     *
     * Containers sem TTY usam o formato multiplexado:
     *   [tipo(1 byte), 0x00(3 bytes), tamanho(4 bytes big-endian), dados...]
     * Containers com TTY habilitado enviam o texto puro sem cabeçalho.
     */
    private desmultiplexarLogs(buffer: Buffer): string {
        if (buffer.length === 0) return '(sem logs disponíveis)';

        // Detecta o formato: o primeiro byte de um frame multiplexado é 0, 1 ou 2
        const primeiroByte = buffer[0];
        const ehMultiplexado = (primeiroByte === 0 || primeiroByte === 1 || primeiroByte === 2)
            && buffer.length >= 8;

        if (!ehMultiplexado) {
            // Container com TTY=true — stream não multiplexado, texto puro
            return buffer.toString('utf-8');
        }

        const linhas: string[] = [];
        let offset = 0;

        while (offset < buffer.length) {
            if (offset + 8 > buffer.length) break;
            const tamanho = buffer.readUInt32BE(offset + 4);
            offset += 8;
            if (tamanho === 0) continue;
            if (offset + tamanho > buffer.length) break;
            const linha = buffer.slice(offset, offset + tamanho).toString('utf-8');
            linhas.push(linha);
            offset += tamanho;
        }

        // Se a demultiplexação não produziu nada, retorna o texto bruto como fallback
        return linhas.length > 0 ? linhas.join('') : buffer.toString('utf-8');
    }

    private mapearContainerInfo(c: Dockerode.ContainerInfo): ContainerInfo {
        const nome = c.Names?.[0]?.replace(/^\//, '') ?? c.Id.substring(0, 12);
        const estado = (c.State ?? 'created') as ContainerInfo['estado'];

        const portas: PortaInfo[] = (c.Ports ?? []).map(p => ({
            ip: p.IP,
            portaPrivada: p.PrivatePort,
            portaPublica: p.PublicPort,
            protocolo: p.Type,
        }));

        return {
            id: c.Id,
            nome,
            imagem: c.Image,
            status: c.Status,
            estado,
            portas,
            criado: new Date(c.Created * 1000),
        };
    }
}
