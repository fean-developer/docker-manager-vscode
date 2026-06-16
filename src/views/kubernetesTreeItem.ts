import * as vscode from 'vscode';
import type { PodInfo } from '../services/podService';
import type { DeploymentInfo } from '../services/deploymentService';
import type { StatefulSetInfo } from '../services/statefulSetService';
import type { DaemonSetInfo } from '../services/daemonSetService';
import type { ServiceK8sInfo } from '../services/kubernetesServiceService';
import type { PVCInfo } from '../services/pvcService';
import type { ConfigMapInfo } from '../services/configMapService';
import type { SecretInfo } from '../services/secretService';
import type { NamespaceInfo } from '../services/namespaceService';
import type { NodeInfo } from '../services/nodeService';

/**
 * Tipos de nós possíveis na árvore Kubernetes.
 */
export type KubernetesNodeType =
    | 'k8s-cluster'
    | 'k8s-namespace'
    | 'k8s-node'
    | 'k8s-event'
    | 'k8s-group-pods'
    | 'k8s-group-deployments'
    | 'k8s-group-statefulsets'
    | 'k8s-group-daemonsets'
    | 'k8s-group-services'
    | 'k8s-group-pvcs'
    | 'k8s-group-configmaps'
    | 'k8s-group-secrets'
    | 'k8s-pod-running'
    | 'k8s-pod-pending'
    | 'k8s-pod-failed'
    | 'k8s-pod-other'
    | 'k8s-deployment'
    | 'k8s-statefulset'
    | 'k8s-daemonset'
    | 'k8s-service'
    | 'k8s-pvc'
    | 'k8s-configmap'
    | 'k8s-secret';

export interface KubernetesTreeItemOptions {
    label: string;
    nodeType: KubernetesNodeType;
    resourceId: string;
    description?: string;
    tooltip?: string;
    collapsible?: vscode.TreeItemCollapsibleState;
    // Dados opcionais dependendo do tipo
    podData?: PodInfo;
    deploymentData?: DeploymentInfo;
    statefulSetData?: StatefulSetInfo;
    daemonSetData?: DaemonSetInfo;
    serviceData?: ServiceK8sInfo;
    pvcData?: PVCInfo;
    configMapData?: ConfigMapInfo;
    secretData?: SecretInfo;
    namespaceData?: NamespaceInfo;
    nodeData?: NodeInfo;
}

/**
 * Nó da árvore Kubernetes (grupo ou item individual).
 */
export class KubernetesTreeItem extends vscode.TreeItem {
    public readonly nodeType: KubernetesNodeType;
    public readonly resourceId: string;

    // Dados carregados dependendo do tipo
    public readonly podData?: PodInfo;
    public readonly deploymentData?: DeploymentInfo;
    public readonly statefulSetData?: StatefulSetInfo;
    public readonly daemonSetData?: DaemonSetInfo;
    public readonly serviceData?: ServiceK8sInfo;
    public readonly pvcData?: PVCInfo;
    public readonly configMapData?: ConfigMapInfo;
    public readonly secretData?: SecretInfo;
    public readonly namespaceData?: NamespaceInfo;
    public readonly nodeData?: NodeInfo;

    constructor(opts: KubernetesTreeItemOptions) {
        super(opts.label, opts.collapsible ?? vscode.TreeItemCollapsibleState.None);

        this.nodeType = opts.nodeType;
        this.resourceId = opts.resourceId;
        this.description = opts.description;
        this.tooltip = opts.tooltip;
        this.contextValue = opts.nodeType;
        this.iconPath = resolverIconeK8s(opts.nodeType, opts.podData?.status);

        this.podData = opts.podData;
        this.deploymentData = opts.deploymentData;
        this.statefulSetData = opts.statefulSetData;
        this.daemonSetData = opts.daemonSetData;
        this.serviceData = opts.serviceData;
        this.pvcData = opts.pvcData;
        this.configMapData = opts.configMapData;
        this.secretData = opts.secretData;
        this.namespaceData = opts.namespaceData;
        this.nodeData = opts.nodeData;
    }
}

/**
 * Resolve o ícone para cada tipo de nó Kubernetes usando ícones do VS Code.
 */
function resolverIconeK8s(
    tipo: KubernetesNodeType,
    statusPod?: string,
): vscode.ThemeIcon {
    switch (tipo) {
        case 'k8s-cluster':
            return new vscode.ThemeIcon('server');

        case 'k8s-namespace':
            return new vscode.ThemeIcon('folder');

        case 'k8s-node':
            return new vscode.ThemeIcon('circuit-board');

        case 'k8s-event':
            return new vscode.ThemeIcon('bell');

        case 'k8s-group-pods':
            return new vscode.ThemeIcon('layers');

        case 'k8s-group-deployments':
            return new vscode.ThemeIcon('rocket');

        case 'k8s-group-statefulsets':
            return new vscode.ThemeIcon('database');

        case 'k8s-group-daemonsets':
            return new vscode.ThemeIcon('broadcast');

        case 'k8s-group-services':
            return new vscode.ThemeIcon('plug');

        case 'k8s-group-pvcs':
            return new vscode.ThemeIcon('archive');

        case 'k8s-group-configmaps':
            return new vscode.ThemeIcon('settings-gear');

        case 'k8s-group-secrets':
            return new vscode.ThemeIcon('lock');

        case 'k8s-pod-running':
            return new vscode.ThemeIcon(
                'circle-filled',
                new vscode.ThemeColor('testing.iconPassed'),
            );

        case 'k8s-pod-pending':
            return new vscode.ThemeIcon(
                'circle-filled',
                new vscode.ThemeColor('testing.iconQueued'),
            );

        case 'k8s-pod-failed': {
            // CrashLoopBackOff fica vermelho brilhante, Failed fica vermelho
            const corFalha =
                statusPod === 'CrashLoopBackOff'
                    ? new vscode.ThemeColor('testing.iconErrored')
                    : new vscode.ThemeColor('testing.iconFailed');
            return new vscode.ThemeIcon('circle-filled', corFalha);
        }

        case 'k8s-pod-other':
            return new vscode.ThemeIcon(
                'circle-outline',
                new vscode.ThemeColor('disabledForeground'),
            );

        case 'k8s-deployment':
            return new vscode.ThemeIcon('symbol-class');

        case 'k8s-statefulset':
            return new vscode.ThemeIcon('symbol-enum');

        case 'k8s-daemonset':
            return new vscode.ThemeIcon('symbol-event');

        case 'k8s-service':
            return new vscode.ThemeIcon('symbol-interface');

        case 'k8s-pvc':
            return new vscode.ThemeIcon('file-binary');

        case 'k8s-configmap':
            return new vscode.ThemeIcon('file-code');

        case 'k8s-secret':
            return new vscode.ThemeIcon('key');

        default:
            return new vscode.ThemeIcon('circle-outline');
    }
}
