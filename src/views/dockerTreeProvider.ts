import * as vscode from 'vscode';
import { DockerTreeItem } from './dockerTreeItem';
import { ContainerService } from '../services/containerService';
import { ImageService } from '../services/imageService';
import { VolumeService } from '../services/volumeService';
import { NetworkService } from '../services/networkService';
import { DockerClient, DockerConnectionError } from '../docker/dockerClient';

export type DockerViewType = 'containers' | 'images' | 'volumes' | 'networks';

/**
 * Provider da árvore Docker (filtrado por tipo).
 * Cada instância mostra apenas um tipo: containers, imagens, volumes ou redes.
 * Suporta refresh manual e automático via polling.
 */
export class DockerTreeProvider implements vscode.TreeDataProvider<DockerTreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<DockerTreeItem | undefined | void>();
    public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private readonly containerService: ContainerService;
    private readonly imageService: ImageService;
    private readonly volumeService: VolumeService;
    private readonly networkService: NetworkService;

    // Cache dos dados do tipo específico
    private items: DockerTreeItem[] = [];

    private pollingTimer: NodeJS.Timeout | undefined;
    private readonly POLLING_INTERVALO_MS = 10_000;
    private readonly viewType: DockerViewType;

    constructor(viewType: DockerViewType) {
        this.viewType = viewType;
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
        // Sem elemento = carrega os dados do tipo específico
        if (!element) {
            return this.carregarDados();
        }

        // Nós não têm filhos (são folhas)
        return [];
    }

    /**
     * Carrega dados específicos do tipo da view.
     */
    private async carregarDados(): Promise<DockerTreeItem[]> {
        try {
            await DockerClient.getInstance().verificarConexao();
        } catch (err) {
            const msg = err instanceof DockerConnectionError ? err.message : String(err);
            vscode.window.showErrorMessage(`Container Manager: ${msg}`);
            return [];
        }

        switch (this.viewType) {
            case 'containers':
                await this.carregarContainers();
                break;
            case 'images':
                await this.carregarImagens();
                break;
            case 'volumes':
                await this.carregarVolumes();
                break;
            case 'networks':
                await this.carregarRedes();
                break;
        }

        return this.items;
    }

    private async carregarContainers(): Promise<void> {
        try {
            const lista = await this.containerService.listar();
            this.items = lista.map(c => {
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
            vscode.window.showErrorMessage(`Container Manager (containers): ${err instanceof Error ? err.message : String(err)}`);
            this.items = [];
        }
    }

    private async carregarImagens(): Promise<void> {
        try {
            const lista = await this.imageService.listar();
            this.items = lista.map(img => {
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
            vscode.window.showErrorMessage(`Container Manager (imagens): ${err instanceof Error ? err.message : String(err)}`);
            this.items = [];
        }
    }

    private async carregarVolumes(): Promise<void> {
        try {
            const lista = await this.volumeService.listar();
            this.items = lista.map(v => new DockerTreeItem({
                label: v.nome,
                nodeType: 'volume',
                resourceId: v.nome,
                description: v.driver,
                tooltip: `Driver: ${v.driver}\nMountpoint: ${v.mountpoint}`,
                volumeData: v,
            }));
        } catch (err) {
            vscode.window.showErrorMessage(`Container Manager (volumes): ${err instanceof Error ? err.message : String(err)}`);
            this.items = [];
        }
    }

    private async carregarRedes(): Promise<void> {
        try {
            const lista = await this.networkService.listar();
            this.items = lista.map(r => new DockerTreeItem({
                label: r.nome,
                nodeType: 'network',
                resourceId: r.id,
                description: `${r.driver} · ${r.escopo}`,
                tooltip: `ID: ${r.idCurto}\nDriver: ${r.driver}\nSubnet: ${r.ipam.subnet ?? '-'}`,
                networkData: r,
            }));
        } catch (err) {
            vscode.window.showErrorMessage(`Container Manager (redes): ${err instanceof Error ? err.message : String(err)}`);
            this.items = [];
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
