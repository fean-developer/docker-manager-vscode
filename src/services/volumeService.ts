import Dockerode from 'dockerode';
import { DockerClient, interpretarErrodocker } from '../docker/dockerClient';

/**
 * Representação tipada de um volume Docker.
 */
export interface VolumeInfo {
    nome: string;
    driver: string;
    mountpoint: string;
    criado: Date;
    escopo: string;
    emUso: boolean;
}

/**
 * Serviço responsável por todas as operações de volumes Docker.
 */
export class VolumeService {
    private readonly docker: Dockerode;

    constructor() {
        this.docker = DockerClient.getInstance().getDockerode();
    }

    /**
     * Lista todos os volumes locais.
     */
    public async listar(): Promise<VolumeInfo[]> {
        try {
            const resultado = await this.docker.listVolumes();
            const volumes = resultado.Volumes ?? [];
            const nomesEmUso = await this.obterVolumesEmUso();

            return volumes.map(v => this.mapearVolumeInfo(v, nomesEmUso));
        } catch (err) {
            throw new Error(interpretarErrodocker(err));
        }
    }

    /**
     * Remove um volume pelo nome.
     * @param force Se true, força remoção mesmo se estiver em uso
     */
    public async remover(nome: string, force = false): Promise<void> {
        try {
            const volume = this.docker.getVolume(nome);
            await volume.remove({ force });
        } catch (err) {
            throw new Error(`Erro ao remover volume: ${interpretarErrodocker(err)}`);
        }
    }

    /**
     * Remove todos os volumes não utilizados.
     * @returns Espaço liberado em bytes
     */
    public async limpar(): Promise<number> {
        try {
            const resultado = await this.docker.pruneVolumes();
            return resultado.SpaceReclaimed ?? 0;
        } catch (err) {
            throw new Error(`Erro ao limpar volumes: ${interpretarErrodocker(err)}`);
        }
    }

    /**
     * Inspeciona um volume e retorna dados detalhados.
     */
    public async inspecionar(nome: string): Promise<Dockerode.VolumeInspectInfo> {
        try {
            const volume = this.docker.getVolume(nome);
            return await volume.inspect();
        } catch (err) {
            throw new Error(`Erro ao inspecionar volume: ${interpretarErrodocker(err)}`);
        }
    }

    /**
     * Coleta os nomes dos volumes em uso por algum container.
     */
    private async obterVolumesEmUso(): Promise<Set<string>> {
        try {
            const containers = await this.docker.listContainers({ all: true });
            const nomes = new Set<string>();
            for (const c of containers) {
                for (const m of c.Mounts ?? []) {
                    if (m.Name) nomes.add(m.Name);
                }
            }
            return nomes;
        } catch {
            return new Set();
        }
    }

    private mapearVolumeInfo(v: Dockerode.VolumeInspectInfo, emUso: Set<string>): VolumeInfo {
        // CreatedAt pode estar ausente dependendo da versão do Docker Engine
        const criado = (v as Dockerode.VolumeInspectInfo & { CreatedAt?: string }).CreatedAt;
        return {
            nome: v.Name,
            driver: v.Driver,
            mountpoint: v.Mountpoint,
            criado: criado ? new Date(criado) : new Date(0),
            escopo: v.Scope,
            emUso: emUso.has(v.Name),
        };
    }
}
