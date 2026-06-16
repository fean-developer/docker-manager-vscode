import Dockerode from 'dockerode';
import { execSync } from 'child_process';
import { DockerClient, interpretarErrodocker } from '../docker/dockerClient';

export interface DiskStats {
    total: number;
    usado: number;
    disponivel: number;
}

/**
 * Referência a um container que utiliza um volume.
 */
export interface ContainerRef {
    id: string;
    nome: string;   // nome amigável sem a barra inicial
    estado: string; // running, exited, etc.
}

/**
 * Representação tipada de um volume Docker.
 */
export interface VolumeInfo {
    nome: string;
    driver: string;
    mountpoint: string;
    criado: string | null;  // ISO string ou null quando indisponível
    escopo: string;
    emUso: boolean;
    tamanho: number;       // bytes usados pelo volume (-1 = não calculado)
    refCount: number;      // containers referenciando
    diskStats: DiskStats | null; // estatísticas do filesystem do mountpoint
    labels: Record<string, string>;
    options: Record<string, string>;
    containers: ContainerRef[]; // containers que montam este volume
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
     * Lista todos os volumes locais com dados completos.
     * listVolumes() já retorna CreatedAt, Scope, Labels — inspect() desnecessário.
     */
    public async listar(): Promise<VolumeInfo[]> {
        try {
            const resultado = await this.docker.listVolumes();
            const volumes = resultado.Volumes ?? [];

            // UsageData (Size + RefCount) via docker system df
            const usageMap = await this.obterUsageMap();

            // refCount real, emUso e containers via mounts dos containers
            const { containerMap, refCountMap } = await this.obterContainerMap();
            const nomesEmUso = new Set<string>(
                [...refCountMap.keys()].filter(k => (refCountMap.get(k) ?? 0) > 0)
            );

            return volumes.map(v => this.mapearVolumeInfo(
                v as Dockerode.VolumeInspectInfo & { CreatedAt?: string },
                nomesEmUso,
                refCountMap,
                usageMap,
                containerMap,
            ));
        } catch (err) {
            throw new Error(interpretarErrodocker(err));
        }
    }

    /**
     * Obtém mapa de UsageData por nome de volume via docker system df.
     */
    private async obterUsageMap(): Promise<Map<string, { tamanho: number; refCount: number }>> {
        const map = new Map<string, { tamanho: number; refCount: number }>();
        try {
            const df = await this.docker.df() as {
                Volumes?: Array<{ Name: string; UsageData?: { Size: number; RefCount: number } | null }>;
            };
            for (const v of df.Volumes ?? []) {
                if (v.UsageData) {
                    map.set(v.Name, { tamanho: v.UsageData.Size, refCount: v.UsageData.RefCount });
                }
            }
        } catch { /* silencioso */ }
        return map;
    }

    /**
     * Obtém estatísticas de disco do filesystem onde o mountpoint reside.
     * Usa `df` do sistema operacional. Retorna null se não disponível.
     */
    private obterDiskStats(mountpoint: string): DiskStats | null {
        try {
            const safePath = mountpoint.replace(/"/g, '\\"');
            const saida = execSync(`df -B1 "${safePath}" 2>/dev/null`, { timeout: 3000 }).toString();
            const linhas = saida.trim().split('\n');
            if (linhas.length < 2) { return null; }
            const partes = linhas[1].trim().split(/\s+/);
            const total = parseInt(partes[1], 10);
            const usado = parseInt(partes[2], 10);
            const disponivel = parseInt(partes[3], 10);
            if (isNaN(total) || isNaN(usado) || isNaN(disponivel)) { return null; }
            return { total, usado, disponivel };
        } catch {
            return null;
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
     * Retorna um mapa volume → lista de ContainerRef + mapa volume → contagem.
     * Uma única chamada a listContainers para ambos os propósitos.
     */
    private async obterContainerMap(): Promise<{
        containerMap: Map<string, ContainerRef[]>;
        refCountMap: Map<string, number>;
    }> {
        const containerMap = new Map<string, ContainerRef[]>();
        const refCountMap = new Map<string, number>();
        try {
            const containers = await this.docker.listContainers({ all: true });
            for (const c of containers) {
                const nome = (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, '');
                const ref: ContainerRef = { id: c.Id, nome, estado: c.State ?? 'unknown' };
                for (const m of c.Mounts ?? []) {
                    if (m.Name) {
                        const lista = containerMap.get(m.Name) ?? [];
                        lista.push(ref);
                        containerMap.set(m.Name, lista);
                        refCountMap.set(m.Name, (refCountMap.get(m.Name) ?? 0) + 1);
                    }
                }
            }
        } catch { /* silencioso */ }
        return { containerMap, refCountMap };
    }

    private mapearVolumeInfo(
        v: Dockerode.VolumeInspectInfo & { CreatedAt?: string },
        emUso: Set<string>,
        refCountMap: Map<string, number>,
        usageMap: Map<string, { tamanho: number; refCount: number }>,
        containerMap: Map<string, ContainerRef[]>,
    ): VolumeInfo {
        const usage = usageMap.get(v.Name);
        // Prefere refCount do usageMap (df) pois já conta containers; fallback para mapa de mounts
        const refCount = (usage?.refCount != null && usage.refCount >= 0)
            ? usage.refCount
            : (refCountMap.get(v.Name) ?? 0);
        return {
            nome: v.Name,
            driver: v.Driver || 'local',
            mountpoint: v.Mountpoint,
            criado: v.CreatedAt ?? null,
            escopo: v.Scope || 'local',
            emUso: emUso.has(v.Name),
            tamanho: (usage?.tamanho != null && usage.tamanho >= 0) ? usage.tamanho : -1,
            refCount,
            diskStats: this.obterDiskStats(v.Mountpoint),
            labels: (v.Labels as Record<string, string>) ?? {},
            options: (v.Options as Record<string, string>) ?? {},
            containers: containerMap.get(v.Name) ?? [],
        };
    }
}
