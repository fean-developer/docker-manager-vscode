import * as vscode from 'vscode';
import { ContainerInfo } from '../services/containerService';
import { ImageInfo } from '../services/imageService';
import { VolumeInfo } from '../services/volumeService';
import { NetworkInfo } from '../services/networkService';

/**
 * Tipos de nós possíveis na árvore Docker.
 */
export type DockerNodeType =
    | 'group-containers'
    | 'group-images'
    | 'group-volumes'
    | 'group-networks'
    | 'container-running'
    | 'container-stopped'
    | 'container-paused'
    | 'container-other'
    | 'image'
    | 'volume'
    | 'network';

/**
 * Nó da árvore Docker (grupo ou item individual).
 */
export class DockerTreeItem extends vscode.TreeItem {
    public readonly nodeType: DockerNodeType;
    public readonly resourceId: string;

    // Dados carregados dependendo do tipo
    public readonly containerData?: ContainerInfo;
    public readonly imageData?: ImageInfo;
    public readonly volumeData?: VolumeInfo;
    public readonly networkData?: NetworkInfo;

    constructor(opts: DockerTreeItemOptions) {
        super(opts.label, opts.collapsible ?? vscode.TreeItemCollapsibleState.None);

        this.nodeType = opts.nodeType;
        this.resourceId = opts.resourceId;
        this.description = opts.description;
        this.tooltip = opts.tooltip;
        this.contextValue = opts.nodeType;
        this.iconPath = resolverIcone(opts.nodeType);

        this.containerData = opts.containerData;
        this.imageData = opts.imageData;
        this.volumeData = opts.volumeData;
        this.networkData = opts.networkData;

        // Abre o webview de detalhes ao clicar num container
        if (opts.nodeType.startsWith('container-')) {
            this.command = {
                command: 'dockerManager.inspectContainer',
                title: 'Inspecionar Container',
                arguments: [this],
            };
        }
    }
}

export interface DockerTreeItemOptions {
    label: string;
    nodeType: DockerNodeType;
    resourceId: string;
    collapsible?: vscode.TreeItemCollapsibleState;
    description?: string;
    tooltip?: string;
    containerData?: ContainerInfo;
    imageData?: ImageInfo;
    volumeData?: VolumeInfo;
    networkData?: NetworkInfo;
}

/**
 * Resolve o ícone ThemeIcon de acordo com o tipo do nó.
 */
function resolverIcone(tipo: DockerNodeType): vscode.ThemeIcon {
    switch (tipo) {
        case 'group-containers': return new vscode.ThemeIcon('layers');
        case 'group-images':     return new vscode.ThemeIcon('package');
        case 'group-volumes':    return new vscode.ThemeIcon('database');
        case 'group-networks':   return new vscode.ThemeIcon('radio-tower');
        case 'container-running':
            return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'));
        case 'container-stopped':
        case 'container-other':
            return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconFailed'));
        case 'container-paused':
            return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconQueued'));
        case 'image':   return new vscode.ThemeIcon('file-binary');
        case 'volume':  return new vscode.ThemeIcon('archive');
        case 'network': return new vscode.ThemeIcon('globe');
    }
}
