import * as vscode from 'vscode';
import Dockerode from 'dockerode';
import { ContainerService } from '../services/containerService';
import { ImageService, ImageInfo } from '../services/imageService';
import { VolumeService } from '../services/volumeService';
import { NetworkService } from '../services/networkService';
import { DockerClient } from '../docker/dockerClient';
import type { ContainerInfo } from '../services/containerService';
import {
    gerarHtmlClusterOverview,
    gerarHtmlWorkloads,
    gerarHtmlNetworking,
    gerarHtmlStorage,
    gerarHtmlConfig,
    gerarHtmlK8sIndisponivel,
    gerarHtmlNamespaces,
    gerarHtmlNodes,
    CSS_K8S,
} from './kubernetes/kubernetesPanel';

type Secao = 'dashboard' | 'containers' | 'images' | 'networks' | 'volumes' | 'detail' | 'settings' | 'kubernetes';
type AcaoBulkContainer = 'start' | 'stop' | 'restart' | 'kill' | 'pause' | 'resume' | 'remove';

interface MsgFromWebview {
    command: string;
    secao?: Secao;
    acao?: AcaoBulkContainer | string;
    ids?: string[];
    id?: string;
    acaoRapida?: 'logs' | 'shell';
    settings?: { fontSize: number; density: string };
    // K8s actions
    nome?: string;
    namespace?: string;
    valor?: string;
    // Navegação ao abrir detalhe de outro contexto (ex: volumes → container)
    navegarPara?: string;
}

/**
 * Painel principal SPA — todas as seções em uma única aba.
 * Navegação entre Dashboard, Containers, Imagens, Redes e Volumes é feita client-side.
 *
 * SEGURANÇA: Sem acesso externo. Comunicação exclusiva via postMessage.
 */
export class MainPanel {
    private static readonly VIEW_TYPE = 'dockerManager.main';
    private static instancia: MainPanel | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    // Watcher do kubeconfig para detectar mudanças de contexto em tempo real
    private _k8sWatcher: import('fs').FSWatcher | null = null;
    private _k8sStatusAtual: boolean | null = null; // null = ainda não verificado

    private readonly _containerSvc: ContainerService;
    private readonly _imageSvc: ImageService;
    private readonly _volumeSvc: VolumeService;
    private readonly _networkSvc: NetworkService;

    private readonly _onAbrirLogs: (id: string) => Promise<void>;
    private readonly _onAbrirShell: (id: string) => Promise<void>;

    // Rastreamento de CPU e stream persistente de stats
    private _statsStream: NodeJS.ReadableStream | null = null;
    private _statsStreamBuf = '';
    private _prevCpuUsage = 0;
    private _prevSysCpuUsage = 0;
    private _prevStatsContainerId = '';

    // Monitoramento de métricas de pod em tempo real
    private _podMetricsTimer: ReturnType<typeof setInterval> | null = null;
    private _podMetricoAtual: { nome: string; namespace: string } | null = null;

    // Indica que o painel foi destruído — impede que callbacks agendados tentem usar o webview
    private _disposto = false;

    private _pararStatsStream(): void {
        if (this._statsStream) {
            try { (this._statsStream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.(); } catch { /* ignora */ }
            this._statsStream = null;
        }
        this._statsStreamBuf = '';
        this._prevCpuUsage = 0;
        this._prevSysCpuUsage = 0;
        this._prevStatsContainerId = '';
    }

    /**
     * Inicia polling de métricas de CPU e memória do pod via Kubelet Stats Summary API.
     * Usa /api/v1/nodes/{node}/proxy/stats/summary — nativa no Kubernetes, sem metrics-server.
     * Envia dadosPodStats ao webview a cada 3 segundos.
     */
    private _iniciarPodMetrics(nome: string, namespace: string): void {
        this._pararPodMetrics();
        this._podMetricoAtual = { nome, namespace };

        // Nome do nó é obtido na primeira poll e cacheado na closure
        let nodeName: string | null = null;

        const poll = async (): Promise<void> => {
            try {
                const { KubernetesClient } = await import('../kubernetes/kubernetesClient');
                const kc = KubernetesClient.getInstance().getKubeConfig();
                const k8s = await import('@kubernetes/client-node');
                const coreApi = kc.makeApiClient(k8s.CoreV1Api);

                // Obtém o nó do pod uma única vez e cacheia
                if (!nodeName) {
                    const pod = await coreApi.readNamespacedPod({ name: nome, namespace });
                    nodeName = pod.spec?.nodeName ?? null;
                    if (!nodeName) {
                        // Pod ainda não foi agendado — tenta na próxima poll
                        return;
                    }
                }

                // Kubelet Stats Summary API: retorna objeto com CPU/mem de todos os pods do nó
                type KubeletSummary = {
                    pods?: Array<{
                        podRef: { name: string; namespace: string };
                        containers?: Array<{
                            cpu?: { usageNanoCores?: number };
                            memory?: { workingSetBytes?: number };
                        }>;
                    }>;
                };
                const summary = await (
                    coreApi.connectGetNodeProxyWithPath({ name: nodeName, path: 'stats/summary' }) as unknown as Promise<KubeletSummary>
                );

                const podStats = summary.pods?.find(
                    p => p.podRef.name === nome && p.podRef.namespace === namespace,
                );

                if (!podStats) {
                    // Pod em reinicialização ou migrando de nó — reseta cache e aguarda
                    nodeName = null;
                    return;
                }

                let cpuNanoCores = 0;
                let memBytes = 0;
                for (const c of podStats.containers ?? []) {
                    cpuNanoCores += c.cpu?.usageNanoCores ?? 0;
                    memBytes += c.memory?.workingSetBytes ?? 0;
                }

                if (this._panel) {
                    this._panel.webview.postMessage({
                        command: 'dadosPodStats',
                        cpuMillicores: Math.round(cpuNanoCores / 1_000_000),
                        memBytes,
                    });
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                if (this._panel) {
                    this._panel.webview.postMessage({
                        command: 'erroPodStats',
                        erro: 'Erro ao obter métricas do pod: ' + msg,
                    });
                }
                // Não para o polling — pode ser erro temporário de rede
            }
        };

        void poll();
        this._podMetricsTimer = setInterval(() => { void poll(); }, 1000);
    }

    /**
     * Para o polling de métricas do pod ativo.
     */
    private _pararPodMetrics(): void {
        if (this._podMetricsTimer !== null) {
            clearInterval(this._podMetricsTimer);
            this._podMetricsTimer = null;
        }
        this._podMetricoAtual = null;
    }

    /**
     * Verifica se há um contexto Kubernetes ativo e envia statusK8s ao webview.
     * Só envia mensagem quando o status muda (evita re-renders desnecessários).
     */
    private async _verificarStatusK8s(): Promise<void> {
        try {
            const { KubernetesClient } = await import('../kubernetes/kubernetesClient');
            const client = KubernetesClient.getInstance();
            const disponivel = client.verificarKubeconfig() && (() => {
                try { client.carregar(); return !!client.getContextoAtivo(); } catch { return false; }
            })();
            if (disponivel === this._k8sStatusAtual) { return; } // sem mudança
            this._k8sStatusAtual = disponivel;
            const contextos = disponivel ? [] : (() => {
                try { return client.listarContextos().map(c => c.nome); } catch { return []; }
            })();
            this._panel.webview.postMessage({ command: 'statusK8s', disponivel, contextos });
        } catch {
            if (this._k8sStatusAtual === false) { return; }
            this._k8sStatusAtual = false;
            this._panel.webview.postMessage({ command: 'statusK8s', disponivel: false, contextos: [] });
        }
    }

    /**
     * Inicia watcher no kubeconfig para detectar troca de contexto em tempo real.
     * Usa debounce de 1s para evitar verificações em cascata durante gravação.
     */
    private _iniciarWatcherKubeconfig(): void {
        const fs = require('fs') as typeof import('fs');
        const os = require('os') as typeof import('os');
        const path = require('path') as typeof import('path');

        const kubeconfigPath = process.env['KUBECONFIG']?.split(path.delimiter)[0]
            ?? path.join(os.homedir(), '.kube', 'config');

        if (!fs.existsSync(kubeconfigPath)) { return; }

        let debounce: ReturnType<typeof setTimeout> | null = null;
        try {
            this._k8sWatcher = fs.watch(kubeconfigPath, () => {
                if (debounce) { clearTimeout(debounce); }
                debounce = setTimeout(() => {
                    // Reseta cache para forçar re-verificação
                    this._k8sStatusAtual = null;
                    this._verificarStatusK8s().catch(() => { /* silencioso */ });
                }, 1000);
            });
        } catch { /* kubeconfig pode não existir ainda */ }
    }

    private readonly _globalState: vscode.Memento;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        globalState: vscode.Memento,
        onAbrirLogs: (id: string) => Promise<void>,
        onAbrirShell: (id: string) => Promise<void>,
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._globalState = globalState;
        this._containerSvc = new ContainerService();
        this._imageSvc = new ImageService();
        this._volumeSvc = new VolumeService();
        this._networkSvc = new NetworkService();
        this._onAbrirLogs = onAbrirLogs;
        this._onAbrirShell = onAbrirShell;

        this._panel.webview.html = this._gerarHtml();
        this._registrarMensagens();
        this._panel.onDidDispose(() => this._destruir(), null, this._disposables);

        // Verifica status K8s imediatamente e inicia watcher para detecção automática
        // Executa após o webview estar pronto (pequeno delay para garantir que o JS do webview carregou)
        setTimeout(() => {
            this._verificarStatusK8s().catch(() => { /* silencioso */ });
            this._iniciarWatcherKubeconfig();
        }, 500);
    }

    /** Retorna true se o painel está aberto (não foi fechado pelo usuário). */
    public static estaAberto(): boolean {
        return MainPanel.instancia !== undefined;
    }

    public static criar(
        extensionUri: vscode.Uri,
        secaoInicial: Secao,
        globalState: vscode.Memento,
        onAbrirLogs: (id: string) => Promise<void>,
        onAbrirShell: (id: string) => Promise<void>,
    ): void {
        const coluna = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

        if (MainPanel.instancia) {
            MainPanel.instancia._panel.reveal(coluna);
            MainPanel.instancia._navegarPara(secaoInicial);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            MainPanel.VIEW_TYPE,
            'Docker Manager',
            coluna,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
            },
        );

        MainPanel.instancia = new MainPanel(panel, extensionUri, globalState, onAbrirLogs, onAbrirShell);
        MainPanel.instancia._navegarPara(secaoInicial);
    }

    private _navegarPara(secao: Secao): void {
        this._panel.webview.postMessage({ command: 'navegar', secao });
    }

    private _registrarMensagens(): void {
        this._panel.webview.onDidReceiveMessage(async (msg: MsgFromWebview) => {
            switch (msg.command) {
                case 'carregarSecao':
                    if (msg.secao) await this._carregarSecao(msg.secao);
                    break;

                case 'acaoBulkContainers':
                    if (msg.acao && msg.ids && msg.ids.length > 0) {
                        await this._acaoBulkContainers(msg.acao as AcaoBulkContainer, msg.ids);
                    }
                    break;

                case 'carregarDetalheContainer':
                    if (msg.id) await this._carregarDetalhe(msg.id, msg.navegarPara as string | undefined);
                    break;

                case 'carregarLogs':
                    if (msg.id) {
                        try {
                            const logs = await this._containerSvc.obterLogs(msg.id, 200);
                            this._panel.webview.postMessage({
                                command: 'dadosLogs',
                                data: MainPanel._ansiParaHtml(logs),
                            });
                        } catch (err) {
                            this._panel.webview.postMessage({
                                command: 'dadosLogs',
                                erro: err instanceof Error ? err.message : String(err),
                            });
                        }
                    }
                    break;

                case 'acaoRapidaContainer':
                    if (msg.id && msg.acaoRapida) {
                        switch (msg.acaoRapida) {
                            case 'logs':  await this._onAbrirLogs(msg.id); break;
                            case 'shell': await this._onAbrirShell(msg.id); break;
                        }
                    }
                    break;

                case 'salvarSettings':
                    if (msg.settings) {
                        await this._globalState.update('dockerManager.settings', msg.settings);
                    }
                    break;

                case 'removerImagens':
                    if (msg.ids && msg.ids.length > 0) {
                        await this._removerImagens(msg.ids);
                    }
                    break;

                case 'removerVolumes':
                    if (msg.ids && msg.ids.length > 0) {
                        await this._removerVolumes(msg.ids);
                    }
                    break;

                case 'removerRedes':
                    if (msg.ids && msg.ids.length > 0) {
                        await this._removerRedes(msg.ids);
                    }
                    break;

                case 'iniciarMonitorStream':
                    this._pararStatsStream();
                    if (msg.id) {
                        const streamId = msg.id as string;
                        this._prevCpuUsage = 0;
                        this._prevSysCpuUsage = 0;
                        this._prevStatsContainerId = '';
                        this._containerSvc.criarStatsStream(streamId).then(stream => {
                            this._statsStream = stream;
                            this._statsStreamBuf = '';
                            stream.on('data', (chunk: Buffer) => {
                                this._statsStreamBuf += chunk.toString();
                                let nl = this._statsStreamBuf.indexOf('\n');
                                while (nl !== -1) {
                                    const line = this._statsStreamBuf.slice(0, nl).trim();
                                    this._statsStreamBuf = this._statsStreamBuf.slice(nl + 1);
                                    nl = this._statsStreamBuf.indexOf('\n');
                                    if (!line) continue;
                                    try {
                                        const raw = JSON.parse(line) as Dockerode.ContainerStats;
                                        const curCpu = raw.cpu_stats.cpu_usage.total_usage;
                                        const curSys = ((raw.cpu_stats as unknown as Record<string, number>).system_cpu_usage ?? 0);
                                        const rawCpu = raw.cpu_stats as unknown as Record<string, unknown>;
                                        const onlineCpus = rawCpu.online_cpus as number | undefined;
                                        const percpu = (raw.cpu_stats.cpu_usage as unknown as Record<string, unknown[]>).percpu_usage;
                                        const numCpu = onlineCpus ?? (percpu?.length ?? 1);
                                        let cpu = 0;
                                        if (this._prevStatsContainerId === streamId && this._prevSysCpuUsage > 0) {
                                            const cpuDelta = curCpu - this._prevCpuUsage;
                                            const sysDelta = curSys - this._prevSysCpuUsage;
                                            cpu = sysDelta > 0 ? (cpuDelta / sysDelta) * numCpu * 100 : 0;
                                        }
                                        this._prevCpuUsage = curCpu;
                                        this._prevSysCpuUsage = curSys;
                                        this._prevStatsContainerId = streamId;
                                        const memStats = ((raw.memory_stats.stats ?? {}) as Record<string, number>);
                                        const pageCache = memStats.inactive_file ?? memStats.cache ?? 0;
                                        const memUsed = (raw.memory_stats.usage ?? 0) - pageCache;
                                        const memLimit = raw.memory_stats.limit ?? 0;
                                        let netRx = 0, netTx = 0;
                                        for (const iface of Object.values(
                                            (raw.networks ?? {}) as Record<string, { rx_bytes: number; tx_bytes: number }>
                                        )) {
                                            netRx += iface.rx_bytes ?? 0;
                                            netTx += iface.tx_bytes ?? 0;
                                        }
                                        this._panel.webview.postMessage({
                                            command: 'dadosStats',
                                            data: { ts: Date.now(), cpu: Math.max(0, cpu), memUsed, memLimit, netRx, netTx },
                                        });
                                    } catch { /* JSON incompleto, ignora */ }
                                }
                            });
                            stream.on('error', () => { this._statsStream = null; });
                            stream.on('end', () => { this._statsStream = null; });
                        }).catch(() => { /* container parou antes de iniciar stream */ });
                    }
                    break;

                case 'pararMonitorStream':
                    this._pararStatsStream();
                    break;

                case 'trocarContexto':
                    if (msg.nome) {
                        try {
                            const { KubernetesClient } = await import('../kubernetes/kubernetesClient');
                            const client = KubernetesClient.getInstance();
                            client.definirContexto(msg.nome);
                            client.definirNamespace('default');
                            // Recarrega seção com o novo contexto
                            await this._carregarSecaoKubernetes();
                        } catch (err) {
                            vscode.window.showErrorMessage(
                                `Erro ao trocar para o contexto "${msg.nome}": ${err instanceof Error ? err.message : String(err)}`,
                            );
                        }
                    }
                    break;

                case 'trocarNamespace':
                    if (msg.nome) {
                        try {
                            const { KubernetesClient } = await import('../kubernetes/kubernetesClient');
                            KubernetesClient.getInstance().definirNamespace(msg.nome);
                            await this._carregarSecaoKubernetes();
                        } catch (err) {
                            vscode.window.showErrorMessage(
                                `Erro ao trocar namespace para "${msg.nome}": ${err instanceof Error ? err.message : String(err)}`,
                            );
                        }
                    }
                    break;

                case 'k8sAcao':
                    if (msg.acao) await this._acaoK8s(msg);
                    break;

                case 'k8sAbrirPod':
                    if (msg.nome && msg.namespace) await this._carregarPodDetalhe(msg.nome, msg.namespace);
                    break;

                case 'k8sTopologia':
                    await this._carregarTopologia();
                    break;

                case 'iniciarMonitoramentoPod':
                    if (msg.nome && msg.namespace) this._iniciarPodMetrics(msg.nome as string, msg.namespace as string);
                    break;

                case 'pararMonitoramentoPod':
                    this._pararPodMetrics();
                    break;

                case 'k8sLogs':
                    if (msg.nome && msg.namespace) {
                        try {
                            const { PodService } = await import('../services/podService');
                            const svc = new PodService();
                            const raw = await svc.obterLogs(msg.namespace, msg.nome);
                            this._panel.webview.postMessage({
                                command: 'dadosPodLogs',
                                data: MainPanel._ansiParaHtml(raw),
                            });
                        } catch (err) {
                            this._panel.webview.postMessage({
                                command: 'dadosPodLogs',
                                erro: err instanceof Error ? err.message : String(err),
                            });
                        }
                    }
                    break;
            }
        }, null, this._disposables);
    }

    private async _carregarSecao(secao: Secao): Promise<void> {
        try {
            switch (secao) {
                case 'dashboard': {
                    const [versao, info, containers, imagens, volumes, redes] = await Promise.all([
                        DockerClient.getInstance().obterVersao(),
                        DockerClient.getInstance().obterInfoSistema(),
                        this._containerSvc.listar(),
                        this._imageSvc.listar(),
                        this._volumeSvc.listar(),
                        this._networkSvc.listar(),
                    ]);
                    const running = containers.filter((c: ContainerInfo) => c.estado === 'running').length;
                    const totalBytes = imagens.reduce((acc: number, img: ImageInfo) => acc + img.tamanho, 0);

                    this._panel.webview.postMessage({
                        command: 'dadosDashboard',
                        data: {
                            engine: {
                                versao: versao.Version,
                                api: versao.ApiVersion,
                                os: (info['OperatingSystem'] ?? info['OSType'] ?? '-') as string,
                                arch: (info['Architecture'] ?? '-') as string,
                                cpus: info['NCPU'] ?? '-',
                                memoria: (info['MemTotal'] as number) ?? 0,
                                hostname: (info['Name'] ?? '-') as string,
                            },
                            containers: { total: containers.length, running, stopped: containers.length - running },
                            imagens: { total: imagens.length, tamanhoTotal: totalBytes },
                            volumes: { total: volumes.length },
                            redes: { total: redes.length },
                        },
                    });
                    break;
                }
                case 'containers': {
                    const lista = await this._containerSvc.listar();
                    this._panel.webview.postMessage({ command: 'dadosContainers', data: lista });
                    break;
                }
                case 'images': {
                    const imagens = await this._imageSvc.listar();
                    const dados = imagens.map((img: ImageInfo) => ({
                        id: img.id,
                        tags: img.tags.length > 0 ? img.tags[0] : img.idCurto,
                        tamanho: img.tamanhoFormatado,
                        criada: new Date(img.criada).toLocaleDateString('pt-BR'),
                        emUso: img.emUso,
                    }));
                    this._panel.webview.postMessage({ command: 'dadosImagens', data: dados });
                    break;
                }
                case 'networks': {
                    const redes = await this._networkSvc.listar();
                    const SISTEMA = new Set(['bridge', 'host', 'none']);
                    const dados = redes.map(r => ({
                        id: r.id,
                        nome: r.nome,
                        driver: r.driver,
                        escopo: r.escopo,
                        subnet: r.ipam.subnet ?? '-',
                        gateway: r.ipam.gateway ?? '-',
                        ipamDriver: r.ipam.driver,
                        containers: r.containersConectados,
                        sistema: SISTEMA.has(r.nome),
                    }));
                    this._panel.webview.postMessage({ command: 'dadosRedes', data: dados });
                    break;
                }
                case 'volumes': {
                    const volumes = await this._volumeSvc.listar();
                    const dados = volumes.map(v => ({
                        id: v.nome,
                        nome: v.nome,
                        driver: v.driver,
                        mountpoint: v.mountpoint,
                        escopo: v.escopo,
                        emUso: v.emUso,
                        criado: v.criado,
                        tamanho: v.tamanho,
                        refCount: v.refCount,
                        diskStats: v.diskStats,
                        labels: v.labels,
                        containers: v.containers,
                    }));
                    this._panel.webview.postMessage({ command: 'dadosVolumes', data: dados });
                    break;
                }
                case 'kubernetes': {
                    await this._carregarSecaoKubernetes();
                    break;
                }
            }
        } catch (err) {
            this._panel.webview.postMessage({
                command: 'erroSecao',
                secao,
                data: err instanceof Error ? err.message : String(err),
            });
        }
    }

    private async _carregarSecaoKubernetes(): Promise<void> {
        // Importações dinâmicas para não bloquear extensão se K8s não instalado
        try {
            const { KubernetesClient } = await import('../kubernetes/kubernetesClient');
            const { PodService } = await import('../services/podService');
            const { DeploymentService } = await import('../services/deploymentService');
            const { StatefulSetService } = await import('../services/statefulSetService');
            const { DaemonSetService } = await import('../services/daemonSetService');
            const { KubernetesServiceService } = await import('../services/kubernetesServiceService');
            const { PVCService } = await import('../services/pvcService');
            const { ConfigMapService } = await import('../services/configMapService');
            const { SecretService } = await import('../services/secretService');
            const { NodeService } = await import('../services/nodeService');
            const { NamespaceService } = await import('../services/namespaceService');

            const client = KubernetesClient.getInstance();
            if (!client.verificarKubeconfig()) {
                this._panel.webview.postMessage({
                    command: 'dadosKubernetes',
                    secao: 'cluster',
                    html: gerarHtmlK8sIndisponivel('Kubeconfig não encontrado. Configure ~/.kube/config ou a variável KUBECONFIG.'),
                });
                return;
            }
            client.carregar();

            // Sem contexto ativo = nenhum cluster selecionado
            const contextoAtivo = client.getContextoAtivo();
            const todosContextos = client.listarContextos().map(c => ({ nome: c.nome, ativo: c.ativo }));

            if (!contextoAtivo) {
                const listaHtml = todosContextos.length > 0
                    ? `<p style="margin:8px 0 4px">Contextos disponíveis:</p><ul style="margin:0;padding-left:18px">${todosContextos.map(c => `<li style="font-family:var(--font-mono)">${c.nome}</li>`).join('')}</ul><p style="margin:8px 0 0">Use <code>kubectl config use-context &lt;nome&gt;</code> para ativar.</p>`
                    : '<p style="margin:8px 0 0">Nenhum contexto configurado no kubeconfig.</p>';
                this._panel.webview.postMessage({
                    command: 'dadosKubernetes',
                    contextos: todosContextos,
                    contextoAtivo: '',
                    cluster: gerarHtmlK8sIndisponivel(
                        'Nenhum contexto Kubernetes ativo.',
                        listaHtml,
                    ),
                });
                return;
            }

            await client.verificarConexao();

            const ns = client.getNamespaceAtivo();

            // Cada recurso é buscado individualmente — falhas parciais não derrubam a UI inteira
            const safe = async <T>(fn: () => Promise<T[]>): Promise<T[]> => {
                try { return await fn(); } catch { return []; }
            };
            const [nodes, namespaces, pods, deployments, statefulsets, daemonsets, services, pvcs, configmaps, secrets] =
                await Promise.all([
                    safe(() => new NodeService().listar()),
                    safe(() => new NamespaceService().listar()),
                    safe(() => new PodService().listar(ns)),
                    safe(() => new DeploymentService().listar(ns)),
                    safe(() => new StatefulSetService().listar(ns)),
                    safe(() => new DaemonSetService().listar(ns)),
                    safe(() => new KubernetesServiceService().listar(ns)),
                    safe(() => new PVCService().listar(ns)),
                    safe(() => new ConfigMapService().listar(ns)),
                    safe(() => new SecretService().listar(ns)),
                ]);

            const contadores = {
                pods: pods.length,
                podsRunning: pods.filter(p => p.status.toLowerCase() === 'running').length,
                deployments: deployments.length,
                deploymentsOk: deployments.filter(d => d.replicasProntas >= d.replicasDesejadas && d.replicasDesejadas > 0).length,
                statefulsets: statefulsets.length,
                daemonsets: daemonsets.length,
                services: services.length,
                pvcs: pvcs.length,
                configmaps: configmaps.length,
                secrets: secrets.length,
            };

            this._panel.webview.postMessage({
                command: 'dadosKubernetes',
                contextos: todosContextos,
                contextoAtivo,
                namespaceAtivo: ns,
                nomespacesLista: namespaces.map(n => n.nome),
                cluster: gerarHtmlClusterOverview(
                    contextoAtivo,
                    client.getServidorAtivo(),
                    ns,
                    nodes,
                    namespaces,
                    contadores,
                ),
                namespaces: gerarHtmlNamespaces(namespaces),
                workloads: gerarHtmlWorkloads(ns, pods, deployments, statefulsets, daemonsets),
                networking: gerarHtmlNetworking(ns, services),
                storage: gerarHtmlStorage(ns, pvcs),
                config: gerarHtmlConfig(ns, configmaps, secrets),
                nodes: gerarHtmlNodes(nodes),
            });
        } catch (err) {
            const motivo = err instanceof Error ? err.message : String(err);
            // Tenta enviar contextos mesmo em erro, para manter o seletor visível
            let ctxErrAtivo = '';
            let ctxErrLista: { nome: string; ativo: boolean }[] = [];
            try {
                const { KubernetesClient: KC } = await import('../kubernetes/kubernetesClient');
                ctxErrAtivo = KC.getInstance().getContextoAtivo();
                ctxErrLista = KC.getInstance().listarContextos().map(c => ({ nome: c.nome, ativo: c.ativo }));
            } catch { /* ignora */ }
            this._panel.webview.postMessage({
                command: 'dadosKubernetes',
                contextos: ctxErrLista,
                contextoAtivo: ctxErrAtivo,
                cluster: gerarHtmlK8sIndisponivel(`Erro ao conectar ao cluster: ${motivo}`),
                namespaces: gerarHtmlK8sIndisponivel(motivo),
                workloads: gerarHtmlK8sIndisponivel(motivo),
                networking: gerarHtmlK8sIndisponivel(motivo),
                storage: gerarHtmlK8sIndisponivel(motivo),
                config: gerarHtmlK8sIndisponivel(motivo),
                nodes: gerarHtmlK8sIndisponivel(motivo),
            });
        }
    }

    private async _acaoBulkContainers(acao: AcaoBulkContainer, ids: string[]): Promise<void> {
        if (acao === 'remove') {
            const ok = await vscode.window.showWarningMessage(
                `Remover ${ids.length} container(s)? Esta ação não pode ser desfeita.`,
                { modal: true }, 'Remover',
            );
            if (ok !== 'Remover') { this._panel.webview.postMessage({ command: 'acaoCancelada' }); return; }
        }
        if (acao === 'kill') {
            const ok = await vscode.window.showWarningMessage(
                `Matar ${ids.length} container(s) com SIGKILL?`,
                { modal: true }, 'Matar',
            );
            if (ok !== 'Matar') { this._panel.webview.postMessage({ command: 'acaoCancelada' }); return; }
        }
        const erros: string[] = [];
        await Promise.allSettled(ids.map(async id => {
            try {
                switch (acao) {
                    case 'start':   await this._containerSvc.iniciar(id); break;
                    case 'stop':    await this._containerSvc.parar(id); break;
                    case 'restart': await this._containerSvc.reiniciar(id); break;
                    case 'kill':    await this._containerSvc.matar(id); break;
                    case 'pause':   await this._containerSvc.pausar(id); break;
                    case 'resume':  await this._containerSvc.retomar(id); break;
                    case 'remove':  await this._containerSvc.remover(id, true); break;
                }
            } catch (e) { erros.push(e instanceof Error ? e.message : String(e)); }
        }));
        if (erros.length > 0) vscode.window.showErrorMessage(`${erros.length} erro(s): ${erros.join('; ')}`);
        await this._carregarSecao('containers');
    }

    private async _removerImagens(ids: string[]): Promise<void> {
        const ok = await vscode.window.showWarningMessage(
            `Remover ${ids.length} imagem(ns)? Esta ação não pode ser desfeita.`,
            { modal: true }, 'Remover',
        );
        if (ok !== 'Remover') { this._panel.webview.postMessage({ command: 'acaoCancelada' }); return; }
        const erros: string[] = [];
        await Promise.allSettled(ids.map(async id => {
            try { await this._imageSvc.remover(id); }
            catch (e) { erros.push(e instanceof Error ? e.message : String(e)); }
        }));
        if (erros.length > 0) vscode.window.showErrorMessage(`${erros.length} erro(s): ${erros.join('; ')}`);
        await this._carregarSecao('images');
    }

    private async _removerVolumes(ids: string[]): Promise<void> {
        const ok = await vscode.window.showWarningMessage(
            `Remover ${ids.length} volume(s)? Esta ação não pode ser desfeita.`,
            { modal: true }, 'Remover',
        );
        if (ok !== 'Remover') { this._panel.webview.postMessage({ command: 'acaoCancelada' }); return; }
        const erros: string[] = [];
        await Promise.allSettled(ids.map(async id => {
            try { await this._volumeSvc.remover(id); }
            catch (e) { erros.push(e instanceof Error ? e.message : String(e)); }
        }));
        if (erros.length > 0) vscode.window.showErrorMessage(`${erros.length} erro(s): ${erros.join('; ')}`);
        await this._carregarSecao('volumes');
    }

    private async _removerRedes(ids: string[]): Promise<void> {
        const ok = await vscode.window.showWarningMessage(
            `Remover ${ids.length} rede(s)? Esta ação não pode ser desfeita.`,
            { modal: true }, 'Remover',
        );
        if (ok !== 'Remover') { this._panel.webview.postMessage({ command: 'acaoCancelada' }); return; }
        const erros: string[] = [];
        await Promise.allSettled(ids.map(async id => {
            try { await this._networkSvc.remover(id); }
            catch (e) { erros.push(e instanceof Error ? e.message : String(e)); }
        }));
        if (erros.length > 0) vscode.window.showErrorMessage(`${erros.length} erro(s): ${erros.join('; ')}`);
        await this._carregarSecao('networks');
    }

    /**
     * Carrega dados completos de um container para o painel de detalhe inline.
     */
    private async _carregarDetalhe(id: string, navegarPara?: string): Promise<void> {
        try {
            const info = await this._containerSvc.inspecionar(id);
            const nome = (info.Name ?? '').replace(/^\//, '');

            // Mapeia port bindings
            const portas: Array<{ hospedeiro: string; container: string; protocolo: string }> = [];
            const pb = (info.HostConfig as Record<string, unknown>)?.PortBindings as Record<string, Array<{ HostIp: string; HostPort: string }>> ?? {};
            for (const [containerPort, bindings] of Object.entries(pb)) {
                if (!bindings) continue;
                const [portaNum, proto] = containerPort.split('/');
                for (const b of bindings) {
                    portas.push({ hospedeiro: `${b.HostIp || '0.0.0.0'}:${b.HostPort}`, container: portaNum, protocolo: proto ?? 'tcp' });
                }
            }

            // Mapeia redes
            const redes = Object.entries((info.NetworkSettings?.Networks ?? {}) as Record<string, Record<string, unknown>>).map(([nomR, net]) => ({
                nome: nomR,
                ip: (net['IPAddress'] as string) ?? '-',
                gateway: (net['Gateway'] as string) ?? '-',
                subnet: net['IPPrefixLen'] ? `${net['IPAddress'] as string}/${net['IPPrefixLen'] as number}` : '-',
            }));

            this._panel.webview.postMessage({
                command: 'dadosDetalheContainer',
                data: {
                    id: info.Id,
                    nome,
                    estado: info.State?.Status ?? 'unknown',
                    imagem: info.Config?.Image ?? '-',
                    comando: [...(info.Config?.Entrypoint ?? []), ...(info.Config?.Cmd ?? [])].join(' ') || '-',
                    criado: info.Created,
                    hostname: info.Config?.Hostname ?? '-',
                    restartPolicy: ((info.HostConfig as Record<string, unknown>)?.RestartPolicy as Record<string, unknown>)?.Name as string ?? 'no',
                    portas,
                    env: info.Config?.Env ?? [],
                    redes,
                    inspect: JSON.stringify(info, null, 2),
                },
                navegarPara: navegarPara ?? null,
            });
        } catch (err) {
            this._panel.webview.postMessage({
                command: 'dadosDetalheContainer',
                erro: err instanceof Error ? err.message : String(err),
            });
        }
    }

    /**
     * Converte sequências ANSI de cor para spans HTML coloridos.
     * Processado no TypeScript para não embutir bytes de controle no template HTML.
     */
    private static _ansiParaHtml(texto: string): string {
        const CORES: Record<string, string> = {
            '30': '#555555', '31': '#cc0000', '32': '#4e9a06', '33': '#c4a000',
            '34': '#3465a4', '35': '#75507b', '36': '#06989a', '37': '#d3d7cf',
            '90': '#888a85', '91': '#ef2929', '92': '#8ae234', '93': '#fce94f',
            '94': '#729fcf', '95': '#ad7fa8', '96': '#34e2e2', '97': '#eeeeec',
        };
        const escHtml = (s: string) =>
            s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        // eslint-disable-next-line no-control-regex
        const partes = texto.split(/\x1b\[([0-9;]*)m/);
        let resultado = '';
        let spanAberto = false;
        for (let i = 0; i < partes.length; i++) {
            if (i % 2 === 0) {
                resultado += escHtml(partes[i]);
            } else {
                if (spanAberto) { resultado += '</span>'; spanAberto = false; }
                if (partes[i] === '' || partes[i] === '0') { continue; }
                const codigos = partes[i].split(';');
                let estilo = '';
                let negrito = false;
                for (const cod of codigos) {
                    if (cod === '1') { negrito = true; }
                    else if (CORES[cod]) { estilo += `color:${CORES[cod]};`; }
                }
                if (negrito) { estilo += 'font-weight:bold;'; }
                if (estilo) { resultado += `<span style="${estilo}">`; spanAberto = true; }
            }
        }
        if (spanAberto) { resultado += '</span>'; }
        return resultado;
    }

    /**
     * Processa ações K8s vindas do webview (scale, restart, delete).
     */
    private async _acaoK8s(msg: MsgFromWebview): Promise<void> {
        try {
            const { DeploymentService } = await import('../services/deploymentService');
            const { StatefulSetService } = await import('../services/statefulSetService');
            const { PodService } = await import('../services/podService');
            const deplSvc = new DeploymentService();
            const ssSvc = new StatefulSetService();
            const podSvc = new PodService();

            switch (msg.acao) {
                case 'depl-scale': {
                    const replicas = parseInt(msg.valor ?? '1', 10);
                    if (isNaN(replicas) || replicas < 0) { return; }
                    if (replicas === 0) {
                        const ok = await vscode.window.showWarningMessage(
                            `Escalar "${msg.nome}" para 0 removerá todos os pods. Confirmar?`,
                            { modal: true }, 'Confirmar',
                        );
                        if (ok !== 'Confirmar') { return; }
                    }
                    await deplSvc.escalar(msg.namespace!, msg.nome!, replicas);
                    vscode.window.showInformationMessage(`Deployment "${msg.nome}" escalado para ${replicas} réplica(s).`);
                    break;
                }
                case 'depl-restart': {
                    // Confirma antes de reiniciar pois causa substituição dos pods
                    const confirmar = await vscode.window.showWarningMessage(
                        `Reiniciar "${msg.nome}"?\n\n`
                        + `O Kubernetes fará um rolling restart: cada pod será substituído por um novo gradualmente. `
                        + `Durante o processo você verá pods novos em status Pending/Running ao lado dos antigos — isso é esperado.`,
                        { modal: true },
                        'Reiniciar',
                    );
                    if (confirmar !== 'Reiniciar') { return; }
                    await deplSvc.reiniciarRollout(msg.namespace!, msg.nome!);
                    vscode.window.showInformationMessage(
                        `Rolling restart iniciado para "${msg.nome}". Os pods serão substituídos gradualmente — acompanhe o status na lista de Pods.`,
                    );
                    break;
                }

                case 'depl-delete': {
                    const ok = await vscode.window.showWarningMessage(
                        `Deletar deployment "${msg.nome}"? Todos os pods gerenciados serão removidos.`,
                        { modal: true }, 'Deletar',
                    );
                    if (ok !== 'Deletar') { return; }
                    await deplSvc.deletar(msg.namespace!, msg.nome!);
                    vscode.window.showInformationMessage(`Deployment "${msg.nome}" deletado.`);
                    break;
                }
                case 'ss-scale': {
                    const replicas = parseInt(msg.valor ?? '1', 10);
                    if (isNaN(replicas) || replicas < 0) { return; }
                    await ssSvc.escalar(msg.namespace!, msg.nome!, replicas);
                    vscode.window.showInformationMessage(`StatefulSet "${msg.nome}" escalado para ${replicas} réplica(s).`);
                    break;
                }
                case 'ss-delete': {
                    const ok = await vscode.window.showWarningMessage(
                        `Deletar StatefulSet "${msg.nome}"?`,
                        { modal: true }, 'Deletar',
                    );
                    if (ok !== 'Deletar') { return; }
                    await ssSvc.deletar(msg.namespace!, msg.nome!);
                    vscode.window.showInformationMessage(`StatefulSet "${msg.nome}" deletado.`);
                    break;
                }
                case 'pod-delete': {
                    // Verifica se o pod pertence a um Deployment, seguindo a cadeia:
                    // Pod → ownerRef(ReplicaSet) → ownerRef(Deployment)
                    // Se sim, oferece escalar -1 réplica (remoção permanente) ou apenas deletar.
                    const { KubernetesClient } = await import('../kubernetes/kubernetesClient');
                    const k8sClient = KubernetesClient.getInstance();
                    const coreApi = k8sClient.getCoreApi();
                    const appsApi = k8sClient.getAppsApi();

                    let deplDono: string | null = null;
                    let deplReplicasAtuais = 0;

                    try {
                        const pod = await coreApi.readNamespacedPod({ name: msg.nome!, namespace: msg.namespace! });
                        const rsOwner = (pod.metadata?.ownerReferences ?? []).find(o => o.kind === 'ReplicaSet');
                        if (rsOwner) {
                            const rs = await appsApi.readNamespacedReplicaSet({ name: rsOwner.name, namespace: msg.namespace! });
                            const deplOwner = (rs.metadata?.ownerReferences ?? []).find(o => o.kind === 'Deployment');
                            if (deplOwner) {
                                const depl = await appsApi.readNamespacedDeployment({ name: deplOwner.name, namespace: msg.namespace! });
                                deplDono = deplOwner.name;
                                deplReplicasAtuais = depl.spec?.replicas ?? 0;
                            }
                        }
                    } catch { /* lookup falhou — trata como pod independente */ }

                    if (deplDono && deplReplicasAtuais > 0) {
                        // Pod pertence a um Deployment: oferece escalar -1 ou apenas deletar
                        const opcaoEscalar  = `Escalar "${deplDono}" para ${deplReplicasAtuais - 1} réplica(s)`;
                        const opcaoDeletar  = 'Apenas deletar o pod (será recriado)';
                        const escolha = await vscode.window.showWarningMessage(
                            `O pod "${msg.nome}" é gerenciado pelo Deployment "${deplDono}" `
                            + `(${deplReplicasAtuais} réplica(s)). `
                            + `Deletar o pod apenas fará o Kubernetes recriar outro.`,
                            { modal: true },
                            opcaoEscalar,
                            opcaoDeletar,
                        );
                        if (!escolha) { return; }
                        if (escolha === opcaoEscalar) {
                            await deplSvc.escalar(msg.namespace!, deplDono, deplReplicasAtuais - 1);
                            vscode.window.showInformationMessage(
                                `Deployment "${deplDono}" escalado para ${deplReplicasAtuais - 1} réplica(s).`,
                            );
                        } else {
                            await podSvc.deletar(msg.namespace!, msg.nome!);
                            vscode.window.showInformationMessage(
                                `Pod "${msg.nome}" deletado — o Deployment "${deplDono}" criará um substituto.`,
                            );
                        }
                    } else {
                        // Pod independente (DaemonSet, Job, standalone) — deleta diretamente
                        const ok = await vscode.window.showWarningMessage(
                            `Deletar pod "${msg.nome}"?`,
                            { modal: true }, 'Deletar',
                        );
                        if (ok !== 'Deletar') { return; }
                        await podSvc.deletar(msg.namespace!, msg.nome!);
                        vscode.window.showInformationMessage(`Pod "${msg.nome}" deletado.`);
                    }
                    break;
                }
                case 'pod-shell':
                    await podSvc.exec(msg.namespace!, msg.nome!);
                    return;
            }
            // Recarrega imediatamente para refletir o estado pós-ação
            await this._carregarSecaoKubernetes();
            // Kubernetes pode levar alguns segundos para processar a mudança (criar/deletar pods,
            // atualizar status do Deployment, etc.). Recarregamos mais duas vezes para que o
            // usuário veja a transição sem precisar clicar em "Atualizar" manualmente.
            setTimeout(() => { if (!this._disposto) { void this._carregarSecaoKubernetes(); } }, 3000);
            setTimeout(() => { if (!this._disposto) { void this._carregarSecaoKubernetes(); } }, 7000);
        } catch (err) {
            vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * Carrega dados detalhados de um pod para exibição no painel.
     */
    private async _carregarPodDetalhe(nome: string, namespace: string): Promise<void> {
        try {
            const { PodService } = await import('../services/podService');
            const svc = new PodService();
            const { KubernetesClient } = await import('../kubernetes/kubernetesClient');
            const client = KubernetesClient.getInstance();
            const api = client.getCoreApi();
            const pod = await api.readNamespacedPod({ name: nome, namespace });

            const containers = (pod.spec?.containers ?? []).map(c => {
                const cs = (pod.status?.containerStatuses ?? []).find(s => s.name === c.name);
                let estado = 'unknown';
                let motivo = '';
                if (cs?.state?.running) { estado = 'running'; }
                else if (cs?.state?.waiting) { estado = 'waiting'; motivo = cs.state.waiting.reason ?? ''; }
                else if (cs?.state?.terminated) { estado = 'terminated'; motivo = cs.state.terminated.reason ?? ''; }
                return {
                    nome: c.name,
                    imagem: c.image ?? '',
                    pronto: cs?.ready ?? false,
                    restarts: cs?.restartCount ?? 0,
                    estado,
                    motivo,
                    portas: (c.ports ?? []).map(p => `${p.containerPort}/${p.protocol ?? 'TCP'}`).join(', '),
                };
            });

            const conditions = (pod.status?.conditions ?? []).map(c => ({
                tipo: c.type ?? '',
                status: c.status ?? '',
                motivo: c.reason ?? '',
            }));

            const ownerRef = (pod.metadata?.ownerReferences ?? [])[0];

            this._panel.webview.postMessage({
                command: 'dadosPodDetalhe',
                data: {
                    nome: pod.metadata?.name ?? nome,
                    namespace: pod.metadata?.namespace ?? namespace,
                    status: pod.status?.phase ?? 'Unknown',
                    ip: pod.status?.podIP ?? '-',
                    nodeName: pod.spec?.nodeName ?? '-',
                    criado: pod.metadata?.creationTimestamp?.toISOString() ?? null,
                    ownerKind: ownerRef?.kind ?? '-',
                    ownerNome: ownerRef?.name ?? '-',
                    containers,
                    conditions,
                    labels: pod.metadata?.labels ?? {},
                    yaml: JSON.stringify(pod, null, 2),
                },
            });
            // Pré-carregar logs
            try {
                const raw = await svc.obterLogs(namespace, nome);
                this._panel.webview.postMessage({
                    command: 'dadosPodLogs',
                    data: MainPanel._ansiParaHtml(raw),
                });
            } catch { /* logs serão carregados ao abrir aba */ }
        } catch (err) {
            this._panel.webview.postMessage({
                command: 'dadosPodDetalhe',
                erro: err instanceof Error ? err.message : String(err),
            });
        }
    }

    /**
     * Carrega o grafo de topologia de serviços do namespace ativo.
     * Nós: Services, Deployments/StatefulSets, Ingresses (externos).
     * Arestas inferidas de: label selectors (Service→workload) + env vars de containers.
     */
    private async _carregarTopologia(): Promise<void> {
        try {
            const { KubernetesClient } = await import('../kubernetes/kubernetesClient');
            const { KubernetesServiceService } = await import('../services/kubernetesServiceService');
            const { DeploymentService } = await import('../services/deploymentService');
            const { StatefulSetService } = await import('../services/statefulSetService');

            const client = KubernetesClient.getInstance();
            const ns = client.getNamespaceAtivo();
            const coreApi = client.getCoreApi();
            const appsApi = client.getAppsApi();

            // Busca dados em paralelo
            const [rawPods, rawServices, deployments, statefulsets] = await Promise.all([
                coreApi.listNamespacedPod({ namespace: ns }).then(r => r.items ?? []).catch(() => []),
                new KubernetesServiceService().listar(ns).catch(() => []),
                new DeploymentService().listar(ns).catch(() => []),
                new StatefulSetService().listar(ns).catch(() => []),
            ]);

            // Verifica se há Ingresses
            let ingressNomes: string[] = [];
            try {
                const netApi = client.getKubeConfig().makeApiClient((await import('@kubernetes/client-node')).NetworkingV1Api);
                const ingList = await (netApi as unknown as { listNamespacedIngress(p: { namespace: string }): Promise<{ items: Array<{ metadata?: { name?: string }; spec?: { rules?: Array<{ host?: string }> } }> }> })
                    .listNamespacedIngress({ namespace: ns });
                ingressNomes = (ingList.items ?? []).map(i => i.metadata?.name ?? '').filter(Boolean);
            } catch { /* Ingress não disponível */ }

            // ── Construção dos nós ───────────────────────────────────────────

            interface TopoNode {
                id: string;
                label: string;
                tipo: 'service' | 'deployment' | 'statefulset' | 'external' | 'ingress';
                status?: string;
                replicas?: string;
            }
            interface TopoEdge {
                from: string;
                to: string;
                label?: string;
            }

            const nodes: TopoNode[] = [];
            const edges: TopoEdge[] = [];
            const nodeIds = new Set<string>();

            const addNode = (n: TopoNode): void => {
                if (!nodeIds.has(n.id)) { nodes.push(n); nodeIds.add(n.id); }
            };
            const addEdge = (from: string, to: string, label?: string): void => {
                if (from !== to && nodeIds.has(from) && nodeIds.has(to)) {
                    const dup = edges.some(e => e.from === from && e.to === to);
                    if (!dup) edges.push({ from, to, label });
                }
            };

            // Services
            for (const svc of rawServices) {
                addNode({ id: `svc:${svc.nome}`, label: svc.nome, tipo: 'service' });
            }

            // Deployments
            for (const d of deployments) {
                const status = d.replicasProntas >= d.replicasDesejadas && d.replicasDesejadas > 0 ? 'ready' : 'pending';
                addNode({
                    id: `depl:${d.nome}`,
                    label: d.nome,
                    tipo: 'deployment',
                    status,
                    replicas: `${d.replicasProntas}/${d.replicasDesejadas}`,
                });
            }

            // StatefulSets
            for (const ss of statefulsets) {
                addNode({
                    id: `ss:${ss.nome}`,
                    label: ss.nome,
                    tipo: 'statefulset',
                    replicas: `${ss.replicasProntas}/${ss.replicasDesejadas}`,
                });
            }

            // Ingresses como nó externo
            for (const ing of ingressNomes) {
                addNode({ id: `ing:${ing}`, label: ing, tipo: 'ingress' });
            }

            // ── Arestas por label selector: Service → Workload ───────────────
            // Um Service seleciona pods; rastreamos até o Deployment/SS dono
            for (const svc of rawServices) {
                if (Object.keys(svc.selector).length === 0) { continue; }
                // Encontra pods que satisfazem o selector
                const svcId = `svc:${svc.nome}`;
                for (const pod of rawPods) {
                    const podLabels = pod.metadata?.labels ?? {};
                    const match = Object.entries(svc.selector).every(([k, v]) => podLabels[k] === v);
                    if (!match) { continue; }
                    // Sobe a cadeia: Pod → ReplicaSet/SS → Deployment/SS
                    const owner = (pod.metadata?.ownerReferences ?? [])[0];
                    if (owner?.kind === 'ReplicaSet') {
                        // Encontra o Deployment dono do RS
                        const rsOwnerName = owner.name;
                        // O padrão do nome do RS é <depl>-<hash>, mas usamos a lista de deployments
                        const depl = deployments.find(d => rsOwnerName.startsWith(d.nome + '-'));
                        if (depl) {
                            addEdge(svcId, `depl:${depl.nome}`);
                            break; // Um service → um workload é suficiente
                        }
                    } else if (owner?.kind === 'StatefulSet') {
                        addEdge(svcId, `ss:${owner.name}`);
                        break;
                    }
                }
            }

            // ── Arestas por env vars: Workload → Service ─────────────────────
            // K8s injeta automaticamente <SERVICE>_SERVICE_HOST para todos os services.
            // Detectamos env vars definidas PELO USUÁRIO (não geradas pelo K8s) que
            // referenciam nomes de serviços — heurística: value contém exatamente o nome do service.
            const svcNomes = new Set(rawServices.map(s => s.nome));
            const k8sAutoEnvPrefixes = new Set(rawServices.map(s => s.nome.toUpperCase().replace(/-/g, '_')));

            for (const pod of rawPods) {
                // Identifica workload dono do pod
                const owner = (pod.metadata?.ownerReferences ?? [])[0];
                let workloadId: string | null = null;
                if (owner?.kind === 'ReplicaSet') {
                    const depl = deployments.find(d => owner.name.startsWith(d.nome + '-'));
                    if (depl) workloadId = `depl:${depl.nome}`;
                } else if (owner?.kind === 'StatefulSet') {
                    workloadId = `ss:${owner.name}`;
                }
                if (!workloadId) { continue; }

                for (const container of pod.spec?.containers ?? []) {
                    for (const env of container.env ?? []) {
                        const val = env.value ?? '';
                        // Ignora env vars injetadas automaticamente pelo K8s
                        const prefix = env.name.toUpperCase().replace(/-/g, '_');
                        const isAutoInjected = [...k8sAutoEnvPrefixes].some(p =>
                            prefix.startsWith(p + '_SERVICE_') || prefix.startsWith(p + '_PORT'),
                        );
                        if (isAutoInjected) { continue; }
                        // Se o valor contém exatamente um nome de service → cria aresta
                        for (const svcNome of svcNomes) {
                            if (val === svcNome || val.includes(svcNome + '.') || val.includes(svcNome + ':')) {
                                addEdge(workloadId, `svc:${svcNome}`, env.name);
                            }
                        }
                    }
                }
            }

            // ── Remove nós órfãos (sem nenhuma aresta) exceto se houver ≤5 nós ─
            if (nodes.length > 5) {
                const connected = new Set(edges.flatMap(e => [e.from, e.to]));
                const filtered = nodes.filter(n => connected.has(n.id));
                // Mantém pelo menos os que têm arestas; se todos forem órfãos, mantém tudo
                if (filtered.length > 0) {
                    nodes.splice(0, nodes.length, ...filtered);
                }
            }

            this._panel.webview.postMessage({
                command: 'dadosTopologia',
                namespace: ns,
                nodes,
                edges,
            });
        } catch (err) {
            this._panel.webview.postMessage({
                command: 'dadosTopologia',
                erro: err instanceof Error ? err.message : String(err),
            });
        }
    }

    private _gerarHtml(): string {
        const nonce = gerarNonce();
        const settings = this._globalState.get<{ fontSize: number; density: string }>(
            'dockerManager.settings',
            { fontSize: 13, density: 'normal' },
        );
        const csp = [
            `default-src 'none'`,
            `style-src 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
        ].join('; ');

        return /* html */`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Docker Manager</title>
<style>
:root {
    --bg-deep:   #0B1220;
    --bg-dark:   #0F172A;
    --panel:     rgba(255,255,255,0.05);
    --borda:     rgba(255,255,255,0.08);
    --cyan:      #00F7FF;
    --purple:    #7C3AED;
    --pink:      #FF2DAA;
    --green:     #00FF88;
    --muted:     rgba(255,255,255,0.45);
    --text:      #e2e8f0;
    --ok:        #00FF88;
    --parado:    #FF2DAA;
    --paused:    #f59e0b;
    --hover:     rgba(255,255,255,0.06);
    --sel:       rgba(0,247,255,0.1);
    --font-mono: 'JetBrains Mono','Fira Code',ui-monospace,monospace;
    --font-base: 13px;
    --row-pad:   8px 12px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg-deep); color: var(--text); font-family: 'Inter',system-ui,sans-serif; font-size: var(--font-base, 13px); padding: 0; overflow: hidden; }
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: var(--bg-dark); }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--cyan); }

/* ── Layout ────────────────────────────────────── */
.layout { display: flex; width: 100vw; height: 100vh; }
.sidebar { width: 200px; min-width: 200px; background: #06101B; border-right: 1px solid rgba(255,255,255,0.06); display: flex; flex-direction: column; overflow-y: auto; flex-shrink: 0; }
.sidebar-logo { padding: 18px 16px 16px; border-bottom: 1px solid rgba(255,255,255,0.06); display: flex; align-items: center; gap: 10px; }
.logo-icon { font-size: 1.5em; }
.logo-text { font-size: 0.68em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--cyan); font-family: var(--font-mono); line-height: 1.3; text-shadow: 0 0 12px rgba(0,247,255,0.4); }
.sidebar-nav { padding: 10px 0; flex: 1; }
.nav-item { display: flex; align-items: center; gap: 10px; padding: 9px 16px; cursor: pointer; color: var(--muted); font-size: 0.82em; font-family: var(--font-mono); letter-spacing: 0.03em; transition: color 0.15s, background 0.15s; border-left: 2px solid transparent; user-select: none; }
.nav-item:hover { color: var(--text); background: rgba(255,255,255,0.04); }
.nav-item.ativo { color: var(--cyan); border-left-color: var(--cyan); background: rgba(0,247,255,0.06); }
.nav-icon { font-size: 1em; width: 20px; text-align: center; flex-shrink: 0; }
.main-content { flex: 1; overflow-y: auto; padding: 20px; min-width: 0; }

/* ── Seções ──────────────────────────────────────── */
.secao { display: none; }
.secao.ativa { display: block; }
.sec-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--borda); }
.sec-titulo { font-size: 1.1em; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--cyan); text-shadow: 0 0 14px rgba(0,247,255,0.45); }
.btn-refresh { background: transparent; color: var(--cyan); border: 1px solid var(--cyan); border-radius: 4px; padding: 5px 14px; cursor: pointer; font-size: 0.78em; font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.05em; transition: background 0.15s, box-shadow 0.15s; }
.btn-refresh:hover { background: rgba(0,247,255,0.1); box-shadow: 0 0 12px rgba(0,247,255,0.3); }

/* ── Dashboard ───────────────────────────────────── */
.node-info { background: var(--panel); border: 1px solid var(--borda); border-radius: 8px; padding: 16px 20px; margin-bottom: 24px; backdrop-filter: blur(8px); }
.node-info h2 { font-size: 0.75em; color: var(--cyan); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 12px; font-family: var(--font-mono); }
.node-table { width: 100%; border-collapse: collapse; }
.node-table td { padding: 4px 12px 4px 0; vertical-align: top; }
.node-table td:first-child { color: var(--muted); width: 160px; font-size: 0.82em; font-family: var(--font-mono); }
.node-table td:last-child { font-family: var(--font-mono); font-size: 0.82em; color: var(--text); }
.cards-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(200px,1fr)); gap: 16px; }
.card { background: var(--panel); border: 1px solid var(--borda); border-radius: 8px; padding: 18px 20px; display: flex; align-items: center; gap: 16px; cursor: pointer; transition: border-color 0.2s,box-shadow 0.2s,transform 0.15s; backdrop-filter: blur(8px); }
.card:hover { border-color: var(--cyan); box-shadow: 0 0 20px rgba(0,247,255,0.18); transform: translateY(-2px); }
.card-icon { font-size: 1.8em; width: 48px; height: 48px; border-radius: 8px; background: rgba(0,247,255,0.1); border: 1px solid rgba(0,247,255,0.2); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.card-body { flex: 1; }
.card-numero { font-size: 2em; font-weight: 700; line-height: 1; color: var(--cyan); font-family: var(--font-mono); text-shadow: 0 0 12px rgba(0,247,255,0.4); }
.card-titulo { font-size: 0.82em; color: var(--muted); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.06em; }
.card-detalhe { font-size: 0.75em; margin-top: 6px; font-family: var(--font-mono); }
.running-txt { color: var(--ok); }
.stopped-txt { color: var(--parado); }
/* Cards Kubernetes — paleta roxa/violeta para distinguir do Docker */
.card.k8s { cursor: pointer; }
.card.k8s:hover { border-color: #7C3AED; box-shadow: 0 0 20px rgba(124,58,237,0.25); transform: translateY(-2px); }
.card.k8s .card-icon { background: rgba(124,58,237,0.12); border-color: rgba(124,58,237,0.3); }
.card.k8s .card-numero { color: #A78BFA; text-shadow: 0 0 12px rgba(167,139,250,0.4); }
.card.k8s.k8s-warn .card-icon { background: rgba(245,158,11,0.12); border-color: rgba(245,158,11,0.3); }
.card.k8s.k8s-warn .card-numero { color: #f59e0b; text-shadow: 0 0 12px rgba(245,158,11,0.4); }
.dash-separador { display: flex; align-items: center; gap: 10px; margin: 24px 0 16px; }
.dash-separador-linha { flex: 1; height: 1px; background: rgba(255,255,255,0.06); }
.dash-separador-texto { font-size: 0.68em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); white-space: nowrap; }
.dash-k8s-meta { font-size: 0.72em; color: var(--muted); margin-bottom: 14px; font-family: var(--font-mono); }
.dash-k8s-meta span { color: rgba(167,139,250,0.85); margin: 0 4px; }

/* ── Toolbar de Containers ───────────────────────── */
.toolbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.btn { padding: 5px 12px; border: 1px solid transparent; border-radius: 4px; cursor: pointer; font-size: 0.78em; font-family: var(--font-mono); font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; transition: box-shadow 0.15s, opacity 0.15s; }
.btn:hover:not(:disabled) { opacity: 0.85; }
.btn:disabled { opacity: 0.25; cursor: not-allowed; }
.btn-start   { color: var(--ok);     border-color: var(--ok);     background: rgba(0,255,136,0.08); }
.btn-stop    { color: var(--pink);   border-color: var(--pink);   background: rgba(255,45,170,0.08); }
.btn-kill    { color: #f87171;       border-color: #f87171;       background: rgba(248,113,113,0.08); }
.btn-restart { color: var(--cyan);   border-color: var(--cyan);   background: rgba(0,247,255,0.06); }
.btn-pause   { color: var(--paused); border-color: var(--paused); background: rgba(245,158,11,0.08); }
.btn-resume  { color: var(--paused); border-color: var(--paused); background: rgba(245,158,11,0.08); }
.btn-remove  { color: var(--pink);   border-color: rgba(255,45,170,0.5); background: rgba(255,45,170,0.08); }
.btn-refresh-c { color: var(--muted); border-color: var(--borda); background: transparent; }
.btn-refresh-c:hover:not(:disabled) { color: var(--cyan); border-color: var(--cyan); opacity: 1; }
.btn-start:hover:not(:disabled)   { box-shadow: 0 0 8px rgba(0,255,136,0.3); }
.btn-stop:hover:not(:disabled)    { box-shadow: 0 0 8px rgba(255,45,170,0.3); }
.btn-restart:hover:not(:disabled) { box-shadow: 0 0 8px rgba(0,247,255,0.3); }
.btn-remove:hover:not(:disabled)  { box-shadow: 0 0 8px rgba(255,45,170,0.3); }
.sel-count { font-size: 0.78em; color: var(--muted); font-family: var(--font-mono); margin-left: 4px; }

/* ── Busca / Filtro ──────────────────────────────── */
.busca-wrap { margin-bottom: 10px; }
.busca, .filtro { width: 100%; padding: 7px 12px; background: var(--panel); color: var(--text); border: 1px solid var(--borda); border-radius: 6px; font-family: var(--font-mono); font-size: 0.88em; outline: none; }
.busca::placeholder, .filtro::placeholder { color: var(--muted); }
.busca:focus, .filtro:focus { border-color: var(--cyan); box-shadow: 0 0 8px rgba(0,247,255,0.2); }
.toolbar-filtro { display: flex; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; align-items: center; }
.filtro { flex: 1; min-width: 200px; }

/* ── Tabela compartilhada ────────────────────────── */
.tabela-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.83em; }
thead th { background: var(--bg-dark); border-bottom: 1px solid var(--borda); padding: 8px 12px; text-align: left; font-weight: 600; color: var(--muted); font-family: var(--font-mono); font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; cursor: pointer; user-select: none; }
thead th.no-sort { cursor: default; }
td { padding: var(--row-pad, 8px 12px); border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: middle; }
tbody tr:hover { background: var(--hover); }
tbody tr.selecionado { background: var(--sel); }
input[type="checkbox"] { cursor: pointer; width: 14px; height: 14px; accent-color: var(--cyan); }

/* ── Badges ──────────────────────────────────────── */
.badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; font-family: var(--font-mono); }
.badge-running    { background: rgba(0,255,136,0.15);   color: var(--ok);     border: 1px solid rgba(0,255,136,0.3); }
.badge-exited     { background: rgba(255,45,170,0.15);  color: var(--pink);   border: 1px solid rgba(255,45,170,0.3); }
.badge-paused     { background: rgba(245,158,11,0.15);  color: var(--paused); border: 1px solid rgba(245,158,11,0.3); }
.badge-created    { background: rgba(124,58,237,0.15);  color: #a78bfa;       border: 1px solid rgba(124,58,237,0.3); }
.badge-restarting { background: rgba(0,247,255,0.12);   color: var(--cyan);   border: 1px solid rgba(0,247,255,0.3); }
.badge-dead       { background: rgba(100,100,100,0.2);  color: #888;          border: 1px solid #555; }
.badge-em-uso     { background: rgba(0,255,136,0.15);   color: var(--ok);     border: 1px solid rgba(0,255,136,0.3); }
.badge-nao-usado  { background: rgba(245,158,11,0.15);  color: var(--paused); border: 1px solid rgba(245,158,11,0.3); }
.badge-sistema    { background: rgba(124,58,237,0.2);   color: #a78bfa;       border: 1px solid rgba(124,58,237,0.35); }

/* ── Quick actions (containers) ──────────────────── */
.quick-actions { display: flex; gap: 4px; }
.qa-btn { background: transparent; color: var(--muted); border: 1px solid var(--borda); border-radius: 4px; padding: 3px 7px; cursor: pointer; font-size: 0.82em; transition: color 0.1s, border-color 0.1s; }
.qa-btn:hover { color: var(--cyan); border-color: var(--cyan); }
.nome-link { cursor: pointer; color: var(--cyan); text-decoration: none; }
.nome-link:hover { text-decoration: underline; }
.porta-link { color: var(--cyan); text-decoration: none; font-family: var(--font-mono); font-size: 0.88em; }
.porta-link:hover { text-decoration: underline; }

/* ── Barra de info (imagens/redes/volumes) ───────── */
.info-bar { background: rgba(0,247,255,0.06); border: 1px solid rgba(0,247,255,0.2); padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; font-family: var(--font-mono); font-size: 0.82em; }
.btn-remover { background: rgba(255,45,170,0.15); color: var(--pink); border: 1px solid var(--pink); border-radius: 4px; padding: 4px 12px; cursor: pointer; font-family: var(--font-mono); font-size: 0.78em; text-transform: uppercase; }
.btn-remover:hover { box-shadow: 0 0 10px rgba(255,45,170,0.3); }
.sel-label { display: flex; align-items: center; gap: 6px; font-size: 0.82em; color: var(--muted); cursor: pointer; font-family: var(--font-mono); }

/* ── Volumes — tabela expansível ─────────────────── */
.vol-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.vol-toolbar-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.vol-table-header { display: grid; grid-template-columns: 32px 28px 1fr 100px 90px 110px 130px; gap: 0; padding: 6px 12px; background: rgba(0,247,255,0.05); border: 1px solid var(--borda); border-radius: 6px 6px 0 0; font-size: 0.72em; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; font-family: var(--font-mono); }
.vol-col-chk, .vol-col-chevron { display: flex; align-items: center; justify-content: center; }
.vol-row { display: grid; grid-template-columns: 32px 28px 1fr 100px 90px 110px 130px; gap: 0; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.04); align-items: center; cursor: pointer; transition: background 0.15s; }
.vol-row:hover { background: rgba(0,247,255,0.04); }
.vol-row.aberto { background: rgba(0,247,255,0.06); }
.vol-chevron { display: inline-block; color: var(--muted); font-size: 0.75em; transition: transform 0.2s; user-select: none; }
.vol-row.aberto .vol-chevron { transform: rotate(90deg); color: var(--cyan); }
.vol-nome { font-family: var(--font-mono); font-size: 0.88em; color: var(--cyan); cursor: pointer; word-break: break-all; }
.vol-nome:hover { text-decoration: underline; }
.vol-detail { display: none; padding: 16px 20px; border-bottom: 2px solid rgba(0,247,255,0.15); background: rgba(0,247,255,0.025); }
.vol-detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 12px; }
.vol-detail-card { background: rgba(255,255,255,0.03); border: 1px solid var(--borda); border-radius: 6px; padding: 10px 14px; }
.vol-detail-label { font-size: 0.68em; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; font-family: var(--font-mono); margin-bottom: 4px; }
.vol-detail-val { font-size: 0.9em; color: var(--text); font-family: var(--font-mono); word-break: break-all; }
.vol-detail-val.cyan { color: var(--cyan); }
.vol-detail-val.green { color: var(--ok); }
.vol-detail-val.orange { color: var(--paused); }
.vol-disk-bar-wrap { margin-top: 10px; }
.vol-disk-bar-label { font-size: 0.72em; color: var(--muted); font-family: var(--font-mono); margin-bottom: 4px; display: flex; justify-content: space-between; }
.vol-disk-bar { height: 6px; background: rgba(255,255,255,0.08); border-radius: 3px; overflow: hidden; }
.vol-disk-bar-fill { height: 100%; background: linear-gradient(90deg, var(--cyan), #00a8aa); border-radius: 3px; transition: width 0.4s ease; }
.vol-disk-bar-fill.high { background: linear-gradient(90deg, var(--paused), #c85000); }
.vol-detail-row { display: flex; gap: 8px; align-items: flex-start; margin-top: 8px; font-size: 0.82em; color: var(--muted); font-family: var(--font-mono); flex-wrap: wrap; }
.vol-detail-row span { color: var(--text); }
.vol-mountpoint { font-family: var(--font-mono); font-size: 0.78em; color: var(--muted); background: rgba(255,255,255,0.03); border: 1px solid var(--borda); border-radius: 4px; padding: 6px 10px; margin-top: 8px; word-break: break-all; }
#v-lista { border: 1px solid var(--borda); border-radius: 6px; overflow: hidden; }

/* ── Estados de carregamento / erro ─────────────── */
.carregando, .vazia, .empty-state { text-align: center; padding: 40px 20px; color: var(--muted); font-family: var(--font-mono); }
.erro-msg { color: var(--pink); padding: 10px; font-family: var(--font-mono); border: 1px solid rgba(255,45,170,0.3); border-radius: 6px; background: rgba(255,45,170,0.06); margin-bottom: 12px; }
code { font-family: var(--font-mono); font-size: 0.82em; color: var(--muted); }

/* ── Tabs (Detalhe Container) ────────────────────── */
.tabs-nav { display: flex; gap: 2px; margin-bottom: 0; border-bottom: 1px solid var(--borda); }
.tab-btn { background: transparent; color: var(--muted); border: none; border-bottom: 2px solid transparent; padding: 8px 16px; cursor: pointer; font-family: var(--font-mono); font-size: 0.82em; text-transform: uppercase; letter-spacing: 0.04em; transition: color 0.15s, border-color 0.15s; margin-bottom: -1px; }
.tab-btn:hover { color: var(--text); }
.tab-btn.ativo { color: var(--cyan); border-bottom-color: var(--cyan); }
.tab-panel { display: none; padding: 16px 0; }
.tab-panel.ativo { display: block; }

/* ── Detalhe de Container ────────────────────────── */
.detail-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; padding-bottom: 12px; border-bottom: 1px solid var(--borda); }
.btn-back { background: transparent; color: var(--muted); border: 1px solid var(--borda); border-radius: 4px; padding: 5px 12px; cursor: pointer; font-family: var(--font-mono); font-size: 0.78em; transition: color 0.15s, border-color 0.15s; }
.btn-back:hover { color: var(--cyan); border-color: var(--cyan); }
.d-nome { font-size: 1em; font-weight: 700; color: var(--text); }
.d-actions { display: flex; gap: 8px; margin-left: auto; }
.btn-detail-action { background: rgba(0,247,255,0.08); color: var(--cyan); border: 1px solid var(--cyan); border-radius: 4px; padding: 5px 14px; cursor: pointer; font-family: var(--font-mono); font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.05em; transition: background 0.15s, box-shadow 0.15s; }
.btn-detail-action:hover { background: rgba(0,247,255,0.18); box-shadow: 0 0 12px rgba(0,247,255,0.3); }
.kv-table { width: 100%; border-collapse: collapse; font-size: 0.88em; margin-bottom: 12px; }
.kv-key { padding: 5px 16px 5px 0; color: var(--muted); width: 170px; font-family: var(--font-mono); font-size: 0.88em; vertical-align: top; white-space: nowrap; border-bottom: 1px solid rgba(255,255,255,0.03); }
.kv-val { padding: 5px 0; vertical-align: top; word-break: break-all; border-bottom: 1px solid rgba(255,255,255,0.03); }
.tab-subtitle { font-size: 0.75em; color: var(--cyan); text-transform: uppercase; letter-spacing: 0.08em; margin: 16px 0 8px; font-family: var(--font-mono); }
.inspect-json { font-family: var(--font-mono); font-size: 0.78em; color: var(--muted); white-space: pre-wrap; word-break: break-all; background: var(--bg-dark); padding: 16px; border-radius: 6px; border: 1px solid var(--borda); max-height: 60vh; overflow-y: auto; line-height: 1.5; }

/* ── Configura\u00e7\u00f5es ─────────────────────────────────── */
.settings-group { background: var(--panel); border: 1px solid var(--borda); border-radius: 8px; padding: 20px 24px; margin-bottom: 16px; backdrop-filter: blur(8px); }
.settings-group-title { font-size: 0.72em; color: var(--cyan); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 16px; font-family: var(--font-mono); }
.settings-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.04); gap: 16px; flex-wrap: wrap; }
.settings-row:last-child { border-bottom: none; padding-bottom: 0; }
.settings-label { font-size: 0.9em; color: var(--text); min-width: 160px; }
.settings-control { display: flex; align-items: center; gap: 10px; }
.settings-value { font-family: var(--font-mono); font-size: 0.85em; color: var(--cyan); min-width: 42px; text-align: right; }
input[type="range"] { accent-color: var(--cyan); cursor: pointer; width: 150px; }
.settings-select { background: var(--bg-dark); color: var(--text); border: 1px solid var(--borda); border-radius: 4px; padding: 5px 10px; font-family: var(--font-mono); font-size: 0.85em; outline: none; cursor: pointer; min-width: 160px; }
.settings-select:focus { border-color: var(--cyan); box-shadow: 0 0 6px rgba(0,247,255,0.2); }
select { color-scheme: dark; }
select option { background: #1a2233; color: #e2e8f0; }
.settings-preview { margin-top: 4px; padding: 14px 16px; background: rgba(0,247,255,0.04); border-radius: 6px; border: 1px solid rgba(0,247,255,0.12); color: var(--muted); line-height: 1.6; }

/* ── Monitor ─────────────────────────────────────────── */
.monitor-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 8px; }
.chart-card { background: var(--panel); border: 1px solid var(--borda); border-radius: 8px; padding: 14px 16px; min-width: 0; }
.chart-title { font-family: var(--font-mono); font-size: 0.7em; text-transform: uppercase; letter-spacing: 0.08em; color: var(--cyan); margin-bottom: 8px; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.chart-label { flex-shrink: 0; opacity: 0.75; }
.chart-val { color: var(--text); font-size: 1.1em; font-weight: 700; text-shadow: 0 0 10px rgba(0,247,255,0.4); text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 55%; }
canvas.chart { display: block; width: 100%; height: 130px; border-radius: 4px; background: #060F1C; }
.monitor-net { grid-column: 1 / -1; }
.monitor-net canvas.chart { height: 110px; }
.monitor-section { margin-top: 20px; }
.monitor-section-title { font-size: 0.72em; color: var(--cyan); text-transform: uppercase; letter-spacing: 0.1em; font-family: var(--font-mono); margin-bottom: 12px; padding-top: 14px; border-top: 1px solid var(--borda); }
.monitor-stopped { text-align: center; padding: 16px; color: var(--muted); font-family: var(--font-mono); font-size: 0.82em; background: var(--panel); border-radius: 6px; border: 1px solid var(--borda); }
/* ── Logs inline ─────────────────────────────────────── */
.logs-controls { display: flex; align-items: center; gap: 10px; padding: 8px 0 12px; border-bottom: 1px solid var(--borda); flex-wrap: wrap; }
.logs-label { font-size: 0.82em; color: var(--muted); font-family: var(--font-mono); white-space: nowrap; }
.logs-content { background: #050D18; border: 1px solid var(--borda); border-radius: 6px; padding: 12px 16px; font-family: var(--font-mono); font-size: 0.78em; line-height: 1.6; white-space: pre-wrap; word-break: break-all; overflow-y: auto; max-height: 62vh; color: rgba(255,255,255,0.55); margin-top: 10px; }
.btn-reload-logs { background: rgba(0,247,255,0.08); color: var(--cyan); border: 1px solid rgba(0,247,255,0.3); border-radius: 4px; padding: 4px 12px; cursor: pointer; font-family: var(--font-mono); font-size: 0.78em; transition: background 0.15s; }
.btn-reload-logs:hover { background: rgba(0,247,255,0.18); }
.k8s-tab-btn { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: var(--muted); border-radius: 5px; padding: 6px 16px; font-size: 0.8em; cursor: pointer; font-family: var(--font-mono); transition: all 0.15s; }
.k8s-tab-btn:hover { background: rgba(124,58,237,0.12); color: #A78BFA; border-color: rgba(124,58,237,0.3); }
.k8s-tab-btn.ativo { background: rgba(124,58,237,0.18); border-color: rgba(124,58,237,0.5); color: #A78BFA; font-weight: 600; }
/* Botões de ação rápida nas tabelas K8s */
.k8s-qa-btn { background: transparent; color: var(--muted); border: 1px solid var(--borda); border-radius: 4px; padding: 3px 7px; cursor: pointer; font-size: 0.82em; transition: color 0.1s, border-color 0.1s; }
.k8s-qa-btn:hover:not(:disabled) { color: #A78BFA; border-color: #7C3AED; }
.k8s-qa-btn.k8s-qa-del:hover:not(:disabled) { color: var(--pink); border-color: var(--pink); }
.k8s-qa-btn:disabled { opacity: 0.25; cursor: not-allowed; }
.k8s-pod-link { cursor: pointer; color: #A78BFA; font-family: var(--font-mono); font-size: 0.88em; }
.vol-cnt-link {
    background: none; border: none; padding: 0; margin: 0;
    color: var(--accent); font-family: var(--font-mono); font-size: 0.82em;
    cursor: pointer; text-decoration: underline; text-decoration-color: transparent;
    transition: text-decoration-color 0.15s, color 0.15s;
}
.vol-cnt-link:hover { color: var(--azul-claro, #60a5fa); text-decoration-color: currentColor; }
.k8s-pod-link:hover { text-decoration: underline; color: #c4b5fd; }
/* Kubernetes sidebar sub-menu */
.nav-group-header { display: flex; align-items: center; gap: 10px; padding: 9px 16px; cursor: pointer; color: var(--muted); font-size: 0.82em; font-family: var(--font-mono); letter-spacing: 0.03em; transition: color 0.15s, background 0.15s; border-left: 2px solid transparent; user-select: none; }
.nav-group-header:hover { color: var(--text); background: rgba(255,255,255,0.04); }
.nav-group-header.ativo { color: #A78BFA; border-left-color: #7C3AED; background: rgba(124,58,237,0.06); }
.nav-chevron { margin-left: auto; font-size: 0.62em; transition: transform 0.2s; opacity: 0.55; }
.nav-group.fechado .nav-chevron { transform: rotate(-90deg); }
.nav-group.fechado .nav-subitem { display: none; }
.nav-sub-icon { font-size: 0.82em; opacity: 0.7; }
.nav-subitem { display: flex; align-items: center; gap: 8px; padding: 6px 16px 6px 20px; cursor: pointer; color: var(--muted); font-size: 0.8em; transition: color 0.15s, background 0.15s; border-left: 2px solid transparent; }
.nav-subitem:hover { color: var(--text); background: rgba(255,255,255,0.04); }
.nav-subitem.ativo { color: #A78BFA; border-left-color: #7C3AED; background: rgba(124,58,237,0.08); }
.nav-divider { height: 1px; background: rgba(255,255,255,0.07); margin: 8px 0; }
.sidebar-k8s-logo { padding: 10px 16px 10px; display: flex; align-items: center; gap: 10px; cursor: pointer; transition: background 0.15s, opacity 0.2s; border-left: 3px solid transparent; }
.sidebar-k8s-logo:hover { background: rgba(124,58,237,0.08); }
.sidebar-k8s-logo.ativo { border-left-color: #7C3AED; background: rgba(124,58,237,0.1); }
.sidebar-k8s-logo.ativo .k8s-logo-text { color: #A78BFA; text-shadow: 0 0 12px rgba(167,139,250,0.4); }
/* Estado desabilitado: sem cluster acessível */
.sidebar-k8s-logo.k8s-desabilitado { cursor: default; opacity: 0.45; }
.sidebar-k8s-logo.k8s-desabilitado:hover { background: none; }
.sidebar-k8s-logo.k8s-desabilitado .k8s-logo-text { color: var(--muted); }
.sidebar-k8s-logo.k8s-desabilitado .k8s-logo-icon { filter: grayscale(1); }
.sidebar-k8s-logo.k8s-desabilitado .nav-chevron { display: none; }
/* Tooltip de status ao passar o mouse no estado desabilitado */
.k8s-status-hint { font-size: 0.65em; color: var(--muted); margin-top: 2px; line-height: 1.3; display: none; }
.sidebar-k8s-logo.k8s-desabilitado .k8s-status-hint { display: block; }
.k8s-logo-icon { font-size: 1.5em; }
.k8s-logo-text { font-size: 0.68em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #7C3AED; font-family: var(--font-mono); line-height: 1.3; flex: 1; }
.nav-group.fechado .nav-subitem { display: none; }
.nav-group.fechado + .nav-divider { display: none; }
${CSS_K8S}
</style>
</head>
<body>
<div class="layout">
<aside class="sidebar">
    <div class="sidebar-logo">
        <span class="logo-icon">&#128051;</span>
        <div class="logo-text">Docker<br>Manager</div>
    </div>
    <nav class="sidebar-nav">
        <div class="nav-item" data-secao="dashboard"><span class="nav-icon">&#128202;</span>Dashboard</div>
        <div class="nav-item" data-secao="containers"><span class="nav-icon">&#128230;</span>Containers</div>
        <div class="nav-item" data-secao="images"><span class="nav-icon">&#128190;</span>Imagens</div>
        <div class="nav-item" data-secao="networks"><span class="nav-icon">&#128279;</span>Redes</div>
        <div class="nav-item" data-secao="volumes"><span class="nav-icon">&#128452;</span>Volumes</div>
        <div class="nav-divider"></div>
        <div class="sidebar-k8s-logo k8s-desabilitado" id="k8s-brand-header">
            <span class="k8s-logo-icon">&#9096;</span>
            <div class="k8s-logo-text">Kubernetes<br>Manager
                <span class="k8s-status-hint" id="k8s-status-hint">Verificando...</span>
            </div>
            <span class="nav-chevron" id="k8s-chevron" style="transform:rotate(-90deg)">&#9660;</span>
        </div>
        <div class="nav-group fechado" id="k8s-nav-group">
            <div class="nav-subitem" data-k8s-aba="cluster"><span class="nav-sub-icon">&#128202;</span>Dashboard</div>
            <div class="nav-subitem" data-k8s-aba="namespaces"><span class="nav-sub-icon">&#127991;</span>Namespaces</div>
            <div class="nav-subitem" data-k8s-aba="workloads"><span class="nav-sub-icon">&#128230;</span>Aplica&#231;&#245;es</div>
            <div class="nav-subitem" data-k8s-aba="networking"><span class="nav-sub-icon">&#128279;</span>Servi&#231;os</div>
            <div class="nav-subitem" data-k8s-aba="config"><span class="nav-sub-icon">&#128214;</span>ConfigMaps &amp; Secrets</div>
            <div class="nav-subitem" data-k8s-aba="storage"><span class="nav-sub-icon">&#128452;</span>Volumes</div>
            <div class="nav-subitem" data-k8s-aba="nodes"><span class="nav-sub-icon">&#127760;</span>Cluster</div>
        </div>
        <div class="nav-divider"></div>
        <div class="nav-item" data-secao="settings"><span class="nav-icon">&#9881;</span>Configura&#231;&#245;es</div>
    </nav>
</aside>
<div class="main-content" id="main-content">

    <!-- ══ DASHBOARD ══════════════════════════════════════════ -->
    <div id="sec-dashboard" class="secao">
        <div class="sec-header">
            <span class="sec-titulo">&#127919; Dashboard</span>
            <button class="btn-refresh" id="dash-refresh">&#8635; Atualizar</button>
        </div>
        <div id="dash-node" class="node-info" style="display:none">
            <h2>&#9881; Node Info</h2>
            <table class="node-table" id="dash-node-table"></table>
        </div>
        <div id="dash-cards" class="cards-grid" style="display:none">
            <div class="card" data-goto="containers">
                <div class="card-icon">&#128230;</div>
                <div class="card-body">
                    <div class="card-numero" id="dash-cnt-total">-</div>
                    <div class="card-titulo">Containers</div>
                    <div class="card-detalhe" id="dash-cnt-detalhe"></div>
                </div>
            </div>
            <div class="card" data-goto="images">
                <div class="card-icon">&#128190;</div>
                <div class="card-body">
                    <div class="card-numero" id="dash-img-total">-</div>
                    <div class="card-titulo">Imagens</div>
                    <div class="card-detalhe" id="dash-img-detalhe"></div>
                </div>
            </div>
            <div class="card" data-goto="volumes">
                <div class="card-icon">&#128452;</div>
                <div class="card-body">
                    <div class="card-numero" id="dash-vol-total">-</div>
                    <div class="card-titulo">Volumes</div>
                </div>
            </div>
            <div class="card" data-goto="networks">
                <div class="card-icon">&#128279;</div>
                <div class="card-body">
                    <div class="card-numero" id="dash-net-total">-</div>
                    <div class="card-titulo">Redes</div>
                </div>
            </div>
        </div>
        <div id="dash-loading" class="carregando">Carregando dados do Docker...</div>
        <div id="dash-erro" class="erro-msg" style="display:none"></div>
    </div>

    <!-- ══ CONTAINERS ═════════════════════════════════════════ -->
    <div id="sec-containers" class="secao">
        <div class="sec-header">
            <span class="sec-titulo">&#128230; Containers</span>
        </div>
        <div class="toolbar" id="c-toolbar">
            <button class="btn btn-start"     data-acao="start"   disabled>&#9654; Start</button>
            <button class="btn btn-stop"      data-acao="stop"    disabled>&#9632; Stop</button>
            <button class="btn btn-kill"      data-acao="kill"    disabled>&#9760; Kill</button>
            <button class="btn btn-restart"   data-acao="restart" disabled>&#8635; Restart</button>
            <button class="btn btn-pause"     data-acao="pause"   disabled>&#9646;&#9646; Pause</button>
            <button class="btn btn-resume"    data-acao="resume"  disabled>&#9654;&#9654; Resume</button>
            <button class="btn btn-remove"    data-acao="remove"  disabled>&#128465; Remove</button>
            <span class="sel-count" id="c-sel-count"></span>
            <button class="btn btn-refresh-c" id="c-refresh">&#8635; Atualizar</button>
        </div>
        <div class="busca-wrap">
            <input class="busca" type="text" id="c-busca" placeholder="Buscar por nome, imagem ou estado..." />
        </div>
        <div id="c-loading" class="carregando">Carregando containers...</div>
        <div id="c-erro" class="erro-msg" style="display:none"></div>
        <div class="tabela-wrap" id="c-tabela-wrap" style="display:none">
            <table>
                <thead>
                    <tr>
                        <th class="no-sort" style="width:36px"><input type="checkbox" id="c-check-all" /></th>
                        <th data-col="nome">Nome <span class="sort-arrow"></span></th>
                        <th data-col="estado" style="width:110px">Estado <span class="sort-arrow"></span></th>
                        <th data-col="imagem">Imagem <span class="sort-arrow"></span></th>
                        <th data-col="criado">Criado em <span class="sort-arrow"></span></th>
                        <th data-col="ip" style="width:120px">IP <span class="sort-arrow"></span></th>
                        <th>Portas</th>
                        <th class="no-sort" style="width:80px">A&#231;&#245;es</th>
                    </tr>
                </thead>
                <tbody id="c-tbody"></tbody>
            </table>
            <p class="vazia" id="c-vazia" style="display:none">Nenhum container encontrado.</p>
        </div>
    </div>

    <!-- ══ IMAGENS ════════════════════════════════════════════ -->
    <div id="sec-images" class="secao">
        <div class="sec-header">
            <span class="sec-titulo">&#128190; Imagens</span>
        </div>
        <div class="toolbar-filtro">
            <input type="text" id="i-filtro" class="filtro" placeholder="Filtrar por tag...">
            <label class="sel-label"><input type="checkbox" id="i-sel-todos"> Selecionar todos</label>
        </div>
        <div id="i-info-bar" class="info-bar" style="display:none">
            <span id="i-info-texto"></span>
            <button id="i-btn-remover" class="btn-remover">&#128465; Remover selecionadas</button>
        </div>
        <div id="i-loading" class="carregando">Carregando imagens...</div>
        <div id="i-erro" class="erro-msg" style="display:none"></div>
        <table id="i-tabela" style="display:none">
            <thead><tr>
                <th class="no-sort" style="width:40px"></th>
                <th>Tag</th><th>Status</th><th>Tamanho</th><th>Criada</th>
            </tr></thead>
            <tbody id="i-tbody"></tbody>
        </table>
    </div>

    <!-- ══ REDES ══════════════════════════════════════════════ -->
    <div id="sec-networks" class="secao">
        <div class="sec-header">
            <span class="sec-titulo">&#128279; Redes</span>
        </div>
        <div class="toolbar-filtro">
            <input type="text" id="n-filtro" class="filtro" placeholder="Filtrar por nome...">
            <label class="sel-label"><input type="checkbox" id="n-sel-todos"> Selecionar todos</label>
        </div>
        <div id="n-info-bar" class="info-bar" style="display:none">
            <span id="n-info-texto"></span>
            <button id="n-btn-remover" class="btn-remover">&#128465; Remover selecionadas</button>
        </div>
        <div id="n-loading" class="carregando">Carregando redes...</div>
        <div id="n-erro" class="erro-msg" style="display:none"></div>
        <table id="n-tabela" style="display:none">
            <thead><tr>
                <th class="no-sort" style="width:40px"></th>
                <th>Nome</th><th>Driver</th><th>Escopo</th>
                <th>Subnet</th><th>Gateway</th><th>IPAM Driver</th><th>Containers</th>
            </tr></thead>
            <tbody id="n-tbody"></tbody>
        </table>
    </div>

    <!-- ══ VOLUMES ════════════════════════════════════════════ -->
    <div id="sec-volumes" class="secao">
        <div class="sec-header">
            <span class="sec-titulo">&#128452; Volumes</span>
            <button class="btn-refresh" id="v-refresh">&#8635; Atualizar</button>
        </div>
        <div class="vol-toolbar">
            <input type="text" id="v-filtro" class="filtro" placeholder="Filtrar por nome...">
            <div class="vol-toolbar-actions">
                <label class="sel-label"><input type="checkbox" id="v-sel-todos"> Selecionar todos</label>
                <div id="v-info-bar" class="info-bar" style="display:none">
                    <span id="v-info-texto"></span>
                    <button id="v-btn-remover" class="btn-remover">&#128465; Remover selecionados</button>
                </div>
            </div>
        </div>
        <div id="v-loading" class="carregando">Carregando volumes...</div>
        <div id="v-erro" class="erro-msg" style="display:none"></div>
        <div id="v-lista" style="display:none">
            <div class="vol-table-header">
                <div class="vol-col-chk"></div>
                <div class="vol-col-chevron"></div>
                <div class="vol-col-nome">Nome</div>
                <div class="vol-col-status">Status</div>
                <div class="vol-col-driver">Driver</div>
                <div class="vol-col-tamanho">Tamanho</div>
                <div class="vol-col-criado">Criado</div>
            </div>
            <div id="v-tbody"></div>
        </div>
        <div id="v-vazia" class="empty-state" style="display:none">Nenhum volume encontrado.</div>
    </div>

    <!-- ══ DETALHE CONTAINER ════════════════════════════════ -->
    <div id="sec-detail" class="secao">
        <div class="detail-header">
            <button class="btn-back" id="d-back">&#8592; Voltar para Containers</button>
            <span id="d-title"></span>
            <div class="d-actions" id="d-actions"></div>
        </div>
        <div id="d-loading" class="carregando">Carregando detalhes do container...</div>
        <div id="d-content" style="display:none">
            <div class="tabs-nav" id="d-tabs-nav">
                <button class="tab-btn ativo" data-tab="geral">Geral</button>
                <button class="tab-btn" data-tab="logs">&#128196; Logs</button>
                <button class="tab-btn" data-tab="portas">Portas</button>
                <button class="tab-btn" data-tab="env">Vari&#225;veis de Ambiente</button>
                <button class="tab-btn" data-tab="inspect">Inspect JSON</button>
            </div>
            <div id="d-tab-geral" class="tab-panel ativo">
                <div id="d-geral-info"></div>
                <div id="d-geral-monitor" class="monitor-section" style="display:none">
                    <div class="monitor-section-title">&#128200; Monitoramento ao Vivo</div>
                    <div class="monitor-grid">
                        <div class="chart-card">
                            <div class="chart-title">
                                <span class="chart-label">CPU ao Vivo</span>
                                <span class="chart-val" id="m-cpu-val">&mdash;</span>
                            </div>
                            <canvas id="m-cpu-canvas" class="chart"></canvas>
                        </div>
                        <div class="chart-card">
                            <div class="chart-title">
                                <span class="chart-label">Mem&#243;ria ao Vivo</span>
                                <span class="chart-val" id="m-mem-val">&mdash;</span>
                            </div>
                            <canvas id="m-mem-canvas" class="chart"></canvas>
                        </div>
                        <div class="chart-card monitor-net">
                            <div class="chart-title">
                                <span class="chart-label">Rede ao Vivo</span>
                                <span class="chart-val" id="m-net-val">&mdash;</span>
                            </div>
                            <canvas id="m-net-canvas" class="chart"></canvas>
                        </div>
                    </div>
                </div>
            </div>
            <div id="d-tab-logs" class="tab-panel">
                <div class="logs-controls">
                    <span class="logs-label">Auto-atualizar:</span>
                    <select id="l-auto-select" class="settings-select" style="width:auto;padding:4px 10px">
                        <option value="0">Desativado</option>
                        <option value="2000">2s</option>
                        <option value="5000">5s</option>
                        <option value="10000">10s</option>
                        <option value="30000">30s</option>
                        <option value="60000">1 min</option>
                    </select>
                    <button class="btn-reload-logs" id="l-refresh-btn">&#8635; Atualizar</button>
                </div>
                <div id="l-loading" class="carregando" style="display:none">Carregando logs...</div>
                <pre id="l-content" class="logs-content" style="opacity:0.5">Abra esta aba para carregar os logs do container.</pre>
            </div>
            <div id="d-tab-portas" class="tab-panel"></div>
            <div id="d-tab-env" class="tab-panel"></div>
            <div id="d-tab-inspect" class="tab-panel"></div>
        </div>
    </div>

    <!-- ══ KUBERNETES ══════════════════════════════════════════ -->
    <div id="sec-kubernetes" class="secao">
        <div class="sec-header">
            <span class="sec-titulo">&#9096; Kubernetes Manager</span>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                <div style="display:flex;align-items:center;gap:6px">
                    <label for="k8s-context-select" style="color:var(--muted);font-size:0.78em;white-space:nowrap">Cluster:</label>
                    <select id="k8s-context-select" title="Selecionar cluster" style="background:#1a2233;color:#e2e8f0;border:1px solid #2d3f5e;border-radius:6px;padding:3px 8px;font-size:0.82em;cursor:pointer;max-width:220px;outline:none;color-scheme:dark">
                        <option value="">Carregando...</option>
                    </select>
                </div>
                <div style="display:flex;align-items:center;gap:6px">
                    <label for="k8s-ns-select" style="color:var(--muted);font-size:0.78em;white-space:nowrap">Namespace:</label>
                    <select id="k8s-ns-select" title="Selecionar namespace" style="background:#1a2233;color:#e2e8f0;border:1px solid #2d3f5e;border-radius:6px;padding:3px 8px;font-size:0.82em;cursor:pointer;max-width:180px;outline:none;color-scheme:dark">
                        <option value="default">default</option>
                    </select>
                </div>
                <button class="btn-refresh" id="k8s-refresh">&#8635; Atualizar</button>
            </div>
        </div>
        <div id="k8s-loading" style="padding:32px;text-align:center;color:var(--muted)">Carregando...</div>
        <div id="k8s-erro" style="display:none;padding:24px;color:var(--pink)"></div>
        <div id="k8s-body" style="display:none">
            <div class="k8s-tab-bar" id="k8s-tabs" style="display:flex;gap:4px;margin-bottom:20px;flex-wrap:wrap">
                <button class="k8s-tab-btn ativo" data-aba="cluster">&#128202; Dashboard</button>
                <button class="k8s-tab-btn" data-aba="namespaces">&#127991; Namespaces</button>
                <button class="k8s-tab-btn" data-aba="workloads">&#128230; Aplica&#231;&#245;es</button>
                <button class="k8s-tab-btn" data-aba="networking">&#128279; Servi&#231;os</button>
                <button class="k8s-tab-btn" data-aba="config">&#128214; ConfigMaps &amp; Secrets</button>
                <button class="k8s-tab-btn" data-aba="storage">&#128452; Volumes</button>
                <button class="k8s-tab-btn" data-aba="nodes">&#127760; Cluster</button>
            </div>
            <div id="k8s-aba-cluster"></div>
            <div id="k8s-aba-namespaces" style="display:none"></div>
            <div id="k8s-aba-workloads" style="display:none"></div>
            <div id="k8s-aba-networking" style="display:none"></div>
            <div id="k8s-aba-storage" style="display:none"></div>
            <div id="k8s-aba-config" style="display:none"></div>
            <div id="k8s-aba-nodes" style="display:none"></div>
        </div>
    </div>

    <!-- ══ POD DETAIL ══════════════════════════════════════════ -->
    <div id="sec-pod-detail" class="secao">
        <div class="detail-header">
            <button class="btn-back" id="pd-back">&#8592; Voltar para Workloads</button>
            <span id="pd-title" style="font-weight:700;font-size:1em"></span>
            <span id="pd-status-badge" style="margin-left:8px"></span>
            <div class="d-actions" id="pd-actions"></div>
        </div>
        <div id="pd-loading" class="carregando">Carregando dados do pod...</div>
        <div id="pd-content" style="display:none">
            <div class="tabs-nav" id="pd-tabs-nav">
                <button class="tab-btn ativo" data-tab="geral">Geral</button>
                <button class="tab-btn" data-tab="logs">&#128196; Logs</button>
                <button class="tab-btn" data-tab="containers">Containers</button>
                <button class="tab-btn" data-tab="yaml">YAML</button>
            </div>
            <div id="pd-tab-geral" class="tab-panel ativo">
                <div id="pd-geral-info"></div>
                <div id="pd-monitor" class="monitor-section" style="margin-top:16px">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
                        <div class="monitor-section-title">&#128200; Monitoramento ao Vivo</div>
                        <span id="pd-monitor-status" style="font-size:0.75em;color:var(--muted)">Aguardando m&#233;tricas...</span>
                    </div>
                    <div class="monitor-grid">
                        <div class="chart-card">
                            <div class="chart-title">
                                <span class="chart-label">CPU ao Vivo</span>
                                <span class="chart-val" id="pd-cpu-val">&mdash;</span>
                            </div>
                            <canvas id="pd-cpu-canvas" class="chart"></canvas>
                        </div>
                        <div class="chart-card">
                            <div class="chart-title">
                                <span class="chart-label">Mem&#243;ria ao Vivo</span>
                                <span class="chart-val" id="pd-mem-val">&mdash;</span>
                            </div>
                            <canvas id="pd-mem-canvas" class="chart"></canvas>
                        </div>
                    </div>
                </div>
            </div>
            <div id="pd-tab-logs" class="tab-panel">
                <div class="logs-controls">
                    <span class="logs-label">Auto-atualizar:</span>
                    <select id="pd-auto-select" class="settings-select" style="width:auto;padding:4px 10px">
                        <option value="0">Desativado</option>
                        <option value="2000">2s</option>
                        <option value="5000">5s</option>
                        <option value="15000">15s</option>
                        <option value="30000">30s</option>
                        <option value="60000">1 min</option>
                    </select>
                    <button class="btn-reload-logs" id="pd-refresh-btn">&#8635; Atualizar</button>
                </div>
                <div id="pd-log-loading" class="carregando" style="display:none">Carregando logs...</div>
                <pre id="pd-log-content" class="logs-content" style="opacity:0.5;contain:content;min-height:120px">Abra esta aba para carregar os logs do pod.</pre>
            </div>
            <div id="pd-tab-containers" class="tab-panel"></div>
            <div id="pd-tab-yaml" class="tab-panel"></div>
        </div>
    </div>

    <!-- ══ SETTINGS ══════════════════════════════════════════ -->
    <div id="sec-settings" class="secao">
        <div class="sec-header">
            <span class="sec-titulo">&#9881; Configura&#231;&#245;es</span>
        </div>
        <div class="settings-group">
            <p class="settings-group-title">&#127794; Acessibilidade</p>
            <div class="settings-row">
                <label class="settings-label">Tamanho da fonte</label>
                <div class="settings-control">
                    <input type="range" id="s-font-size" min="11" max="20" step="1" value="13">
                    <span class="settings-value" id="s-font-size-val">13px</span>
                </div>
            </div>
            <div class="settings-row">
                <label class="settings-label">Densidade da tabela</label>
                <div class="settings-control">
                    <select id="s-density" class="settings-select">
                        <option value="compact">Compacto (menor espa\u00e7amento)</option>
                        <option value="normal" selected>Normal</option>
                        <option value="comfortable">Confort\u00e1vel (maior espa\u00e7amento)</option>
                    </select>
                </div>
            </div>
        </div>
        <div class="settings-preview" id="s-preview">
            Pr\u00e9-visualiza\u00e7\u00e3o: Este texto reflete o tamanho de fonte atual. Lorem ipsum dolor sit amet.
        </div>
    </div>

</div><!-- main-content -->
</div><!-- layout -->

<!-- ══ MODAL ESCALA ══════════════════════════════════════════════ -->
<div id="scale-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:9999;align-items:center;justify-content:center">
    <div style="background:var(--card);border:1px solid var(--border);border-radius:10px;padding:24px 28px;min-width:300px;max-width:420px;box-shadow:0 8px 32px rgba(0,0,0,0.5)">
        <div style="font-weight:700;font-size:1em;margin-bottom:6px">&#9651; Escalar</div>
        <div id="scale-subtitle" style="color:var(--muted);font-size:0.82em;margin-bottom:16px"></div>
        <label style="font-size:0.82em;color:var(--muted);display:block;margin-bottom:6px">N&#250;mero de r&#233;plicas:</label>
        <input id="scale-input" type="number" min="0" max="50" style="width:100%;box-sizing:border-box;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:1em;outline:none;margin-bottom:6px">
        <div id="scale-warn" style="color:var(--yellow);font-size:0.78em;min-height:1.2em;margin-bottom:14px"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
            <button id="scale-cancel" style="background:transparent;color:var(--muted);border:1px solid var(--border);border-radius:6px;padding:6px 18px;cursor:pointer;font-size:0.9em">Cancelar</button>
            <button id="scale-confirm" style="background:#7C3AED;color:#fff;border:none;border-radius:6px;padding:6px 20px;cursor:pointer;font-size:0.9em;font-weight:600">Confirmar</button>
        </div>
    </div>
</div>

<!-- ══ OVERLAY TOPOLOGIA ══════════════════════════════════════════ -->
<div id="topo-overlay" style="display:none;position:fixed;inset:0;background:rgba(4,8,16,0.92);z-index:9998;flex-direction:column">
    <div style="display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid rgba(255,255,255,0.08);flex-shrink:0">
        <span style="font-size:1.05em;font-weight:700;color:#A78BFA">&#128200; Topologia de Servi&#231;os</span>
        <span id="topo-ns-label" style="font-size:0.78em;color:var(--muted);font-family:var(--font-mono)"></span>
        <div style="margin-left:auto;display:flex;gap:8px;align-items:center">
            <span id="topo-legenda" style="font-size:0.72em;color:var(--muted);display:flex;gap:12px;align-items:center">
                <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#00F7FF;vertical-align:middle;margin-right:4px"></span>Service</span>
                <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#7C3AED;vertical-align:middle;margin-right:4px"></span>Deployment</span>
                <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#00FF88;vertical-align:middle;margin-right:4px"></span>StatefulSet</span>
                <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#f59e0b;vertical-align:middle;margin-right:4px"></span>Ingress</span>
            </span>
            <button id="topo-fechar" style="background:rgba(255,45,170,0.12);border:1px solid rgba(255,45,170,0.3);color:#FF2DAA;border-radius:6px;padding:4px 14px;cursor:pointer;font-size:0.82em">&#10005; Fechar</button>
        </div>
    </div>
    <div style="flex:1;position:relative;overflow:hidden">
        <canvas id="topo-canvas" style="width:100%;height:100%;display:block"></canvas>
        <div id="topo-tooltip" style="display:none;position:absolute;background:#0d1b2e;border:1px solid rgba(167,139,250,0.4);border-radius:8px;padding:10px 14px;font-size:0.78em;pointer-events:none;max-width:260px;z-index:1"></div>
        <div id="topo-loading" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:0.9em">Carregando topologia...</div>
        <div id="topo-vazio" style="display:none;position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:12px;color:var(--muted)">
            <div style="font-size:2em">&#128202;</div>
            <div>Nenhuma depend\xEAncia encontrada neste namespace.</div>
            <div style="font-size:0.8em">Tente outro namespace ou adicione env vars referenciando services.</div>
        </div>
    </div>
</div>

<script nonce="${nonce}">
var vscode = acquireVsCodeApi();
var secaoAtual = null;
var secaoCarregada = {};
var _savedSettings = ${JSON.stringify(settings)};

// Estado do pod detail
var podDetalheAtual = null;
var podLogTabAtual = 'geral';
var _podLogTimer = null;
var _podLogAutoRefresh = false; // true durante ciclo de auto-refresh (evita flicker)

/* ── Utilitários ──────────────────────────────────────────────────────── */
function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmt(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes/1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes/1048576).toFixed(1) + ' MB';
    return (bytes/1073741824).toFixed(2) + ' GB';
}

/* ── Navegação ────────────────────────────────────────────────────────── */
function navegar(secao) {
    if (secaoAtual === secao) return;
    if (secaoAtual === 'detail') { pararMonitor(); pararAutoRefreshLogs(); }
    if (secaoAtual === 'pod-detail') { pararAutoRefreshPodLogs(); }
    secaoAtual = secao;

    document.querySelectorAll('.secao').forEach(function(s) { s.classList.remove('ativa'); });
    var el = document.getElementById('sec-' + secao);
    if (el) el.classList.add('ativa');

    // Nav-items Docker
    document.querySelectorAll('.nav-item[data-secao]').forEach(function(n) {
        n.classList.toggle('ativo', n.getAttribute('data-secao') === secao);
    });
    // K8s brand header: ativo quando secao == kubernetes
    var k8sBrand = document.getElementById('k8s-brand-header');
    if (k8sBrand) k8sBrand.classList.toggle('ativo', secao === 'kubernetes');
    // Sub-itens: desativar todos ao sair do kubernetes
    if (secao !== 'kubernetes') {
        document.querySelectorAll('.nav-subitem').forEach(function(s) { s.classList.remove('ativo'); });
    }

    // Rola ao topo ao mudar seção
    var mc = document.getElementById('main-content');
    if (mc) mc.scrollTop = 0;

    // Carrega dados se ainda não foram carregados (ou forçar reload)
    // pod-detail é carregado via k8sAbrirPod, não via carregarSecao
    if (!secaoCarregada[secao] && secao !== 'pod-detail') {
        secaoCarregada[secao] = true;
        vscode.postMessage({ command: 'carregarSecao', secao: secao });
    }
}

function navegarK8s(aba) {
    var eraOutra = secaoAtual !== 'kubernetes';
    if (eraOutra) {
        // Força navegação — zera o guard para poder entrar no switch
        secaoAtual = null;
        navegar('kubernetes');
    }
    ativarAbaK8s(aba);
    // Atualiza sub-item ativo
    document.querySelectorAll('.nav-subitem').forEach(function(s) {
        s.classList.toggle('ativo', s.getAttribute('data-k8s-aba') === aba);
    });
    var k8sBrand = document.getElementById('k8s-brand-header');
    if (k8sBrand) k8sBrand.classList.add('ativo');
}

/* ── Sidebar ──────────────────────────────────────────────────────────── */
document.querySelectorAll('.nav-item[data-secao]').forEach(function(el) {
    el.addEventListener('click', function() { navegar(el.getAttribute('data-secao')); });
});
// K8s brand header: toggle expand/collapse e navegação
document.getElementById('k8s-brand-header').addEventListener('click', function() {
    // Bloqueado se não houver cluster disponível
    if (this.classList.contains('k8s-desabilitado')) return;
    var group = document.getElementById('k8s-nav-group');
    var chevron = document.getElementById('k8s-chevron');
    group.classList.toggle('fechado');
    if (chevron) chevron.style.transform = group.classList.contains('fechado') ? 'rotate(-90deg)' : '';
    if (!group.classList.contains('fechado')) {
        navegarK8s(k8sAbaAtual || 'cluster');
    }
});
// K8s sub-itens: clicar navega para a aba correta
document.querySelectorAll('.nav-subitem[data-k8s-aba]').forEach(function(el) {
    el.addEventListener('click', function() {
        if (document.getElementById('k8s-brand-header').classList.contains('k8s-desabilitado')) return;
        var group = document.getElementById('k8s-nav-group');
        if (group.classList.contains('fechado')) group.classList.remove('fechado');
        navegarK8s(el.getAttribute('data-k8s-aba'));
    });
});

/* ── Handler de mensagens do backend ─────────────────────────────────── */
window.addEventListener('message', function(event) {
    var msg = event.data;
    switch (msg.command) {
        case 'navegar':
            navegar(msg.secao);
            break;
        case 'statusK8s': {
            var k8sHeader = document.getElementById('k8s-brand-header');
            var k8sGroup  = document.getElementById('k8s-nav-group');
            var k8sHint   = document.getElementById('k8s-status-hint');
            if (msg.disponivel) {
                // Cluster disponível: habilita
                k8sHeader.classList.remove('k8s-desabilitado');
                if (k8sHint) k8sHint.textContent = '';
            } else {
                // Sem cluster: desabilita e fecha o menu
                k8sHeader.classList.add('k8s-desabilitado');
                k8sHeader.classList.remove('ativo');
                k8sGroup.classList.add('fechado');
                document.getElementById('k8s-chevron').style.transform = 'rotate(-90deg)';
                // Se o usuário estava na seção K8s, volta para o dashboard
                if (secaoAtual === 'kubernetes' || secaoAtual === 'pod-detail') {
                    navegar('dashboard');
                }
                // Texto de dica: lista contextos disponíveis se houver
                if (k8sHint) {
                    k8sHint.textContent = msg.contextos && msg.contextos.length > 0
                        ? 'Use: kubectl config use-context'
                        : 'Nenhum cluster ativo';
                }
            }
            break;
        }
        case 'dadosDashboard':
            renderDashboard(msg.data);
            break;
        case 'dadosContainers':
            renderContainers(msg.data);
            break;
        case 'dadosImagens':
            renderImagens(msg.data);
            break;
        case 'dadosRedes':
            renderRedes(msg.data);
            break;
        case 'dadosVolumes':
            renderVolumes(msg.data);
            break;
        case 'dadosKubernetes':
            renderKubernetes(msg);
            break;
        case 'dadosDetalheContainer':
            if (msg.erro) {
                document.getElementById('d-loading').textContent = 'Erro: ' + msg.erro;
            } else {
                renderDetalhe(msg.data);
            }
            break;
        case 'dadosStats':
            if (monitorActive) processarStats(msg.data);
            break;
        case 'dadosPodStats':
            processarPodStats(msg);
            break;
        case 'erroPodStats': {
            var stEl = document.getElementById('pd-monitor-status');
            if (stEl) stEl.textContent = msg.erro || 'M\u00e9tricas n\u00e3o dispon\u00edveis';
            break;
        }
        case 'dadosLogs': {
            var lc = document.getElementById('l-content');
            var naBase = lc.scrollHeight - lc.scrollTop - lc.clientHeight < 60;
            // Oculta indicador de carregamento apenas se estava visível
            var ll = document.getElementById('l-loading');
            if (ll.style.display !== 'none') ll.style.display = 'none';
            if (lc.style.opacity !== '1') { lc.style.opacity = '1'; lc.style.display = ''; }
            if (msg.erro) {
                lc.innerHTML = '<span style="color:var(--pink)">Erro ao carregar logs: ' + esc(msg.erro) + '</span>';
            } else {
                lc.innerHTML = msg.data || '<span style="opacity:0.4">(sem logs)</span>';
                // Só rola para o final se o usuário já estava no final (ou primeiro carregamento)
                if (naBase) lc.scrollTop = lc.scrollHeight;
            }
            break;
        }
        case 'erroSecao':
            mostrarErroSecao(msg.secao, msg.data);
            break;
        case 'acaoCancelada':
            cDesabilitarToolbar(false);
            break;
        case 'dadosPodDetalhe':
            if (msg.erro) {
                document.getElementById('pd-loading').textContent = 'Erro: ' + msg.erro;
            } else {
                renderPodDetalhe(msg.data);
            }
            break;
        case 'dadosPodLogs': {
            var plc = document.getElementById('pd-log-content');
            var pll = document.getElementById('pd-log-loading');
            var isAuto = _podLogAutoRefresh;
            // Oculta indicador e restaura opacidade apenas no load manual
            if (!isAuto) {
                if (pll) pll.style.display = 'none';
                if (plc) plc.style.opacity = '1';
            }
            if (plc) {
                if (msg.erro) {
                    plc.innerHTML = '<span style="color:var(--pink)">Erro: ' + esc(msg.erro) + '</span>';
                } else {
                    // Salva posição do scroll ANTES de atualizar o conteúdo (evita flicker de scroll)
                    var naBase = plc.scrollHeight - plc.scrollTop - plc.clientHeight < 60;
                    var scrollAntes = plc.scrollTop;
                    plc.innerHTML = msg.data || '<span style="opacity:0.4">(sem logs)</span>';
                    // Restaura: se estava no final → vai ao final; senão mantém posição
                    if (naBase) {
                        plc.scrollTop = plc.scrollHeight;
                    } else if (isAuto) {
                        plc.scrollTop = scrollAntes;
                    }
                }
            }
            _podLogAutoRefresh = false;
            break;
        }
    }
});

function mostrarErroSecao(secao, msg) {
    var prefixos = { dashboard: 'dash', containers: 'c', images: 'i', networks: 'n', volumes: 'v' };
    var p = prefixos[secao];
    if (!p) return;
    var loadEl = document.getElementById(p + '-loading');
    var erroEl = document.getElementById(p + '-erro');
    if (loadEl) loadEl.style.display = 'none';
    if (erroEl) { erroEl.textContent = 'Erro: ' + msg; erroEl.style.display = ''; }
    secaoCarregada[secao] = false; // Permite tentar recarregar
}

/* ══ POD DETAIL ══════════════════════════════════════════════════════════ */
function pararAutoRefreshPodLogs() {
    if (_podLogTimer) { clearInterval(_podLogTimer); _podLogTimer = null; }
    _podLogAutoRefresh = false;
}

function carregarPodLogs(isAutoRefresh) {
    if (!podDetalheAtual) return;
    _podLogAutoRefresh = !!isAutoRefresh;
    // Indicador de carregamento apenas no load manual (evita flicker no auto-refresh)
    if (!isAutoRefresh) {
        var pll = document.getElementById('pd-log-loading');
        if (pll) pll.style.display = '';
    }
    vscode.postMessage({ command: 'k8sLogs', nome: podDetalheAtual.nome, namespace: podDetalheAtual.namespace });
}

function renderPodDetalhe(d) {
    document.getElementById('pd-loading').style.display = 'none';
    document.getElementById('pd-content').style.display = '';
    document.getElementById('pd-title').textContent = d.nome;
    var badgeCor = d.status === 'Running' ? 'var(--verde)' : d.status === 'Pending' ? 'var(--yellow)' : 'var(--pink)';
    document.getElementById('pd-status-badge').innerHTML =
        '<span style="background:' + badgeCor + ';color:#fff;padding:2px 8px;border-radius:4px;font-size:0.8em">' + esc(d.status) + '</span>';

    // Aba Geral
    var gi = document.getElementById('pd-geral-info');
    var labels = Object.entries(d.labels || {}).map(function(e) { return '<tr><td>' + esc(e[0]) + '</td><td>' + esc(e[1]) + '</td></tr>'; }).join('');
    var conds  = (d.conditions || []).map(function(c) {
        var cor = c.status === 'True' ? 'var(--verde)' : 'var(--pink)';
        return '<tr><td>' + esc(c.tipo) + '</td><td style="color:' + cor + '">' + esc(c.status) + '</td><td>' + esc(c.motivo) + '</td></tr>';
    }).join('');
    gi.innerHTML = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">' +
        '<div><table class="k8s-table"><tbody>' +
            '<tr><td>Nome</td><td>' + esc(d.nome) + '</td></tr>' +
            '<tr><td>Namespace</td><td>' + esc(d.namespace) + '</td></tr>' +
            '<tr><td>IP do Pod</td><td>' + esc(d.ip) + '</td></tr>' +
            '<tr><td>N\\u00f3</td><td>' + esc(d.nodeName) + '</td></tr>' +
            '<tr><td>Criado em</td><td>' + (d.criado ? new Date(d.criado).toLocaleString('pt-BR') : '-') + '</td></tr>' +
            '<tr><td>Controlador</td><td>' + esc(d.ownerKind) + ' / ' + esc(d.ownerNome) + '</td></tr>' +
        '</tbody></table></div>' +
        '<div><h4 style="margin:0 0 8px">Labels</h4><table class="k8s-table"><tbody>' + (labels || '<tr><td colspan=2>Nenhum</td></tr>') + '</tbody></table></div>' +
        '</div>' +
        '<h4 style="margin:16px 0 8px">Condi\\u00e7\\u00f5es</h4>' +
        '<table class="k8s-table"><thead><tr><th>Tipo</th><th>Status</th><th>Motivo</th></tr></thead><tbody>' + (conds || '<tr><td colspan=3>-</td></tr>') + '</tbody></table>';

    // Aba Containers
    var ct = document.getElementById('pd-tab-containers');
    var ctRows = (d.containers || []).map(function(c) {
        var corP = c.pronto ? 'var(--verde)' : 'var(--pink)';
        return '<tr><td>' + esc(c.nome) + '</td><td style="font-size:0.8em">' + esc(c.imagem) + '</td>' +
            '<td style="color:' + corP + '">' + (c.pronto ? '&#10003;' : '&#10007;') + '</td>' +
            '<td>' + c.restarts + '</td><td>' + esc(c.estado) + (c.motivo ? ' (' + esc(c.motivo) + ')' : '') + '</td>' +
            '<td>' + esc(c.portas || '-') + '</td></tr>';
    }).join('');
    ct.innerHTML = '<table class="k8s-table"><thead><tr><th>Nome</th><th>Imagem</th><th>Pronto</th><th>Restarts</th><th>Estado</th><th>Portas</th></tr></thead><tbody>' +
        (ctRows || '<tr><td colspan=6>Nenhum container</td></tr>') + '</tbody></table>';

    // Aba YAML
    var yEl = document.getElementById('pd-tab-yaml');
    yEl.innerHTML = '<pre style="overflow:auto;max-height:600px;font-size:0.8em">' + esc(d.yaml || '') + '</pre>';
}

// Botão Voltar
document.getElementById('pd-back').addEventListener('click', function() {
    pararAutoRefreshPodLogs();
    vscode.postMessage({ command: 'pararMonitoramentoPod' });
    podDetalheAtual = null;
    // Volta para a aba workloads do Kubernetes
    navegar('kubernetes');
    ativarAbaK8s('workloads');
});

// Tabs do pod detail
document.getElementById('pd-tabs-nav').addEventListener('click', function(e) {
    var btn = e.target.closest('.tab-btn');
    if (!btn) return;
    var tab = btn.getAttribute('data-tab');
    document.querySelectorAll('#pd-tabs-nav .tab-btn').forEach(function(b) { b.classList.remove('ativo'); });
    btn.classList.add('ativo');
    document.querySelectorAll('#pd-content .tab-panel').forEach(function(p) { p.classList.remove('ativo'); });
    var panel = document.getElementById('pd-tab-' + tab);
    if (panel) panel.classList.add('ativo');
    podLogTabAtual = tab;
    if (tab === 'logs' && podDetalheAtual) { carregarPodLogs(false); }
});

// Botão atualizar logs do pod (load manual — mostra indicador)
document.getElementById('pd-refresh-btn').addEventListener('click', function() {
    if (podDetalheAtual) carregarPodLogs(false);
});

// Auto-refresh do log do pod
document.getElementById('pd-auto-select').addEventListener('change', function() {
    pararAutoRefreshPodLogs();
    var v = parseInt(this.value, 10);
    if (v > 0 && podDetalheAtual) {
        // Dispara uma atualização imediata (manual) antes de iniciar o ciclo
        carregarPodLogs(false);
        _podLogTimer = setInterval(function() {
            if (podDetalheAtual && podLogTabAtual === 'logs') carregarPodLogs(true);
        }, v);
    }
});


var k8sAbaAtual = 'cluster';

function atualizarSeletorContexto(contextos, contextoAtivo) {
    var sel = document.getElementById('k8s-context-select');
    if (!sel || !Array.isArray(contextos) || contextos.length === 0) return;
    var valorAnterior = sel.value;
    sel.innerHTML = '';
    contextos.forEach(function(ctx) {
        var opt = document.createElement('option');
        opt.value = ctx.nome;
        opt.textContent = ctx.nome;
        if (ctx.nome === contextoAtivo) opt.selected = true;
        sel.appendChild(opt);
    });
    if (valorAnterior && !contextoAtivo) sel.value = valorAnterior;
}

function atualizarSeletorNamespace(nsList, nsAtivo) {
    var sel = document.getElementById('k8s-ns-select');
    if (!sel || !Array.isArray(nsList) || nsList.length === 0) return;
    sel.innerHTML = '';
    nsList.forEach(function(nome) {
        var opt = document.createElement('option');
        opt.value = nome;
        opt.textContent = nome;
        if (nome === nsAtivo) opt.selected = true;
        sel.appendChild(opt);
    });
}

function renderKubernetes(msg) {
    var loading = document.getElementById('k8s-loading');
    var body    = document.getElementById('k8s-body');
    var erro    = document.getElementById('k8s-erro');
    if (loading) loading.style.display = 'none';
    if (erro)    erro.style.display = 'none';
    if (body)    body.style.display = '';
    // Atualiza o seletor de contextos
    if (msg.contextos) atualizarSeletorContexto(msg.contextos, msg.contextoAtivo || '');
    // Atualiza o seletor de namespaces
    if (msg.nomespacesLista) atualizarSeletorNamespace(msg.nomespacesLista, msg.namespaceAtivo || 'default');
    var abas = ['cluster', 'namespaces', 'workloads', 'networking', 'storage', 'config', 'nodes'];
    abas.forEach(function(aba) {
        var el = document.getElementById('k8s-aba-' + aba);
        if (el && msg[aba]) { el.innerHTML = msg[aba]; }
    });
    ativarAbaK8s(k8sAbaAtual);
}

function ativarAbaK8s(aba) {
    k8sAbaAtual = aba;
    var abas = ['cluster', 'namespaces', 'workloads', 'networking', 'storage', 'config', 'nodes'];
    abas.forEach(function(a) {
        var el = document.getElementById('k8s-aba-' + a);
        if (el) el.style.display = (a === aba ? '' : 'none');
    });
    document.querySelectorAll('.k8s-tab-btn').forEach(function(btn) {
        btn.classList.toggle('ativo', btn.getAttribute('data-aba') === aba);
    });
    // Sincroniza sub-item do sidebar
    document.querySelectorAll('.nav-subitem[data-k8s-aba]').forEach(function(s) {
        s.classList.toggle('ativo', s.getAttribute('data-k8s-aba') === aba);
    });
}

function postK8s(cmd, secao) {
    vscode.postMessage({ command: cmd, secao: secao });
}

document.getElementById('k8s-refresh').addEventListener('click', function() {
    secaoCarregada['kubernetes'] = false;
    var loading = document.getElementById('k8s-loading');
    var body    = document.getElementById('k8s-body');
    if (loading) { loading.textContent = 'Carregando...'; loading.style.display = ''; }
    if (body)    body.style.display = 'none';
    vscode.postMessage({ command: 'carregarSecao', secao: 'kubernetes' });
});

// Troca de contexto/cluster via seletor
document.getElementById('k8s-context-select').addEventListener('change', function() {
    var novo = this.value;
    if (!novo) return;
    var loading = document.getElementById('k8s-loading');
    var body    = document.getElementById('k8s-body');
    if (loading) { loading.textContent = 'Conectando ao cluster ' + novo + '...'; loading.style.display = ''; }
    if (body)    body.style.display = 'none';
    secaoCarregada['kubernetes'] = false;
    vscode.postMessage({ command: 'trocarContexto', nome: novo });
});

// Troca de namespace via seletor
document.getElementById('k8s-ns-select').addEventListener('change', function() {
    var novo = this.value;
    if (!novo) return;
    var loading = document.getElementById('k8s-loading');
    var body    = document.getElementById('k8s-body');
    if (loading) { loading.textContent = 'Carregando namespace ' + novo + '...'; loading.style.display = ''; }
    if (body)    body.style.display = 'none';
    secaoCarregada['kubernetes'] = false;
    vscode.postMessage({ command: 'trocarNamespace', nome: novo });
});

document.getElementById('k8s-tabs').addEventListener('click', function(e) {
    var btn = e.target.closest('.k8s-tab-btn');
    if (!btn) return;
    var aba = btn.getAttribute('data-aba');
    if (aba) ativarAbaK8s(aba);
});

// Delegação de eventos: cards do dashboard K8s navegam para a aba correta
document.getElementById('k8s-body').addEventListener('click', function(e) {
    var card = e.target.closest('.k8s-dash-card[data-k8s-goto]');
    if (card) {
        var aba = card.getAttribute('data-k8s-goto');
        if (aba) ativarAbaK8s(aba);
        return;
    }
    // Expande/colapsa linhas de volume PVC
    var volRow = e.target.closest('.k8s-vol-row');
    if (volRow) {
        var idx = volRow.getAttribute('data-idx');
        var detail = document.getElementById('k8s-vol-detail-' + idx);
        if (detail) {
            var aberto = detail.style.display !== 'none';
            detail.style.display = aberto ? 'none' : '';
            volRow.classList.toggle('aberto', !aberto);
        }
        return;
    }
    // Ações rápidas nas tabelas de workloads
    var qaBtn = e.target.closest('.k8s-qa-btn');
    if (qaBtn) {
        e.stopPropagation();
        var acao = qaBtn.getAttribute('data-acao');
        var nome = qaBtn.getAttribute('data-nome');
        var ns   = qaBtn.getAttribute('data-ns');
        if (acao === 'depl-scale' || acao === 'ss-scale') {
            var cur = qaBtn.getAttribute('data-replicas') || '1';
            abrirModalEscala(acao, nome, ns, cur);
        } else {
            vscode.postMessage({ command: 'k8sAcao', acao: acao, nome: nome, namespace: ns });
        }
        return;
    }
    // Clicar no nome do pod → abre página de detalhe
    var podLink = e.target.closest('.k8s-pod-link');
    if (podLink) {
        var podNome = podLink.getAttribute('data-nome');
        var podNs   = podLink.getAttribute('data-ns');
        // Para timer anterior e reseta estado ANTES de atribuir novo pod
        pararAutoRefreshPodLogs();
        vscode.postMessage({ command: 'pararMonitoramentoPod' });
        podDetalheAtual = { nome: podNome, namespace: podNs };
        podLogTabAtual = 'geral';
        _podLogAutoRefresh = false;
        // Reseta gráficos de monitoramento do pod
        pdMonitorPts = { cpu: [], mem: [] };
        pdMemMax = 1;
        var pdCpuVal = document.getElementById('pd-cpu-val');
        var pdMemVal = document.getElementById('pd-mem-val');
        var pdMonSt  = document.getElementById('pd-monitor-status');
        if (pdCpuVal) pdCpuVal.textContent = '\u2014';
        if (pdMemVal) pdMemVal.textContent = '\u2014';
        if (pdMonSt)  pdMonSt.textContent  = 'Aguardando m\u00e9tricas...';
        // Reseta UI: select volta para "Desativado", aba Geral ativa
        document.getElementById('pd-auto-select').value = '0';
        document.querySelectorAll('#pd-tabs-nav .tab-btn').forEach(function(b) {
            b.classList.toggle('ativo', b.getAttribute('data-tab') === 'geral');
        });
        document.querySelectorAll('#pd-content .tab-panel').forEach(function(p) {
            p.classList.toggle('ativo', p.id === 'pd-tab-geral');
        });
        // Limpa log anterior para não exibir dados do pod anterior
        var plc = document.getElementById('pd-log-content');
        if (plc) { plc.innerHTML = ''; plc.style.opacity = '0.5'; }
        document.getElementById('pd-loading').style.display = '';
        document.getElementById('pd-content').style.display = 'none';
        document.getElementById('pd-title').textContent = podNome;
        document.getElementById('pd-status-badge').innerHTML = '';
        navegar('pod-detail');
        vscode.postMessage({ command: 'k8sAbrirPod', nome: podNome, namespace: podNs });
        vscode.postMessage({ command: 'iniciarMonitoramentoPod', nome: podNome, namespace: podNs });
    }
});

/* ══ DASHBOARD ═══════════════════════════════════════════════════════════ */
document.getElementById('dash-refresh').addEventListener('click', function() {
    secaoCarregada['dashboard'] = false;
    document.getElementById('dash-node').style.display = 'none';
    document.getElementById('dash-cards').style.display = 'none';
    document.getElementById('dash-loading').style.display = '';
    document.getElementById('dash-erro').style.display = 'none';
    vscode.postMessage({ command: 'carregarSecao', secao: 'dashboard' });
});

document.querySelectorAll('.card[data-goto]').forEach(function(card) {
    card.addEventListener('click', function() { navegar(card.getAttribute('data-goto')); });
});

function renderDashboard(d) {
    document.getElementById('dash-loading').style.display = 'none';
    document.getElementById('dash-erro').style.display = 'none';

    var rows =
        tr('Hostname',       esc(d.engine.hostname)) +
        tr('Docker Version', esc(d.engine.versao)) +
        tr('API Version',    esc(d.engine.api)) +
        tr('OS',             esc(d.engine.os)) +
        tr('Arquitetura',    esc(d.engine.arch)) +
        tr('CPUs',           String(d.engine.cpus)) +
        tr('Mem\\u00f3ria',  fmt(d.engine.memoria));
    document.getElementById('dash-node-table').innerHTML = rows;
    document.getElementById('dash-node').style.display = '';

    document.getElementById('dash-cnt-total').textContent = String(d.containers.total);
    document.getElementById('dash-cnt-detalhe').innerHTML =
        '<span class="running-txt">&#9679; ' + d.containers.running + ' em execu\\u00e7\\u00e3o</span>' +
        ' &nbsp; <span class="stopped-txt">&#9679; ' + d.containers.stopped + ' parados</span>';
    document.getElementById('dash-img-total').textContent = String(d.imagens.total);
    document.getElementById('dash-img-detalhe').textContent = fmt(d.imagens.tamanhoTotal);
    document.getElementById('dash-vol-total').textContent = String(d.volumes.total);
    document.getElementById('dash-net-total').textContent = String(d.redes.total);
    document.getElementById('dash-cards').style.display = '';
}

function tr(k, v) { return '<tr><td>' + esc(k) + '</td><td>' + v + '</td></tr>'; }

/* ══ CONTAINERS ══════════════════════════════════════════════════════════ */
var cTodos = [], cFiltrado = [], cSelecionados = new Set(), cSortCol = 'estado', cSortAsc = true;

document.getElementById('c-refresh').addEventListener('click', function() {
    secaoCarregada['containers'] = false;
    cResetUI();
    vscode.postMessage({ command: 'carregarSecao', secao: 'containers' });
});
document.getElementById('c-busca').addEventListener('input', function() { cAplicarFiltro(); });
document.getElementById('c-check-all').addEventListener('change', function() {
    if (this.checked) { cFiltrado.forEach(function(c) { cSelecionados.add(c.id); }); }
    else { cSelecionados.clear(); }
    cRenderTabela(); cAtualizarToolbar();
});
document.querySelectorAll('#c-toolbar .btn[data-acao]').forEach(function(btn) {
    btn.addEventListener('click', function() {
        if (cSelecionados.size === 0) return;
        cDesabilitarToolbar(true);
        vscode.postMessage({ command: 'acaoBulkContainers', acao: btn.getAttribute('data-acao'), ids: Array.from(cSelecionados) });
    });
});
document.querySelectorAll('#sec-containers thead th[data-col]').forEach(function(th) {
    th.addEventListener('click', function() {
        var col = th.getAttribute('data-col');
        if (cSortCol === col) { cSortAsc = !cSortAsc; } else { cSortCol = col; cSortAsc = true; }
        cAplicarFiltro();
    });
});

function cResetUI() {
    document.getElementById('c-loading').style.display = '';
    document.getElementById('c-tabela-wrap').style.display = 'none';
    document.getElementById('c-erro').style.display = 'none';
}
function cDesabilitarToolbar(dis) {
    document.querySelectorAll('#c-toolbar .btn[data-acao]').forEach(function(b) { b.disabled = dis; });
}
function cAplicarFiltro() {
    var q = document.getElementById('c-busca').value.toLowerCase();
    cFiltrado = cTodos.filter(function(c) {
        return !q || c.nome.toLowerCase().includes(q) || c.imagem.toLowerCase().includes(q) || c.estado.toLowerCase().includes(q);
    });
    cFiltrado.sort(function(a, b) {
        var va = String(a[cSortCol] || ''), vb = String(b[cSortCol] || '');
        return cSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    });
    var ids = new Set(cFiltrado.map(function(c) { return c.id; }));
    cSelecionados.forEach(function(id) { if (!ids.has(id)) cSelecionados.delete(id); });
    cRenderTabela(); cAtualizarToolbar();
}
function cRenderTabela() {
    var tbody = document.getElementById('c-tbody');
    document.querySelectorAll('#sec-containers thead th[data-col]').forEach(function(th) {
        var arrow = th.querySelector('.sort-arrow');
        arrow.textContent = th.getAttribute('data-col') === cSortCol ? (cSortAsc ? ' \\u25b2' : ' \\u25bc') : '';
    });
    if (cFiltrado.length === 0) {
        tbody.innerHTML = ''; document.getElementById('c-vazia').style.display = ''; return;
    }
    document.getElementById('c-vazia').style.display = 'none';
    var html = '';
    cFiltrado.forEach(function(c) {
        var sel = cSelecionados.has(c.id);
        var bc = 'badge-' + (['exited','running','paused','created','dead','restarting'].includes(c.estado) ? c.estado : 'exited');
        var portas = (c.portas || []).filter(function(p) { return p.portaPublica; }).map(function(p) {
            return '<a class="porta-link" href="http://localhost:' + p.portaPublica + '">' + p.portaPublica + ':' + p.portaPrivada + '/' + p.protocolo + '</a>';
        }).join(' ');
        var criado = c.criado ? new Date(c.criado).toLocaleString('pt-BR') : '-';
        html += '<tr class="' + (sel ? 'selecionado' : '') + '" data-id="' + esc(c.id) + '">' +
            '<td><input type="checkbox" class="chk-row" data-id="' + esc(c.id) + '"' + (sel ? ' checked' : '') + '></td>' +
            '<td><span class="nome-link" data-id="' + esc(c.id) + '" data-ar="inspect">' + esc(c.nome) + '</span></td>' +
            '<td><span class="badge ' + bc + '">' + esc(c.estado) + '</span></td>' +
            '<td style="font-family:var(--font-mono);font-size:0.82em">' + esc(c.imagem) + '</td>' +
            '<td style="white-space:nowrap">' + criado + '</td>' +
            '<td style="font-family:var(--font-mono);font-size:0.82em">' + esc(c.ip || '-') + '</td>' +
            '<td class="portas">' + (portas || '-') + '</td>' +
            '<td><div class="quick-actions">' +
                '<button class="qa-btn" data-id="' + esc(c.id) + '" data-ar="inspect" title="Inspecionar">&#128269;</button>' +
                (c.estado === 'running' ? '<button class="qa-btn" data-id="' + esc(c.id) + '" data-ar="shell" title="Terminal">&#9166;</button>' : '') +
            '</div></td></tr>';
    });
    tbody.innerHTML = html;
    tbody.querySelectorAll('.chk-row').forEach(function(chk) {
        chk.addEventListener('change', function() {
            var id = chk.getAttribute('data-id');
            if (chk.checked) { cSelecionados.add(id); } else { cSelecionados.delete(id); }
            var tr2 = chk.closest('tr'); if (tr2) tr2.className = chk.checked ? 'selecionado' : '';
            cAtualizarToolbar();
        });
    });
    tbody.querySelectorAll('[data-ar]').forEach(function(el) {
        el.addEventListener('click', function(e) {
            e.stopPropagation();
            var ar = el.getAttribute('data-ar');
            var cid = el.getAttribute('data-id');
            if (ar === 'inspect') {
                detalheContainerId = cid;
                document.getElementById('d-loading').style.display = '';
                document.getElementById('d-loading').textContent = 'Carregando detalhes do container...';
                document.getElementById('d-content').style.display = 'none';
                navegar('detail');
                vscode.postMessage({ command: 'carregarDetalheContainer', id: cid });
            } else {
                vscode.postMessage({ command: 'acaoRapidaContainer', id: cid, acaoRapida: ar });
            }
        });
    });
    var n = cSelecionados.size;
    var ca = document.getElementById('c-check-all');
    ca.checked = n > 0 && n === cFiltrado.length;
    ca.indeterminate = n > 0 && n < cFiltrado.length;
}
function cAtualizarToolbar() {
    var n = cSelecionados.size;
    document.querySelectorAll('#c-toolbar .btn[data-acao]').forEach(function(b) { b.disabled = n === 0; });
    document.getElementById('c-sel-count').textContent = n > 0 ? n + ' selecionado(s)' : '';
}

function renderContainers(data) {
    cTodos = data; cSelecionados.clear();
    document.getElementById('c-loading').style.display = 'none';
    document.getElementById('c-tabela-wrap').style.display = '';
    document.getElementById('c-erro').style.display = 'none';
    cDesabilitarToolbar(false);
    cAplicarFiltro();
}

/* ══ IMAGENS ═════════════════════════════════════════════════════════════ */
var iTodos = [], iSelecionadas = new Set();

document.getElementById('i-filtro').addEventListener('input', function() {
    var q = this.value.toLowerCase();
    document.querySelectorAll('#i-tbody tr').forEach(function(tr3) {
        var tag = tr3.querySelector('td:nth-child(2)');
        tr3.style.display = tag && tag.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
});
document.getElementById('i-sel-todos').addEventListener('change', function() {
    var checks = document.querySelectorAll('#i-tbody .chk-img');
    if (this.checked) { checks.forEach(function(cb) { cb.checked = true; iSelecionadas.add(cb.getAttribute('data-id')); }); }
    else { checks.forEach(function(cb) { cb.checked = false; }); iSelecionadas.clear(); }
    iAtualizarInfo();
});
document.getElementById('i-btn-remover').addEventListener('click', function() {
    vscode.postMessage({ command: 'removerImagens', ids: Array.from(iSelecionadas) });
});

function iAtualizarInfo() {
    var bar = document.getElementById('i-info-bar');
    var txt = document.getElementById('i-info-texto');
    if (iSelecionadas.size > 0) {
        bar.style.display = 'flex'; txt.textContent = iSelecionadas.size + ' imagem(ns) selecionada(s)';
    } else { bar.style.display = 'none'; }
}

function renderImagens(data) {
    iTodos = data; iSelecionadas.clear();
    document.getElementById('i-loading').style.display = 'none';
    document.getElementById('i-erro').style.display = 'none';
    var tabela = document.getElementById('i-tabela');
    if (data.length === 0) { tabela.style.display = 'none'; document.getElementById('i-loading').innerHTML = '<div class="empty-state">Nenhuma imagem encontrada</div>'; document.getElementById('i-loading').style.display = ''; return; }
    tabela.style.display = 'table';
    var html = '';
    data.forEach(function(img) {
        var badge = img.emUso ? '<span class="badge badge-em-uso">Em uso</span>' : '<span class="badge badge-nao-usado">Sem uso</span>';
        html += '<tr data-id="' + esc(img.id) + '">' +
            '<td><input type="checkbox" class="chk-img" data-id="' + esc(img.id) + '"></td>' +
            '<td style="font-family:var(--font-mono)">' + esc(img.tags) + '</td>' +
            '<td>' + badge + '</td>' +
            '<td>' + esc(img.tamanho) + '</td>' +
            '<td>' + esc(img.criada) + '</td></tr>';
    });
    document.getElementById('i-tbody').innerHTML = html;
    document.querySelectorAll('#i-tbody .chk-img').forEach(function(cb) {
        cb.addEventListener('change', function() {
            if (cb.checked) { iSelecionadas.add(cb.getAttribute('data-id')); } else { iSelecionadas.delete(cb.getAttribute('data-id')); }
            var tr4 = cb.closest('tr'); if (tr4) tr4.className = cb.checked ? 'selecionado' : '';
            iAtualizarInfo();
        });
    });
    iAtualizarInfo();
}

/* ══ REDES ═══════════════════════════════════════════════════════════════ */
var nTodos = [], nSelecionadas = new Set();

document.getElementById('n-filtro').addEventListener('input', function() {
    var q = this.value.toLowerCase();
    document.querySelectorAll('#n-tbody tr').forEach(function(tr5) {
        var nome = tr5.querySelector('td:nth-child(2)');
        tr5.style.display = nome && nome.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
});
document.getElementById('n-sel-todos').addEventListener('change', function() {
    var checks = document.querySelectorAll('#n-tbody .chk-net:not(:disabled)');
    if (this.checked) { checks.forEach(function(cb) { cb.checked = true; nSelecionadas.add(cb.getAttribute('data-id')); }); }
    else { checks.forEach(function(cb) { cb.checked = false; }); nSelecionadas.clear(); }
    nAtualizarInfo();
});
document.getElementById('n-btn-remover').addEventListener('click', function() {
    vscode.postMessage({ command: 'removerRedes', ids: Array.from(nSelecionadas) });
});

function nAtualizarInfo() {
    var bar = document.getElementById('n-info-bar');
    var txt = document.getElementById('n-info-texto');
    if (nSelecionadas.size > 0) {
        bar.style.display = 'flex'; txt.textContent = nSelecionadas.size + ' rede(s) selecionada(s)';
    } else { bar.style.display = 'none'; }
}

function renderRedes(data) {
    nTodos = data; nSelecionadas.clear();
    document.getElementById('n-loading').style.display = 'none';
    document.getElementById('n-erro').style.display = 'none';
    var tabela = document.getElementById('n-tabela');
    if (data.length === 0) { tabela.style.display = 'none'; return; }
    tabela.style.display = 'table';
    var html = '';
    data.forEach(function(r) {
        var chk = r.sistema
            ? '<input type="checkbox" disabled title="Rede do sistema">'
            : '<input type="checkbox" class="chk-net" data-id="' + esc(r.id) + '">';
        var badge = r.sistema ? ' <span class="badge badge-sistema">System</span>' : '';
        html += '<tr data-id="' + esc(r.id) + '">' +
            '<td>' + chk + '</td>' +
            '<td>' + esc(r.nome) + badge + '</td>' +
            '<td>' + esc(r.driver) + '</td>' +
            '<td>' + esc(r.escopo) + '</td>' +
            '<td><code>' + esc(r.subnet) + '</code></td>' +
            '<td><code>' + esc(r.gateway) + '</code></td>' +
            '<td>' + esc(r.ipamDriver) + '</td>' +
            '<td>' + r.containers + '</td></tr>';
    });
    document.getElementById('n-tbody').innerHTML = html;
    document.querySelectorAll('#n-tbody .chk-net').forEach(function(cb) {
        cb.addEventListener('change', function() {
            if (cb.checked) { nSelecionadas.add(cb.getAttribute('data-id')); } else { nSelecionadas.delete(cb.getAttribute('data-id')); }
            var tr6 = cb.closest('tr'); if (tr6) tr6.className = cb.checked ? 'selecionado' : '';
            nAtualizarInfo();
        });
    });
    nAtualizarInfo();
}

/* ══ VOLUMES ═════════════════════════════════════════════════════════════ */
var vTodos = [], vSelecionados = new Set();

document.getElementById('v-refresh').addEventListener('click', function() {
    secaoCarregada['volumes'] = false;
    document.getElementById('v-loading').style.display = '';
    document.getElementById('v-loading').textContent = 'Carregando volumes...';
    document.getElementById('v-lista').style.display = 'none';
    document.getElementById('v-erro').style.display = 'none';
    document.getElementById('v-vazia').style.display = 'none';
    vscode.postMessage({ command: 'carregarSecao', secao: 'volumes' });
});

document.getElementById('v-filtro').addEventListener('input', function() {
    vAplicarFiltro(this.value.toLowerCase());
});
document.getElementById('v-sel-todos').addEventListener('change', function() {
    var checks = document.querySelectorAll('#v-tbody .chk-vol');
    if (this.checked) { checks.forEach(function(cb) { cb.checked = true; vSelecionados.add(cb.getAttribute('data-id')); }); }
    else { checks.forEach(function(cb) { cb.checked = false; }); vSelecionados.clear(); }
    vAtualizarInfo();
});
document.getElementById('v-btn-remover').addEventListener('click', function() {
    vscode.postMessage({ command: 'removerVolumes', ids: Array.from(vSelecionados) });
});

// Delegação de eventos para expansão de linhas de volumes
document.getElementById('v-tbody').addEventListener('click', function(e) {
    var chk = e.target.closest('.chk-vol');
    if (chk) {
        e.stopPropagation();
        if (chk.checked) { vSelecionados.add(chk.getAttribute('data-id')); }
        else { vSelecionados.delete(chk.getAttribute('data-id')); }
        var row = chk.closest('.vol-row'); if (row) row.classList.toggle('selecionado', chk.checked);
        vAtualizarInfo();
        return;
    }
    // Link para abrir container diretamente a partir dos volumes
    var cntLink = e.target.closest('.vol-cnt-link');
    if (cntLink) {
        e.stopPropagation();
        var cid = cntLink.getAttribute('data-id');
        if (cid) {
            detalheContainerId = cid;
            document.getElementById('d-loading').style.display = '';
            document.getElementById('d-loading').textContent = 'Carregando detalhes do container...';
            document.getElementById('d-content').style.display = 'none';
            navegar('detail');
            vscode.postMessage({ command: 'carregarDetalheContainer', id: cid, navegarPara: 'detail' });
        }
        return;
    }
    var row = e.target.closest('.vol-row');
    if (row) {
        var idx = row.getAttribute('data-idx');
        var detail = document.getElementById('vol-detail-' + idx);
        if (detail) {
            var aberto = detail.style.display !== 'none' && detail.style.display !== '';
            detail.style.display = aberto ? 'none' : 'block';
            row.classList.toggle('aberto', !aberto);
        }
    }
});

function vAplicarFiltro(q) {
    document.querySelectorAll('#v-tbody .vol-row').forEach(function(row) {
        var nome = row.getAttribute('data-nome') || '';
        var visivel = !q || nome.toLowerCase().includes(q);
        row.style.display = visivel ? '' : 'none';
        var idx = row.getAttribute('data-idx');
        var detail = document.getElementById('vol-detail-' + idx);
        if (detail && !visivel) { detail.style.display = 'none'; row.classList.remove('aberto'); }
    });
}

function vAtualizarInfo() {
    var bar = document.getElementById('v-info-bar');
    var txt = document.getElementById('v-info-texto');
    if (vSelecionados.size > 0) {
        bar.style.display = 'flex'; txt.textContent = vSelecionados.size + ' volume(s) selecionado(s)';
    } else { bar.style.display = 'none'; }
}

function fmtData(d) {
    if (!d) return '-';
    try {
        var dt = new Date(d);
        if (isNaN(dt.getTime()) || dt.getFullYear() < 2000) return '-';
        return dt.toLocaleString('pt-BR');
    } catch { return '-'; }
}

function renderVolumes(data) {
    vTodos = data; vSelecionados.clear();
    document.getElementById('v-loading').style.display = 'none';
    document.getElementById('v-erro').style.display = 'none';
    var lista = document.getElementById('v-lista');
    var vazia = document.getElementById('v-vazia');
    if (!data || data.length === 0) {
        lista.style.display = 'none';
        vazia.style.display = '';
        return;
    }
    lista.style.display = '';
    vazia.style.display = 'none';
    var html = '';
    data.forEach(function(v, idx) {
        var badge = v.emUso
            ? '<span class="badge badge-em-uso">Em uso</span>'
            : '<span class="badge badge-nao-usado">Sem uso</span>';
        var tamanhoFmt = v.tamanho > 0 ? fmt(v.tamanho) : '<span style="opacity:0.4">-</span>';
        var criado = fmtData(v.criado);
        var sel = vSelecionados.has(v.nome);
        // Linha principal
        html += '<div class="vol-row' + (sel ? ' selecionado' : '') + '" data-idx="' + idx + '" data-nome="' + esc(v.nome) + '">' +
            '<div class="vol-col-chk"><input type="checkbox" class="chk-vol" data-id="' + esc(v.nome) + '"' + (sel ? ' checked' : '') + '></div>' +
            '<div class="vol-col-chevron"><span class="vol-chevron">&#9658;</span></div>' +
            '<div class="vol-col-nome"><span class="vol-nome">' + esc(v.nome) + '</span></div>' +
            '<div class="vol-col-status">' + badge + '</div>' +
            '<div class="vol-col-driver" style="font-family:var(--font-mono);font-size:0.82em">' + esc(v.driver) + '</div>' +
            '<div class="vol-col-tamanho" style="font-family:var(--font-mono);font-size:0.82em">' + tamanhoFmt + '</div>' +
            '<div class="vol-col-criado" style="font-family:var(--font-mono);font-size:0.75em;color:var(--muted)">' + criado + '</div>' +
        '</div>';
        // Linha de detalhe (hidden por padrão)
        html += '<div id="vol-detail-' + idx + '" class="vol-detail" style="display:none">';
        html += '<div class="vol-detail-grid">';
        // STATUS
        html += '<div class="vol-detail-card">' +
            '<div class="vol-detail-label">Status</div>' +
            '<div class="vol-detail-val">' + (v.emUso ? '<span class="green">&#9679; Em uso</span>' : '<span class="orange">&#9675; Sem uso</span>') + '</div>' +
        '</div>';
        // DRIVER
        html += '<div class="vol-detail-card">' +
            '<div class="vol-detail-label">Driver</div>' +
            '<div class="vol-detail-val cyan">' + esc(v.driver) + '</div>' +
        '</div>';
        // ESCOPO
        html += '<div class="vol-detail-card">' +
            '<div class="vol-detail-label">Escopo / Tipo</div>' +
            '<div class="vol-detail-val">' + esc(v.escopo) + '</div>' +
        '</div>';
        // CONTAINERS
        var ctrsHtml;
        if (v.containers && v.containers.length > 0) {
            ctrsHtml = v.containers.map(function(c) {
                var corEstado = c.estado === 'running' ? 'var(--verde)' : 'var(--muted)';
                return '<div style="display:flex;align-items:center;gap:5px;margin-bottom:3px">' +
                    '<span style="color:' + corEstado + ';font-size:0.7em">&#9679;</span>' +
                    '<button class="vol-cnt-link" data-id="' + esc(c.id) + '" title="Abrir container ' + esc(c.nome) + '">' +
                        esc(c.nome) +
                    '</button>' +
                '</div>';
            }).join('');
        } else {
            ctrsHtml = '<span style="opacity:0.4">Nenhum</span>';
        }
        html += '<div class="vol-detail-card">' +
            '<div class="vol-detail-label">Containers</div>' +
            '<div class="vol-detail-val">' + ctrsHtml + '</div>' +
        '</div>';
        // TAMANHO DO VOLUME
        html += '<div class="vol-detail-card">' +
            '<div class="vol-detail-label">Dados no Volume</div>' +
            '<div class="vol-detail-val cyan">' + (v.tamanho > 0 ? fmt(v.tamanho) : '<span style="opacity:0.4">Não calculado</span>') + '</div>' +
        '</div>';
        // CRIADO EM
        html += '<div class="vol-detail-card">' +
            '<div class="vol-detail-label">Criado em</div>' +
            '<div class="vol-detail-val">' + criado + '</div>' +
        '</div>';
        html += '</div>';
        // DISCO DO FILESYSTEM
        if (v.diskStats) {
            var ds = v.diskStats;
            var pct = ds.total > 0 ? Math.round((ds.usado / ds.total) * 100) : 0;
            var altaOcupacao = pct > 80;
            html += '<div class="vol-disk-bar-wrap">' +
                '<div class="vol-disk-bar-label">' +
                    '<span>&#128190; Filesystem: ' + fmt(ds.total) + ' total &nbsp;|&nbsp; ' +
                    '<span class="' + (altaOcupacao ? 'orange' : '') + '">' + fmt(ds.usado) + ' usado</span>' +
                    ' &nbsp;|&nbsp; <span class="green">' + fmt(ds.disponivel) + ' livre</span></span>' +
                    '<span>' + pct + '%</span>' +
                '</div>' +
                '<div class="vol-disk-bar">' +
                    '<div class="vol-disk-bar-fill' + (altaOcupacao ? ' high' : '') + '" style="width:' + pct + '%"></div>' +
                '</div>' +
            '</div>';
        }
        // MOUNT POINT
        html += '<div class="vol-mountpoint">&#128204; Mount Point: ' + esc(v.mountpoint) + '</div>';
        // Labels/Options se presentes
        var labelKeys = Object.keys(v.labels || {});
        if (labelKeys.length > 0) {
            html += '<div class="vol-detail-row">Labels: ';
            labelKeys.forEach(function(k) { html += '<span>' + esc(k) + '=' + esc(v.labels[k]) + '</span>'; });
            html += '</div>';
        }
        html += '</div>'; // vol-detail
    });
    document.getElementById('v-tbody').innerHTML = html;
    vAtualizarInfo();
}

/* ══ DETALHE CONTAINER ══════════════════════════════════════════════ */
var detalheContainerId = null;
var dTabAtual = 'geral';

document.getElementById('d-back').addEventListener('click', function() {
    navegar('containers');
});

function dMostrarTab(tab) {
    if (dTabAtual === tab) return;
    if (dTabAtual === 'logs') pararAutoRefreshLogs();
    dTabAtual = tab;
    document.querySelectorAll('#d-tabs-nav .tab-btn').forEach(function(b) {
        b.classList.toggle('ativo', b.getAttribute('data-tab') === tab);
    });
    document.querySelectorAll('.tab-panel').forEach(function(p2) {
        p2.classList.toggle('ativo', p2.id === 'd-tab-' + tab);
    });
    if (tab === 'logs' && detalheContainerId) {
        carregarLogs(detalheContainerId, true); // primeiro carregamento: mostra indicador
        var ms = parseInt(document.getElementById('l-auto-select').value, 10);
        if (ms > 0) iniciarAutoRefreshLogs(detalheContainerId, ms);
    }
}
document.querySelectorAll('#d-tabs-nav .tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { dMostrarTab(btn.getAttribute('data-tab')); });
});

// Controles do painel de logs
document.getElementById('l-auto-select').addEventListener('change', function() {
    pararAutoRefreshLogs();
    var ms = parseInt(this.value, 10);
    if (ms > 0 && detalheContainerId && dTabAtual === 'logs') {
        iniciarAutoRefreshLogs(detalheContainerId, ms);
    }
});
document.getElementById('l-refresh-btn').addEventListener('click', function() {
    if (detalheContainerId) carregarLogs(detalheContainerId, true); // botão manual: mostra indicador
});

function renderDetalhe(d) {
    document.getElementById('d-loading').style.display = 'none';
    document.getElementById('d-content').style.display = '';

    var bc = 'badge-' + (['exited','running','paused','created','dead','restarting'].indexOf(d.estado) !== -1 ? d.estado : 'exited');
    document.getElementById('d-title').innerHTML =
        '<span class="d-nome">' + esc(d.nome) + '</span>' +
        ' <span class="badge ' + bc + '">' + esc(d.estado) + '</span>';

    var dAct = d.estado === 'running' ? '<button class="btn-detail-action" id="d-btn-shell">&#9166; Shell</button>' : '';
    document.getElementById('d-actions').innerHTML = dAct;
    if (d.estado === 'running' && document.getElementById('d-btn-shell')) {
        document.getElementById('d-btn-shell').addEventListener('click', function() {
            vscode.postMessage({ command: 'acaoRapidaContainer', id: detalheContainerId, acaoRapida: 'shell' });
        });
    }

    // Tab Geral
    var redesHtml = d.redes.length > 0
        ? '<h3 class="tab-subtitle">Redes</h3><table class="kv-table">' +
          d.redes.map(function(r) { return kv(esc(r.nome), '<code>' + esc(r.ip) + '</code>&nbsp; <code>subnet: ' + esc(r.subnet) + '</code>'); }).join('') +
          '</table>'
        : '';
    document.getElementById('d-geral-info').innerHTML =
        '<table class="kv-table">' +
        kv('Nome', esc(d.nome)) +
        kv('ID', '<code>' + esc((d.id || '').substring(0, 24)) + '...</code>') +
        kv('Imagem', esc(d.imagem)) +
        kv('Estado', '<span class="badge ' + bc + '">' + esc(d.estado) + '</span>') +
        kv('Criado', new Date(d.criado).toLocaleString('pt-BR')) +
        kv('Hostname', esc(d.hostname)) +
        kv('Pol\u00edtica Reiniciar', esc(d.restartPolicy)) +
        kv('Comando', '<code>' + esc(d.comando) + '</code>') +
        '</table>' + redesHtml;

    // Tab Portas
    document.getElementById('d-tab-portas').innerHTML = d.portas.length === 0
        ? '<p class="empty-state">Nenhuma porta mapeada</p>'
        : '<table><thead><tr><th>Hospedeiro</th><th>Container</th><th>Protocolo</th></tr></thead><tbody>' +
          d.portas.map(function(p3) {
              var hostPort = p3.hospedeiro.split(':')[1];
              var link = '<a class="porta-link" href="http://localhost:' + hostPort + '">' + esc(p3.hospedeiro) + '</a>';
              return '<tr><td>' + link + '</td><td>' + esc(p3.container) + '</td><td>' + esc(p3.protocolo) + '</td></tr>';
          }).join('') + '</tbody></table>';

    // Tab Env
    document.getElementById('d-tab-env').innerHTML = d.env.length === 0
        ? '<p class="empty-state">Sem vari\u00e1veis de ambiente</p>'
        : '<table><thead><tr><th>Vari\u00e1vel</th><th>Valor</th></tr></thead><tbody>' +
          d.env.map(function(e2) {
              var eq = e2.indexOf('=');
              var varName = eq >= 0 ? e2.substring(0, eq) : e2;
              var val = eq >= 0 ? e2.substring(eq + 1) : '';
              return '<tr><td style="font-family:var(--font-mono);color:var(--cyan)">' + esc(varName) +
                  '</td><td style="font-family:var(--font-mono)">' + esc(val) + '</td></tr>';
          }).join('') + '</tbody></table>';

    // Tab Inspect JSON
    document.getElementById('d-tab-inspect').innerHTML = '<pre class="inspect-json">' + esc(d.inspect) + '</pre>';

    // Atualiza ID completo, reset estado de logs e gerencia monitor
    detalheContainerId = d.id;
    pararAutoRefreshLogs();
    document.getElementById('l-content').innerHTML = 'Abra esta aba para carregar os logs do container.';
    document.getElementById('l-content').style.opacity = '0.5';
    document.getElementById('l-auto-select').value = '0';
    if (d.estado === 'running') {
        document.getElementById('d-geral-monitor').style.display = '';
        iniciarMonitor(d.id);
    } else {
        pararMonitor();
        document.getElementById('d-geral-monitor').style.display = 'none';
    }
    dTabAtual = null; // força dMostrarTab a processar mesmo que já esteja em 'geral'
    dMostrarTab('geral');
}

function kv(k, v) {
    return '<tr><td class="kv-key">' + k + '</td><td class="kv-val">' + v + '</td></tr>';
}

/* ══ MODAL ESCALA ════════════════════════════════════════════════════════ */
var _scaleAcao = '', _scaleNome = '', _scaleNs = '';

function abrirModalEscala(acao, nome, ns, cur) {
    _scaleAcao = acao; _scaleNome = nome; _scaleNs = ns;
    var tipo = acao === 'depl-scale' ? 'Deployment' : 'StatefulSet';
    document.getElementById('scale-subtitle').textContent = tipo + ': ' + nome + '  (atual: ' + cur + ')';
    var inp = document.getElementById('scale-input');
    inp.value = cur;
    document.getElementById('scale-warn').textContent = '';
    var overlay = document.getElementById('scale-overlay');
    overlay.style.display = 'flex';
    inp.focus();
    inp.select();
}

function fecharModalEscala() {
    document.getElementById('scale-overlay').style.display = 'none';
}

document.getElementById('scale-cancel').addEventListener('click', fecharModalEscala);

document.getElementById('scale-overlay').addEventListener('click', function(e) {
    if (e.target === this) fecharModalEscala();
});

document.getElementById('scale-input').addEventListener('input', function() {
    var v = parseInt(this.value, 10);
    var warn = document.getElementById('scale-warn');
    if (isNaN(v) || v < 0) {
        warn.textContent = 'Valor inv\u00e1lido.';
    } else if (v === 0) {
        warn.textContent = '\u26a0\ufe0f Escalar para 0 remover\u00e1 todos os pods.';
    } else {
        warn.textContent = '';
    }
});

document.getElementById('scale-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') document.getElementById('scale-confirm').click();
    if (e.key === 'Escape') fecharModalEscala();
});

document.getElementById('scale-confirm').addEventListener('click', function() {
    var inp = document.getElementById('scale-input');
    var v = parseInt(inp.value, 10);
    if (isNaN(v) || v < 0) { inp.focus(); return; }
    fecharModalEscala();
    vscode.postMessage({ command: 'k8sAcao', acao: _scaleAcao, nome: _scaleNome, namespace: _scaleNs, valor: String(v) });
});

/* ══ MONITOR ═════════════════════════════════════════════════════════════ */
var monitorActive   = false;
var monitorPts = { cpu: [], mem: [], netRx: [], netTx: [] };
var MPTS = 60;            // pontos máximos no gráfico (60 × 1s = 60s de histórico)
var mPrevRx = -1, mPrevTx = -1;

function iniciarMonitor(id) {
    pararMonitor();
    monitorPts = { cpu: [], mem: [], netRx: [], netTx: [] };
    mPrevRx = -1; mPrevTx = -1;
    monitorActive = true;
    // Usa stream persistente (mais confiável que polling no Docker Desktop/WSL2)
    vscode.postMessage({ command: 'iniciarMonitorStream', id: id });
}

function pararMonitor() {
    monitorActive = false;
    vscode.postMessage({ command: 'pararMonitorStream' });
}

/* ══ MONITOR POD (Kubernetes Metrics API) ════════════════════════════════ */
var pdMonitorPts = { cpu: [], mem: [] };
var PD_MPTS = 60;
var pdMemMax = 1; // máximo dinâmico de memória (bytes)

function processarPodStats(s) {
    // CPU em millicores
    var cpu = Math.max(0, s.cpuMillicores || 0);
    pdMonitorPts.cpu.push(cpu);
    if (pdMonitorPts.cpu.length > PD_MPTS) pdMonitorPts.cpu.shift();

    // Memória em bytes
    var mem = Math.max(0, s.memBytes || 0);
    pdMonitorPts.mem.push(mem);
    if (pdMonitorPts.mem.length > PD_MPTS) pdMonitorPts.mem.shift();

    // Atualiza máximo dinâmico de memória (acrescenta 20% para margem visual)
    var maxObs = Math.max.apply(null, pdMonitorPts.mem);
    if (maxObs > pdMemMax) pdMemMax = maxObs * 1.2;

    // Máximo dinâmico de CPU (mínimo de 100m para evitar gráfico vazio)
    var cpuMax = Math.max.apply(null, pdMonitorPts.cpu);
    cpuMax = Math.max(cpuMax * 1.2, 100);

    // Atualiza rótulos
    var cpuEl = document.getElementById('pd-cpu-val');
    var memEl = document.getElementById('pd-mem-val');
    var stEl  = document.getElementById('pd-monitor-status');
    if (cpuEl) cpuEl.textContent = cpu + 'm';
    if (memEl) memEl.textContent = fmt(mem);
    if (stEl)  stEl.textContent  = '';

    // Redesenha gráficos com formatadores adequados (milicores / bytes)
    mDesenhar('pd-cpu-canvas', pdMonitorPts.cpu, cpuMax, '#00F7FF', function(v) { return Math.round(v) + 'm'; });
    mDesenhar('pd-mem-canvas', pdMonitorPts.mem, pdMemMax, '#7C3AED', function(v) { return fmt(v); });
}


var logsInterval = null;

function carregarLogs(id, mostrarLoading) {
    // Mostra indicador apenas no primeiro carregamento (conteúdo ainda não visível)
    if (mostrarLoading) {
        var ll = document.getElementById('l-loading');
        if (ll) ll.style.display = '';
    }
    vscode.postMessage({ command: 'carregarLogs', id: id });
}

function iniciarAutoRefreshLogs(id, ms) {
    pararAutoRefreshLogs();
    logsInterval = setInterval(function() {
        if (detalheContainerId && dTabAtual === 'logs') carregarLogs(detalheContainerId, false); // auto-refresh silencioso
    }, ms);
}

function pararAutoRefreshLogs() {
    if (logsInterval) { clearInterval(logsInterval); logsInterval = null; }
}

function processarStats(s) {
    // CPU
    var cpu = Math.min(100, Math.max(0, s.cpu));
    monitorPts.cpu.push(cpu);
    if (monitorPts.cpu.length > MPTS) monitorPts.cpu.shift();

    // Memória
    var memPct = s.memLimit > 0 ? (s.memUsed / s.memLimit) * 100 : 0;
    monitorPts.mem.push(memPct);
    if (monitorPts.mem.length > MPTS) monitorPts.mem.shift();

    // Rede (delta por intervalo de 1s)
    var rxDelta = mPrevRx < 0 ? 0 : Math.max(0, s.netRx - mPrevRx);
    var txDelta = mPrevTx < 0 ? 0 : Math.max(0, s.netTx - mPrevTx);
    mPrevRx = s.netRx; mPrevTx = s.netTx;
    var rxPerS = rxDelta, txPerS = txDelta;
    monitorPts.netRx.push(rxPerS);
    monitorPts.netTx.push(txPerS);
    if (monitorPts.netRx.length > MPTS) monitorPts.netRx.shift();
    if (monitorPts.netTx.length > MPTS) monitorPts.netTx.shift();

    // Atualiza rótulos de valor
    document.getElementById('m-cpu-val').textContent = cpu.toFixed(1) + '%';
    document.getElementById('m-mem-val').textContent =
        fmt(s.memUsed) + ' / ' + fmt(s.memLimit) + '  (' + memPct.toFixed(1) + '%)';
    document.getElementById('m-net-val').textContent =
        '\u2193 ' + fmt(rxPerS) + '/s   \u2191 ' + fmt(txPerS) + '/s';

    // Redesenha gráficos
    mDesenhar('m-cpu-canvas', monitorPts.cpu, 100, '#00F7FF');
    mDesenhar('m-mem-canvas', monitorPts.mem, 100, '#7C3AED');
    mDesenharNet('m-net-canvas', monitorPts.netRx, monitorPts.netTx);
}

// Constantes de padding para eixo Y com labels
var PAD_L = 44, PAD_T = 8, PAD_B = 8, PAD_R = 6;

// Converte cor hex para rgba(r,g,b,a)
function mRgba(hex, a) {
    var m = { '#00F7FF': '0,247,255', '#7C3AED': '124,58,237', '#00FF88': '0,255,136', '#FF2DAA': '255,45,170' };
    return 'rgba(' + (m[hex] || '0,247,255') + ',' + a + ')';
}

// Obtém contexto do canvas, redimensionando conforme o layout atual
function mCtx(id) {
    var c = document.getElementById(id);
    if (!c) return null;
    var W = c.offsetWidth;
    if (!W || W < 10) return null;
    var H = c.offsetHeight || 130;
    c.width = W; c.height = H;
    return { ctx: c.getContext('2d'), W: W, H: H };
}

// Desenha grade tracejada com rótulos no eixo Y
function mGrade(ctx, W, H, maxV, fmtFn) {
    var cH = H - PAD_T - PAD_B;
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 6]);
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (var i = 0; i <= 4; i++) {
        var yFrac = i / 4;
        var y = PAD_T + cH * (1 - yFrac);
        var ly = (y | 0) + 0.5;
        ctx.beginPath(); ctx.moveTo(PAD_L, ly); ctx.lineTo(W - PAD_R, ly); ctx.stroke();
        var val = maxV * yFrac;
        var label = fmtFn ? fmtFn(val) : (Math.round(val)) + '%';
        ctx.fillText(label, PAD_L - 4, ly + 3);
    }
    var cW = W - PAD_L - PAD_R;
    for (var j = 0; j <= 6; j++) {
        var x = PAD_L + (cW * j / 6);
        var lx = (x | 0) + 0.5;
        ctx.beginPath(); ctx.moveTo(lx, PAD_T); ctx.lineTo(lx, PAD_T + cH); ctx.stroke();
    }
    ctx.setLineDash([]);
}

// Desenha uma série de pontos como linha suave com área preenchida
function mLinha(ctx, pts, W, H, maxV, cor) {
    if (pts.length < 2) return;
    var cW = W - PAD_L - PAD_R, cH = H - PAD_T - PAD_B;
    var off = MPTS - pts.length;
    var chartBottom = PAD_T + cH;
    function gx(i) { return PAD_L + (i / (MPTS - 1)) * cW; }
    function gy(v) { return PAD_T + cH - Math.min(v / maxV, 1) * cH; }

    // Área preenchida com gradiente
    var grad = ctx.createLinearGradient(0, PAD_T, 0, chartBottom);
    grad.addColorStop(0, mRgba(cor, 0.28));
    grad.addColorStop(1, mRgba(cor, 0.02));
    ctx.beginPath();
    ctx.moveTo(gx(off), gy(pts[0]));
    for (var k = 1; k < pts.length; k++) {
        var px0 = gx(off + k - 1), py0 = gy(pts[k - 1]);
        var px1 = gx(off + k),     py1 = gy(pts[k]);
        var cpx = (px0 + px1) / 2;
        ctx.bezierCurveTo(cpx, py0, cpx, py1, px1, py1);
    }
    ctx.lineTo(gx(off + pts.length - 1), chartBottom);
    ctx.lineTo(gx(off), chartBottom);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Linha
    ctx.beginPath();
    ctx.moveTo(gx(off), gy(pts[0]));
    for (var l = 1; l < pts.length; l++) {
        var px2 = gx(off + l - 1), py2 = gy(pts[l - 1]);
        var px3 = gx(off + l),     py3 = gy(pts[l]);
        var cpx2 = (px2 + px3) / 2;
        ctx.bezierCurveTo(cpx2, py2, cpx2, py3, px3, py3);
    }
    ctx.strokeStyle = cor; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();

    // Ponto no valor mais recente
    var dlx = gx(off + pts.length - 1), dly = gy(pts[pts.length - 1]);
    ctx.beginPath(); ctx.arc(dlx, dly, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = cor; ctx.fill();
    ctx.beginPath(); ctx.arc(dlx, dly, 6.5, 0, Math.PI * 2);
    ctx.strokeStyle = mRgba(cor, 0.35); ctx.lineWidth = 1.5; ctx.stroke();
}

// Desenha gráfico de linha simples (CPU ou Memória)
function mDesenhar(id, pts, maxV, cor, fmtFn) {
    var info = mCtx(id); if (!info) return;
    var ctx = info.ctx, W = info.W, H = info.H;
    ctx.fillStyle = '#060F1C'; ctx.fillRect(0, 0, W, H);
    mGrade(ctx, W, H, maxV, fmtFn || null);
    mLinha(ctx, pts, W, H, maxV, cor);
}

// Desenha gráfico de rede com duas séries (RX verde, TX rosa) e rótulos de bandwidth no eixo Y
function mDesenharNet(id, ptRx, ptTx) {
    var info = mCtx(id); if (!info) return;
    var ctx = info.ctx, W = info.W, H = info.H;
    ctx.fillStyle = '#060F1C'; ctx.fillRect(0, 0, W, H);
    var maxV = Math.max.apply(null, ptRx.concat(ptTx).concat([1]));
    mGrade(ctx, W, H, maxV, function(v) {
        if (!v || v < 1) return '0';
        if (v < 1024) return v.toFixed(0) + 'B';
        if (v < 1048576) return (v / 1024).toFixed(0) + 'K';
        return (v / 1048576).toFixed(0) + 'M';
    });
    mLinha(ctx, ptRx, W, H, maxV, '#00FF88');
    mLinha(ctx, ptTx, W, H, maxV, '#FF2DAA');
    // Legenda embutida
    var lx = PAD_L + 8;
    ctx.font = '10px monospace';
    ctx.fillStyle = '#00FF88'; ctx.fillText('\u2193 RX', lx, PAD_T + 14);
    ctx.fillStyle = '#FF2DAA'; ctx.fillText('\u2191 TX', lx + 46, PAD_T + 14);
}

/* ══ TOPOLOGIA ══════════════════════════════════════════════════════════════ */
(function() {
    var _nodes = [], _edges = [], _pos = {};
    var _drag = null, _panStart = null;
    var _pan = { x: 0, y: 0 }, _zoom = 1;
    var _hoverId = null;
    var _W = 0, _H = 0;

    // Paleta por tipo de nó
    var COR  = { service:'#00d4d4', deployment:'#9333ea', statefulset:'#22c55e', ingress:'#f59e0b', external:'#64748b' };
    var FILL = { service:'rgba(0,212,212,0.12)', deployment:'rgba(147,51,234,0.12)', statefulset:'rgba(34,197,94,0.12)', ingress:'rgba(245,158,11,0.12)', external:'rgba(100,116,139,0.10)' };

    var HEX_R = 30;          // raio do hexágono
    var STEP_X = 200;        // espaçamento horizontal entre camadas
    var STEP_Y = 88;         // espaçamento vertical entre nós na mesma camada

    // ── Abrir / fechar ────────────────────────────────────────────────────
    function abrir() {
        var ov = document.getElementById('topo-overlay');
        ov.style.display = 'flex';
        document.getElementById('topo-loading').style.display = 'flex';
        document.getElementById('topo-loading').textContent = 'Carregando topologia...';
        document.getElementById('topo-vazio').style.display = 'none';
        vscode.postMessage({ command: 'k8sTopologia' });
    }
    function fechar() {
        document.getElementById('topo-overlay').style.display = 'none';
    }
    document.getElementById('topo-fechar').addEventListener('click', fechar);
    document.addEventListener('click', function(e) {
        if (e.target && e.target.id === 'btn-topologia') abrir();
    });

    // ── Recebe dados ───────────────────────────────────────────────────────
    window.addEventListener('message', function(ev) {
        var msg = ev.data;
        if (msg.command !== 'dadosTopologia') return;
        document.getElementById('topo-loading').style.display = 'none';
        if (msg.erro) {
            var el = document.getElementById('topo-loading');
            el.style.display = 'flex'; el.textContent = 'Erro: ' + msg.erro; return;
        }
        document.getElementById('topo-ns-label').textContent = 'namespace: ' + (msg.namespace || '');
        _nodes = msg.nodes || []; _edges = msg.edges || [];
        if (!_nodes.length) { document.getElementById('topo-vazio').style.display = 'flex'; return; }
        var canvas = document.getElementById('topo-canvas');
        _W = canvas.offsetWidth || 900;
        _H = canvas.offsetHeight || 560;
        var dpr = window.devicePixelRatio || 1;
        canvas.width  = _W * dpr;
        canvas.height = _H * dpr;
        _pan = { x: 0, y: 0 }; _zoom = 1; _hoverId = null;
        _pos = calcularLayout(_nodes, _edges, _W, _H);
        desenhar(canvas);
        bindEventos(canvas);
    });

    // ── Layout hierárquico (esquerda → direita) ───────────────────────────
    function calcularLayout(nodes, edges, W, H) {
        if (!nodes.length) return {};

        // Constrói listas de adjacência
        var succ = {}, pred = {};
        nodes.forEach(function(n) { succ[n.id] = []; pred[n.id] = []; });
        edges.forEach(function(e) {
            if (succ[e.from]) { if (succ[e.from].indexOf(e.to)   < 0) succ[e.from].push(e.to);   }
            if (pred[e.to])   { if (pred[e.to].indexOf(e.from)   < 0) pred[e.to].push(e.from);   }
        });

        // BFS: atribui camada a cada nó (a camada de um nó = máximo entre os predecessores + 1)
        var layer = {};
        var queue = [], qi = 0, visited = {};
        nodes.forEach(function(n) {
            if (!pred[n.id].length) { layer[n.id] = 0; queue.push(n.id); visited[n.id] = true; }
        });
        if (!queue.length) { layer[nodes[0].id] = 0; queue.push(nodes[0].id); visited[nodes[0].id] = true; }
        while (qi < queue.length) {
            var cur = queue[qi++];
            succ[cur].forEach(function(nxt) {
                var nl = (layer[cur] || 0) + 1;
                if (layer[nxt] === undefined || layer[nxt] < nl) layer[nxt] = nl;
                if (!visited[nxt]) { visited[nxt] = true; queue.push(nxt); }
            });
        }
        nodes.forEach(function(n) { if (layer[n.id] === undefined) layer[n.id] = 0; });

        // Agrupa por camada
        var byLayer = [], maxL = 0;
        nodes.forEach(function(n) {
            var l = layer[n.id]; if (l > maxL) maxL = l;
            if (!byLayer[l]) byLayer[l] = [];
            byLayer[l].push(n.id);
        });

        // Minimiza cruzamentos: ordena cada camada pela posição média dos predecessores
        var tempOrd = {};
        nodes.forEach(function(n) { tempOrd[n.id] = 0; });
        for (var l = 1; l <= maxL; l++) {
            var col = byLayer[l] || [];
            col.sort(function(a, b) {
                var avgA = pred[a].length ? pred[a].reduce(function(s, p) { return s + (tempOrd[p] || 0); }, 0) / pred[a].length : 0;
                var avgB = pred[b].length ? pred[b].reduce(function(s, p) { return s + (tempOrd[p] || 0); }, 0) / pred[b].length : 0;
                return avgA - avgB;
            });
            col.forEach(function(id, i) { tempOrd[id] = i; });
        }

        // Calcula coordenadas
        var numCols = maxL + 1;
        var maxRows = 0;
        for (var l2 = 0; l2 <= maxL; l2++) maxRows = Math.max(maxRows, (byLayer[l2] || []).length);

        // Escala automática para caber na tela
        var totalW = (numCols  - 1) * STEP_X;
        var totalH = (maxRows  - 1) * STEP_Y;
        var scaleX = totalW > 0 ? Math.min(1, (W - 120) / totalW) : 1;
        var scaleY = totalH > 0 ? Math.min(1, (H - 100) / totalH) : 1;
        var sc = Math.min(scaleX, scaleY, 1);

        var sX = STEP_X * sc, sY = STEP_Y * sc;

        var pos = {};
        for (var l3 = 0; l3 <= maxL; l3++) {
            var col3 = byLayer[l3] || [];
            var n3 = col3.length;
            var colH = (n3 - 1) * sY;
            col3.forEach(function(id, i) {
                pos[id] = { x: l3 * sX, y: -colH / 2 + i * sY };
            });
        }

        // Centraliza o grafo na tela
        var xs = Object.values(pos).map(function(p) { return p.x; });
        var ys = Object.values(pos).map(function(p) { return p.y; });
        var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
        var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
        var gW = maxX - minX, gH = maxY - minY;
        var ox = (W - gW) / 2 - minX, oy = (H - gH) / 2 - minY;
        Object.keys(pos).forEach(function(id) { pos[id].x += ox; pos[id].y += oy; });
        return pos;
    }

    // ── Eventos de mouse ──────────────────────────────────────────────────
    function bindEventos(canvas) {
        canvas.onmousedown = function(e) {
            var pt = toPt(canvas, e);
            var id = hitTest(pt);
            if (id !== null) {
                _drag = { id: id, ox: pt.x - _pos[id].x, oy: pt.y - _pos[id].y };
            } else {
                _panStart = { mx: e.clientX, my: e.clientY, px: _pan.x, py: _pan.y };
            }
        };
        canvas.onmousemove = function(e) {
            var pt = toPt(canvas, e);
            if (_drag) {
                _pos[_drag.id].x = pt.x - _drag.ox;
                _pos[_drag.id].y = pt.y - _drag.oy;
                desenhar(canvas);
            } else if (_panStart) {
                _pan.x = _panStart.px + (e.clientX - _panStart.mx);
                _pan.y = _panStart.py + (e.clientY - _panStart.my);
                desenhar(canvas);
            } else {
                var hi = hitTest(pt);
                if (hi !== _hoverId) {
                    _hoverId = hi;
                    atualizarTooltip(canvas, hi, e);
                    desenhar(canvas);
                }
            }
        };
        canvas.onmouseup   = function() { _drag = null; _panStart = null; };
        canvas.onmouseleave = function() {
            _drag = null; _panStart = null;
            if (_hoverId) { _hoverId = null; atualizarTooltip(null, null, null); desenhar(canvas); }
        };
        canvas.onwheel = function(e) {
            e.preventDefault();
            _zoom = Math.max(0.2, Math.min(4, _zoom * (e.deltaY > 0 ? 0.88 : 1.13)));
            desenhar(canvas);
        };
        (new ResizeObserver(function() {
            _W = canvas.offsetWidth; _H = canvas.offsetHeight;
            var dpr = window.devicePixelRatio || 1;
            canvas.width = _W * dpr; canvas.height = _H * dpr;
            desenhar(canvas);
        })).observe(canvas);
    }

    function toPt(canvas, e) {
        var r = canvas.getBoundingClientRect();
        var mx = (e.clientX - r.left) / (r.width  / _W);
        var my = (e.clientY - r.top)  / (r.height / _H);
        return { x: (mx - _W/2 - _pan.x) / _zoom + _W/2, y: (my - _H/2 - _pan.y) / _zoom + _H/2 };
    }
    function hitTest(pt) {
        var best = null, bestD = HEX_R + 6;
        _nodes.forEach(function(n) {
            var p = _pos[n.id]; if (!p) return;
            var d = Math.sqrt((p.x - pt.x) * (p.x - pt.x) + (p.y - pt.y) * (p.y - pt.y));
            if (d < bestD) { bestD = d; best = n.id; }
        });
        return best;
    }
    function atualizarTooltip(canvas, id, e) {
        var tt = document.getElementById('topo-tooltip');
        if (!id || !canvas || !e) { tt.style.display = 'none'; return; }
        var node = _nodes.find(function(n) { return n.id === id; }); if (!node) { tt.style.display = 'none'; return; }
        var cor = COR[node.tipo] || '#e2e8f0';
        var conns = _edges.filter(function(ed) { return ed.from === id || ed.to === id; });
        var html = '<div style="font-weight:700;color:' + cor + ';margin-bottom:5px">' + node.label + '</div>';
        html += '<div style="color:rgba(255,255,255,0.5);font-size:0.88em">Tipo: ' + node.tipo + '</div>';
        if (node.replicas) html += '<div style="color:rgba(255,255,255,0.5);font-size:0.88em">R\u00e9plicas: ' + node.replicas + '</div>';
        if (node.status)   html += '<div style="color:rgba(255,255,255,0.5);font-size:0.88em">Status: ' + node.status + '</div>';
        if (conns.length)  html += '<div style="color:rgba(255,255,255,0.35);font-size:0.82em;margin-top:4px">' + conns.length + ' conex\u00e3o(es)</div>';
        tt.innerHTML = html; tt.style.display = 'block';
        var rect = canvas.getBoundingClientRect();
        var tx = e.clientX - rect.left + 14, ty = e.clientY - rect.top - 12;
        if (tx + 270 > rect.width)  tx = e.clientX - rect.left - 275;
        if (ty < 0)                 ty = e.clientY - rect.top  + 14;
        tt.style.left = tx + 'px'; tt.style.top = ty + 'px';
    }

    // ── Renderização ───────────────────────────────────────────────────────
    function desenhar(canvas) {
        var ctx = canvas.getContext('2d');
        var dpr = window.devicePixelRatio || 1;
        ctx.save();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.scale(dpr, dpr);

        // Fundo escuro
        ctx.fillStyle = '#06101b';
        ctx.fillRect(0, 0, _W, _H);

        // Grade de pontos (sutil)
        ctx.fillStyle = 'rgba(255,255,255,0.035)';
        var gs = 24;
        for (var gx = gs / 2; gx < _W; gx += gs)
            for (var gy = gs / 2; gy < _H; gy += gs) {
                ctx.beginPath(); ctx.arc(gx, gy, 1, 0, Math.PI * 2); ctx.fill();
            }

        // Aplica pan + zoom ao redor do centro
        ctx.save();
        ctx.translate(_W / 2 + _pan.x, _H / 2 + _pan.y);
        ctx.scale(_zoom, _zoom);
        ctx.translate(-_W / 2, -_H / 2);

        // Arestas
        _edges.forEach(function(edge) { desenharAresta(ctx, edge); });
        // Nós (sobre as arestas)
        _nodes.forEach(function(node) {
            var p = _pos[node.id]; if (!p) return;
            desenharHex(ctx, p.x, p.y, node, node.id === _hoverId);
        });

        ctx.restore();
        ctx.restore();
    }

    function desenharAresta(ctx, edge) {
        var fp = _pos[edge.from], tp = _pos[edge.to]; if (!fp || !tp) return;
        var dx = tp.x - fp.x, dy = tp.y - fp.y;
        var dist = Math.sqrt(dx * dx + dy * dy) || 1;
        var ux = dx / dist, uy = dy / dist;
        var sx = fp.x + ux * (HEX_R + 3), sy = fp.y + uy * (HEX_R + 3);
        var ex = tp.x - ux * (HEX_R + 9), ey = tp.y - uy * (HEX_R + 9);

        ctx.save();
        ctx.strokeStyle = 'rgba(0,200,200,0.40)';
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();

        // Seta preenchida
        var hl = 9;
        ctx.fillStyle = 'rgba(0,200,200,0.55)';
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - ux * hl + uy * hl * 0.38, ey - uy * hl - ux * hl * 0.38);
        ctx.lineTo(ex - ux * hl - uy * hl * 0.38, ey - uy * hl + ux * hl * 0.38);
        ctx.closePath(); ctx.fill();
        ctx.restore();
    }

    function desenharHex(ctx, cx, cy, node, isHover) {
        var cor  = COR[node.tipo]  || '#64748b';
        var fill = FILL[node.tipo] || 'rgba(100,116,139,0.10)';

        ctx.save();

        // ── Hexágono flat-top ───────────────────────────────────────────
        caminhoHex(ctx, cx, cy, HEX_R);
        ctx.fillStyle = isHover ? toRgba(cor, 0.25) : fill;
        ctx.fill();
        ctx.strokeStyle = isHover ? cor : toRgba(cor, 0.65);
        ctx.lineWidth   = isHover ? 2.2 : 1.6;
        ctx.stroke();

        // ── Ícone de switch de rede ─────────────────────────────────────
        desenharIconeSwitch(ctx, cx, cy, HEX_R * 0.44, cor);

        // ── Badge de tipo (pequeno, dentro do hex) ──────────────────────
        var badge = { service: 'SVC', deployment: 'DEP', statefulset: 'STS', ingress: 'ING' }[node.tipo] || '';
        if (badge) {
            ctx.font = 'bold 6.5px sans-serif';
            ctx.fillStyle = toRgba(cor, 0.7);
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(badge, cx, cy + HEX_R * 0.67);
        }

        // ── Rótulo abaixo do hexágono ────────────────────────────────────
        var lbl = node.label.length > 24 ? node.label.slice(0, 22) + '\u2026' : node.label;
        ctx.font = isHover ? 'bold 10.5px sans-serif' : '10px sans-serif';
        ctx.fillStyle = isHover ? '#e2e8f0' : 'rgba(226,232,240,0.82)';
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(lbl, cx, cy + HEX_R + 6);

        if (node.replicas) {
            ctx.font = '9px monospace';
            ctx.fillStyle = toRgba(cor, 0.72);
            ctx.fillText(node.replicas, cx, cy + HEX_R + 19);
        }

        ctx.restore();
    }

    // Hexágono flat-top (primeiro vértice à direita)
    function caminhoHex(ctx, cx, cy, r) {
        ctx.beginPath();
        for (var i = 0; i < 6; i++) {
            var a = (Math.PI / 3) * i;
            var px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
            i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.closePath();
    }

    // Ícone de switch de rede: corpo retangular + 3 portas abaixo
    function desenharIconeSwitch(ctx, cx, cy, r, cor) {
        ctx.save();
        ctx.strokeStyle = cor; ctx.fillStyle = cor; ctx.lineWidth = 1.1;

        var bw = r * 1.9, bh = r * 0.52;
        var bx = cx - bw / 2, by = cy - r * 0.65;

        // Corpo do switch (retângulo arredondado)
        ctx.beginPath();
        if (ctx.roundRect) { ctx.roundRect(bx, by, bw, bh, 2); } else { ctx.rect(bx, by, bw, bh); }
        ctx.stroke();

        // 3 LEDs dentro do corpo
        var dotS = r * 0.18;
        for (var i = 0; i < 3; i++) {
            var lx = bx + bw * (i + 0.5) / 3 - dotS / 2;
            var ly = by + bh / 2 - dotS / 2;
            ctx.fillRect(lx, ly, dotS, dotS);
        }

        // 3 linhas verticais descendo do corpo (portas)
        var lineTop = by + bh, lineBot = cy + r * 0.65;
        var portR = r * 0.115;
        for (var j = 0; j < 3; j++) {
            var px = bx + bw * (j + 0.5) / 3;
            ctx.beginPath(); ctx.moveTo(px, lineTop); ctx.lineTo(px, lineBot); ctx.stroke();
            // Círculo na extremidade (conector)
            ctx.beginPath(); ctx.arc(px, lineBot, portR, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
    }

    function toRgba(hex, a) {
        if (!hex || hex[0] !== '#') return hex;
        var rv = parseInt(hex.slice(1, 3), 16) || 0;
        var gv = parseInt(hex.slice(3, 5), 16) || 0;
        var bv = parseInt(hex.slice(5, 7), 16) || 0;
        return 'rgba(' + rv + ',' + gv + ',' + bv + ',' + a + ')';
    }
})();


/* ══ SETTINGS ══════════════════════════════════════════════════════════════ */
function aplicarSettings(s) {
    var fs = (s.fontSize || 13) + 'px';
    var pads = { compact: '4px 12px', normal: '8px 12px', comfortable: '14px 12px' };
    document.documentElement.style.setProperty('--font-base', fs);
    document.documentElement.style.setProperty('--row-pad', pads[s.density || 'normal'] || '8px 12px');
}

document.getElementById('s-font-size').addEventListener('input', function() {
    var fsVal = parseInt(this.value);
    document.getElementById('s-font-size-val').textContent = fsVal + 'px';
    var d2 = document.getElementById('s-density').value;
    aplicarSettings({ fontSize: fsVal, density: d2 });
    salvarSettings();
});

document.getElementById('s-density').addEventListener('change', function() {
    var fs2 = parseInt(document.getElementById('s-font-size').value);
    aplicarSettings({ fontSize: fs2, density: this.value });
    salvarSettings();
});

function salvarSettings() {
    vscode.postMessage({
        command: 'salvarSettings',
        settings: {
            fontSize: parseInt(document.getElementById('s-font-size').value),
            density: document.getElementById('s-density').value,
        }
    });
}

// Aplicar configura\u00e7\u00f5es salvas ao carregar
(function() {
    var s = _savedSettings;
    document.getElementById('s-font-size').value = String(s.fontSize || 13);
    document.getElementById('s-font-size-val').textContent = (s.fontSize || 13) + 'px';
    document.getElementById('s-density').value = s.density || 'normal';
    aplicarSettings(s);
}());

</script>
</body>
</html>`;
    }

    private _destruir(): void {
        this._disposto = true;
        this._pararStatsStream();
        this._pararPodMetrics();
        if (this._k8sWatcher) {
            try { this._k8sWatcher.close(); } catch { /* ignora */ }
            this._k8sWatcher = null;
        }
        MainPanel.instancia = undefined;
        this._panel.dispose();
        for (const d of this._disposables) d.dispose();
        this._disposables = [];
    }
}

function gerarNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let r = '';
    for (let i = 0; i < 32; i++) r += chars.charAt(Math.floor(Math.random() * chars.length));
    return r;
}
