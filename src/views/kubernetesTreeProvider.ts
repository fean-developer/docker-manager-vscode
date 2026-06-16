import * as vscode from 'vscode';
import { KubernetesTreeItem } from './kubernetesTreeItem';
import { KubernetesClient, KubernetesConfigError, KubernetesConnectionError } from '../kubernetes/kubernetesClient';
import { NamespaceService } from '../services/namespaceService';
import { NodeService } from '../services/nodeService';
import { PodService } from '../services/podService';
import { DeploymentService } from '../services/deploymentService';
import { StatefulSetService } from '../services/statefulSetService';
import { DaemonSetService } from '../services/daemonSetService';
import { KubernetesServiceService } from '../services/kubernetesServiceService';
import { PVCService } from '../services/pvcService';

export type KubernetesViewType = 'cluster' | 'workloads' | 'networking' | 'storage';

/**
 * Provider da árvore Kubernetes (filtrado por tipo de view).
 * Cada instância exibe uma categoria: cluster, workloads, networking ou storage.
 * Suporta refresh manual e polling automático a 15s.
 */
export class KubernetesTreeProvider implements vscode.TreeDataProvider<KubernetesTreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<KubernetesTreeItem | undefined | void>();
    public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private readonly nsService: NamespaceService;
    private readonly nodeService: NodeService;
    private readonly podService: PodService;
    private readonly deploymentService: DeploymentService;
    private readonly statefulSetService: StatefulSetService;
    private readonly daemonSetService: DaemonSetService;
    private readonly k8sServiceService: KubernetesServiceService;
    private readonly pvcService: PVCService;

    private pollingTimer: NodeJS.Timeout | undefined;
    private readonly POLLING_INTERVALO_MS = 15_000;
    private readonly viewType: KubernetesViewType;
    // Protege contra sobreposição de refreshes simultâneos
    private _refreshEmAndamento = false;

    constructor(viewType: KubernetesViewType) {
        this.viewType = viewType;
        this.nsService = new NamespaceService();
        this.nodeService = new NodeService();
        this.podService = new PodService();
        this.deploymentService = new DeploymentService();
        this.statefulSetService = new StatefulSetService();
        this.daemonSetService = new DaemonSetService();
        this.k8sServiceService = new KubernetesServiceService();
        this.pvcService = new PVCService();
    }

    /**
     * Dispara refresh da árvore. Ignorado se já houver refresh em andamento.
     */
    public refresh(): void {
        if (this._refreshEmAndamento) { return; }
        this._onDidChangeTreeData.fire();
    }

    /**
     * Inicia polling automático a cada 15s.
     */
    public iniciarPolling(): void {
        this.pollingTimer = setInterval(() => {
            this.refresh();
        }, this.POLLING_INTERVALO_MS);
    }

    /**
     * Para o polling automático.
     */
    public pararPolling(): void {
        if (this.pollingTimer) {
            clearInterval(this.pollingTimer);
            this.pollingTimer = undefined;
        }
    }

    public getTreeItem(element: KubernetesTreeItem): vscode.TreeItem {
        return element;
    }

    public async getChildren(element?: KubernetesTreeItem): Promise<KubernetesTreeItem[]> {
        if (!element) {
            return this.carregarRaiz();
        }
        return this.carregarFilhos(element);
    }

    /**
     * Carrega os itens raiz para cada tipo de view.
     */
    private async carregarRaiz(): Promise<KubernetesTreeItem[]> {
        this._refreshEmAndamento = true;
        try {
            const k8sClient = KubernetesClient.getInstance();

            if (!k8sClient.verificarKubeconfig()) {
                return [this.criarItemSemKubeconfig()];
            }

            try {
                k8sClient.carregar();
            } catch (err) {
                return [this.criarItemErro(err)];
            }

            switch (this.viewType) {
                case 'cluster': return await this.carregarCluster();
                case 'workloads': return await this.carregarWorkloads();
                case 'networking': return await this.carregarNetworking();
                case 'storage': return await this.carregarStorage();
                default: return [];
            }
        } catch (err) {
            return [this.criarItemErro(err)];
        } finally {
            this._refreshEmAndamento = false;
        }
    }

    /**
     * Carrega filhos de um grupo expandível.
     */
    private async carregarFilhos(element: KubernetesTreeItem): Promise<KubernetesTreeItem[]> {
        const k8sClient = KubernetesClient.getInstance();
        const ns = k8sClient.getNamespaceAtivo();

        try {
            switch (element.nodeType) {
                case 'k8s-group-pods': {
                    const pods = await this.podService.listar(ns);
                    return pods.map(pod => {
                        const tipoNo = mapearStatusPod(pod.status);
                        const prontidao = pod.pronto ? '●' : '○';
                        return new KubernetesTreeItem({
                            label: pod.nome,
                            nodeType: tipoNo,
                            resourceId: pod.nome,
                            description: `${pod.status} ${prontidao} restarts: ${pod.restarts}`,
                            tooltip: `Namespace: ${pod.namespace}\nNode: ${pod.nodeName}\nImagens: ${pod.imagens.join(', ')}`,
                            podData: pod,
                        });
                    });
                }
                case 'k8s-group-deployments': {
                    const deployments = await this.deploymentService.listar(ns);
                    return deployments.map(d => new KubernetesTreeItem({
                        label: d.nome,
                        nodeType: 'k8s-deployment',
                        resourceId: d.nome,
                        description: `${d.replicasProntas}/${d.replicasDesejadas} prontas`,
                        tooltip: `Namespace: ${d.namespace}\nImagens: ${d.imagens.join(', ')}`,
                        deploymentData: d,
                    }));
                }
                case 'k8s-group-statefulsets': {
                    const sts = await this.statefulSetService.listar(ns);
                    return sts.map(s => new KubernetesTreeItem({
                        label: s.nome,
                        nodeType: 'k8s-statefulset',
                        resourceId: s.nome,
                        description: `${s.replicasProntas}/${s.replicasDesejadas} prontas`,
                        tooltip: `Namespace: ${s.namespace}\nImagens: ${s.imagens.join(', ')}`,
                        statefulSetData: s,
                    }));
                }
                case 'k8s-group-daemonsets': {
                    const dss = await this.daemonSetService.listar(ns);
                    return dss.map(ds => new KubernetesTreeItem({
                        label: ds.nome,
                        nodeType: 'k8s-daemonset',
                        resourceId: ds.nome,
                        description: `${ds.numberAvailable}/${ds.desiredNumberScheduled} disponíveis`,
                        tooltip: `Namespace: ${ds.namespace}\nImagens: ${ds.imagens.join(', ')}`,
                        daemonSetData: ds,
                    }));
                }
                case 'k8s-group-services': {
                    const svcs = await this.k8sServiceService.listar(ns);
                    return svcs.map(svc => new KubernetesTreeItem({
                        label: svc.nome,
                        nodeType: 'k8s-service',
                        resourceId: svc.nome,
                        description: `${svc.tipo} — ${svc.clusterIP}`,
                        tooltip: `Namespace: ${svc.namespace}\nPortas: ${svc.portas.map(p => `${p.porta}/${p.protocolo}`).join(', ')}`,
                        serviceData: svc,
                    }));
                }
                case 'k8s-group-pvcs': {
                    const pvcs = await this.pvcService.listar(ns);
                    return pvcs.map(pvc => new KubernetesTreeItem({
                        label: pvc.nome,
                        nodeType: 'k8s-pvc',
                        resourceId: pvc.nome,
                        description: `${pvc.status} — ${pvc.capacidade}`,
                        tooltip: `Namespace: ${pvc.namespace}\nStorage Class: ${pvc.storageClass}`,
                        pvcData: pvc,
                    }));
                }
                default:
                    return [];
            }
        } catch (err) {
            return [this.criarItemErro(err)];
        }
    }

    // ── Carregadores por tipo de view ────────────────────────────────────────

    private async carregarCluster(): Promise<KubernetesTreeItem[]> {
        const k8sClient = KubernetesClient.getInstance();
        const contextoAtivo = k8sClient.getContextoAtivo();

        const itens: KubernetesTreeItem[] = [];

        // Nó raiz: contexto ativo
        itens.push(new KubernetesTreeItem({
            label: contextoAtivo || 'sem contexto',
            nodeType: 'k8s-cluster',
            resourceId: contextoAtivo,
            description: k8sClient.eClusterLocal() ? 'local' : '⚠ remoto',
            tooltip: `Servidor: ${k8sClient.getServidorAtivo()}`,
            collapsible: vscode.TreeItemCollapsibleState.None,
        }));

        // Nodes
        try {
            const nodes = await this.nodeService.listar();
            for (const node of nodes) {
                const statusLabel = node.status === 'Ready' ? '✓' : '✗';
                itens.push(new KubernetesTreeItem({
                    label: node.nome,
                    nodeType: 'k8s-node',
                    resourceId: node.nome,
                    description: `${statusLabel} ${node.status} — ${node.roles.join(',')} — ${node.versao}`,
                    tooltip: `CPU: ${node.cpu.alocavel}/${node.cpu.capacidade}\nMemória: ${node.memoria.alocavel}/${node.memoria.capacidade}`,
                    nodeData: node,
                }));
            }
        } catch {
            // Não bloquear view se nodes falhar
        }

        // Namespaces
        try {
            const namespaces = await this.nsService.listar();
            for (const ns of namespaces) {
                itens.push(new KubernetesTreeItem({
                    label: ns.nome,
                    nodeType: 'k8s-namespace',
                    resourceId: ns.nome,
                    description: ns.status,
                    namespaceData: ns,
                }));
            }
        } catch {
            // Não bloquear view se namespaces falhar
        }

        return itens;
    }

    private async carregarWorkloads(): Promise<KubernetesTreeItem[]> {
        const ns = KubernetesClient.getInstance().getNamespaceAtivo();

        const carregarContador = async <T>(fn: () => Promise<T[]>): Promise<number> => {
            try { return (await fn()).length; } catch { return 0; }
        };

        const [nPods, nDeployments, nStatefulSets, nDaemonSets] = await Promise.all([
            carregarContador(() => this.podService.listar(ns)),
            carregarContador(() => this.deploymentService.listar(ns)),
            carregarContador(() => this.statefulSetService.listar(ns)),
            carregarContador(() => this.daemonSetService.listar(ns)),
        ]);

        return [
            new KubernetesTreeItem({
                label: 'Pods',
                nodeType: 'k8s-group-pods',
                resourceId: 'group-pods',
                description: `${nPods}`,
                collapsible: vscode.TreeItemCollapsibleState.Collapsed,
            }),
            new KubernetesTreeItem({
                label: 'Deployments',
                nodeType: 'k8s-group-deployments',
                resourceId: 'group-deployments',
                description: `${nDeployments}`,
                collapsible: vscode.TreeItemCollapsibleState.Collapsed,
            }),
            new KubernetesTreeItem({
                label: 'StatefulSets',
                nodeType: 'k8s-group-statefulsets',
                resourceId: 'group-statefulsets',
                description: `${nStatefulSets}`,
                collapsible: vscode.TreeItemCollapsibleState.Collapsed,
            }),
            new KubernetesTreeItem({
                label: 'DaemonSets',
                nodeType: 'k8s-group-daemonsets',
                resourceId: 'group-daemonsets',
                description: `${nDaemonSets}`,
                collapsible: vscode.TreeItemCollapsibleState.Collapsed,
            }),
        ];
    }

    private async carregarNetworking(): Promise<KubernetesTreeItem[]> {
        const ns = KubernetesClient.getInstance().getNamespaceAtivo();
        let nServices = 0;
        try { nServices = (await this.k8sServiceService.listar(ns)).length; } catch { /* ignora */ }

        return [
            new KubernetesTreeItem({
                label: 'Services',
                nodeType: 'k8s-group-services',
                resourceId: 'group-services',
                description: `${nServices}`,
                collapsible: vscode.TreeItemCollapsibleState.Collapsed,
            }),
        ];
    }

    private async carregarStorage(): Promise<KubernetesTreeItem[]> {
        const ns = KubernetesClient.getInstance().getNamespaceAtivo();
        let nPVCs = 0;
        try { nPVCs = (await this.pvcService.listar(ns)).length; } catch { /* ignora */ }

        return [
            new KubernetesTreeItem({
                label: 'PersistentVolumeClaims',
                nodeType: 'k8s-group-pvcs',
                resourceId: 'group-pvcs',
                description: `${nPVCs}`,
                collapsible: vscode.TreeItemCollapsibleState.Collapsed,
            }),
        ];
    }

    // ── Itens de estado ──────────────────────────────────────────────────────

    private criarItemSemKubeconfig(): KubernetesTreeItem {
        return new KubernetesTreeItem({
            label: 'Kubeconfig não encontrado',
            nodeType: 'k8s-cluster',
            resourceId: 'sem-kubeconfig',
            description: 'Configure ~/.kube/config com um cluster local',
            tooltip: 'Instale minikube, kind ou k3d e inicie um cluster local.',
        });
    }

    private criarItemErro(err: unknown): KubernetesTreeItem {
        const msg = err instanceof Error ? err.message : 'Erro desconhecido';
        const isFalhaConexao = err instanceof KubernetesConnectionError;
        const isFalhaConfig = err instanceof KubernetesConfigError;
        const descricao = isFalhaConexao
            ? 'Cluster inacessível'
            : isFalhaConfig
                ? 'Configuração inválida'
                : 'Erro ao carregar';

        return new KubernetesTreeItem({
            label: descricao,
            nodeType: 'k8s-cluster',
            resourceId: 'erro',
            description: msg.substring(0, 60),
            tooltip: msg,
        });
    }
}

/**
 * Mapeia o status de um pod para o tipo de nó da árvore.
 */
function mapearStatusPod(
    status: 'Running' | 'Pending' | 'Failed' | 'Succeeded' | 'Unknown' | 'CrashLoopBackOff',
): 'k8s-pod-running' | 'k8s-pod-pending' | 'k8s-pod-failed' | 'k8s-pod-other' {
    switch (status) {
        case 'Running': return 'k8s-pod-running';
        case 'Pending': return 'k8s-pod-pending';
        case 'Failed':
        case 'CrashLoopBackOff': return 'k8s-pod-failed';
        default: return 'k8s-pod-other';
    }
}
