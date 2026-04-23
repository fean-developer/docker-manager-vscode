import * as vscode from 'vscode';
import { DockerTreeItem } from './dockerTreeItem';
import { ContainerService } from '../services/containerService';
import { ImageService } from '../services/imageService';
import { VolumeService } from '../services/volumeService';
import { NetworkService } from '../services/networkService';
import { DockerClient, DockerConnectionError } from '../docker/dockerClient';

/**
 * Provider da árvore Docker.
 * Implementa grupos: Containers, Imagens, Volumes, Redes.
 * Suporta refresh manual e automático via polling.
 */
export class DockerTreeProvider implements vscode.TreeDataProvider<DockerTreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<DockerTreeItem | undefined | void>();
    public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private readonly containerService: ContainerService;
    private readonly imageService: ImageService;
    private readonly volumeService: VolumeService;
    private readonly networkService: NetworkService;

    // Cache dos dados para montar sub-itens sem re-fetch
    private containers: DockerTreeItem[] = [];
    private imagens: DockerTreeItem[] = [];
    private volumes: DockerTreeItem[] = [];
    private redes: DockerTreeItem[] = [];

    private pollingTimer: NodeJS.Timeout | undefined;
    private readonly POLLING_INTERVALO_MS = 10_000;

    constructor() {
        this.containerService = new ContainerService();
        this.imageService = new ImageService();
        this.volumeService = new VolumeService();
        this.networkService = new NetworkService();
    }

    /**
     * Dispara um refresh da árvore (re-carrega dados do Docker).
     */
    public refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    /**
     * Inicia o polling automático.
     */
    public iniciarPolling(): void {
        this.pollingTimer = setInterval(() => {
            this.refresh();
        }, this.POLLING_INTERVALO_MS);
    }

    /**
     * Para o polling automático (deve ser chamado no deactivate).
     */
    public pararPolling(): void {
        if (this.pollingTimer) {
            clearInterval(this.pollingTimer);
            this.pollingTimer = undefined;
        }
    }

    public getTreeItem(element: DockerTreeItem): vscode.TreeItem {
        return element;
    }

    public async getChildren(element?: DockerTreeItem): Promise<DockerTreeItem[]> {
        // Raiz: verifica conexão e retorna grupos
        if (!element) {
            return this.carregarGrupos();
        }

        // Sub-itens dos grupos
        switch (element.nodeType) {
            case 'group-containers': return this.containers;
            case 'group-images':     return this.imagens;
            case 'group-volumes':    return this.volumes;
            case 'group-networks':   return this.redes;
            default:                 return [];
        }
    }

    /**
     * Carrega todos os grupos em paralelo e retorna os nós raiz.
     */
    private async carregarGrupos(): Promise<DockerTreeItem[]> {
        try {
            await DockerClient.getInstance().verificarConexao();
        } catch (err) {
            const msg = err instanceof DockerConnectionError ? err.message : String(err);
            vscode.window.showErrorMessage(`Docker Manager: ${msg}`);
            return [];
        }

        await Promise.all([
            this.carregarContainers(),
            this.carregarImagens(),
            this.carregarVolumes(),
            this.carregarRedes(),
        ]);

        return [
            new DockerTreeItem({
                label: `Containers (${this.containers.length})`,
                nodeType: 'group-containers',
                resourceId: 'group-containers',
                collapsible: vscode.TreeItemCollapsibleState.Expanded,
            }),
            new DockerTreeItem({
                label: `Imagens (${this.imagens.length})`,
                nodeType: 'group-images',
                resourceId: 'group-images',
                collapsible: vscode.TreeItemCollapsibleState.Collapsed,
            }),
            new DockerTreeItem({
                label: `Volumes (${this.volumes.length})`,
                nodeType: 'group-volumes',
                resourceId: 'group-volumes',
                collapsible: vscode.TreeItemCollapsibleState.Collapsed,
            }),
            new DockerTreeItem({
                label: `Redes (${this.redes.length})`,
                nodeType: 'group-networks',
                resourceId: 'group-networks',
                collapsible: vscode.TreeItemCollapsibleState.Collapsed,
            }),
        ];
    }

    private async carregarContainers(): Promise<void> {
        try {
            const lista = await this.containerService.listar();
            this.containers = lista.map(c => {
                const tipoEstado = resolverEstadoContainer(c.estado);
                return new DockerTreeItem({
                    label: c.nome,
                    nodeType: tipoEstado,
                    resourceId: c.id,
                    description: `${c.imagem} · ${c.status}`,
                    tooltip: `ID: ${c.id.substring(0, 12)}\nImagem: ${c.imagem}\nStatus: ${c.status}`,
                    containerData: c,
                });
            });
        } catch (err) {
            vscode.window.showErrorMessage(`Docker Manager (containers): ${err instanceof Error ? err.message : String(err)}`);
            this.containers = [];
        }
    }

    private async carregarImagens(): Promise<void> {
        try {
            const lista = await this.imageService.listar();
            this.imagens = lista.map(img => {
                const label = img.tags.length > 0 ? img.tags[0] : img.idCurto;
                return new DockerTreeItem({
                    label,
                    nodeType: 'image',
                    resourceId: img.id,
                    description: img.tamanhoFormatado,
                    tooltip: `ID: ${img.idCurto}\nTamanho: ${img.tamanhoFormatado}`,
                    imageData: img,
                });
            });
        } catch (err) {
            vscode.window.showErrorMessage(`Docker Manager (imagens): ${err instanceof Error ? err.message : String(err)}`);
            this.imagens = [];
        }
    }

    private async carregarVolumes(): Promise<void> {
        try {
            const lista = await this.volumeService.listar();
            this.volumes = lista.map(v => new DockerTreeItem({
                label: v.nome,
                nodeType: 'volume',
                resourceId: v.nome,
                description: v.driver,
                tooltip: `Driver: ${v.driver}\nMountpoint: ${v.mountpoint}`,
                volumeData: v,
            }));
        } catch (err) {
            vscode.window.showErrorMessage(`Docker Manager (volumes): ${err instanceof Error ? err.message : String(err)}`);
            this.volumes = [];
        }
    }

    private async carregarRedes(): Promise<void> {
        try {
            const lista = await this.networkService.listar();
            this.redes = lista.map(r => new DockerTreeItem({
                label: r.nome,
                nodeType: 'network',
                resourceId: r.id,
                description: `${r.driver} · ${r.escopo}`,
                tooltip: `ID: ${r.idCurto}\nDriver: ${r.driver}\nSubnet: ${r.ipam.subnet ?? '-'}`,
                networkData: r,
            }));
        } catch (err) {
            vscode.window.showErrorMessage(`Docker Manager (redes): ${err instanceof Error ? err.message : String(err)}`);
            this.redes = [];
        }
    }
}

/**
 * Mapeia o estado do container para o tipo de nó da árvore.
 */
function resolverEstadoContainer(estado: string): 'container-running' | 'container-stopped' | 'container-paused' | 'container-other' {
    switch (estado) {
        case 'running':    return 'container-running';
        case 'exited':     return 'container-stopped';
        case 'dead':       return 'container-stopped';
        case 'paused':     return 'container-paused';
        default:           return 'container-other';
    }
}
