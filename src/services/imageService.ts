import Dockerode from 'dockerode';
import { DockerClient, interpretarErrodocker } from '../docker/dockerClient';

/**
 * Representação tipada de uma imagem Docker com campos relevantes para a UI.
 */
export interface ImageInfo {
    id: string;
    idCurto: string;
    tags: string[];
    tamanho: number;
    tamanhoFormatado: string;
    criada: Date;
    emUso: boolean;
}

/**
 * Serviço responsável por todas as operações de imagens Docker.
 */
export class ImageService {
    private readonly docker: Dockerode;

    constructor() {
        this.docker = DockerClient.getInstance().getDockerode();
    }

    /**
     * Lista todas as imagens locais.
     */
    public async listar(): Promise<ImageInfo[]> {
        try {
            const imagens = await this.docker.listImages({ all: false });
            const containersEmUso = await this.obterImagensEmUso();

            return imagens.map(img => this.mapearImageInfo(img, containersEmUso));
        } catch (err) {
            throw new Error(interpretarErrodocker(err));
        }
    }

    /**
     * Remove uma imagem local.
     * @param force Se true, força a remoção mesmo se estiver em uso
     */
    public async remover(id: string, force = false): Promise<void> {
        try {
            const imagem = this.docker.getImage(id);
            await imagem.remove({ force });
        } catch (err) {
            throw new Error(`Erro ao remover imagem: ${interpretarErrodocker(err)}`);
        }
    }

    /**
     * Remove todas as imagens não utilizadas (dangling images).
     * @returns Espaço liberado em bytes
     */
    public async limpar(): Promise<number> {
        try {
            const resultado = await this.docker.pruneImages({ filters: { dangling: { true: true } } });
            return resultado.SpaceReclaimed ?? 0;
        } catch (err) {
            throw new Error(`Erro ao limpar imagens: ${interpretarErrodocker(err)}`);
        }
    }

    /**
     * Inspeciona uma imagem e retorna dados detalhados.
     */
    public async inspecionar(id: string): Promise<Dockerode.ImageInspectInfo> {
        try {
            const imagem = this.docker.getImage(id);
            return await imagem.inspect();
        } catch (err) {
            throw new Error(`Erro ao inspecionar imagem: ${interpretarErrodocker(err)}`);
        }
    }

    /**
     * Coleta os IDs de imagens que estão sendo usadas por algum container.
     */
    private async obterImagensEmUso(): Promise<Set<string>> {
        try {
            const containers = await this.docker.listContainers({ all: true });
            return new Set(containers.map(c => c.ImageID));
        } catch {
            return new Set();
        }
    }

    private mapearImageInfo(img: Dockerode.ImageInfo, emUso: Set<string>): ImageInfo {
        const tags = img.RepoTags?.filter(t => t !== '<none>:<none>') ?? [];
        const idCurto = img.Id.replace('sha256:', '').substring(0, 12);

        return {
            id: img.Id,
            idCurto,
            tags,
            tamanho: img.Size,
            tamanhoFormatado: formatarBytes(img.Size),
            criada: new Date(img.Created * 1000),
            emUso: emUso.has(img.Id),
        };
    }
}

/**
 * Formata um tamanho em bytes para formato legível (KB, MB, GB).
 */
export function formatarBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
