import * as vscode from 'vscode';
import Dockerode from 'dockerode';
import { ContainerService } from '../services/containerService';
import { ImageService, ImageInfo } from '../services/imageService';
import { VolumeService } from '../services/volumeService';
import { NetworkService } from '../services/networkService';
import { DockerClient } from '../docker/dockerClient';
import type { ContainerInfo } from '../services/containerService';

type Secao = 'dashboard' | 'containers' | 'images' | 'networks' | 'volumes' | 'detail' | 'settings';
type AcaoBulkContainer = 'start' | 'stop' | 'restart' | 'kill' | 'pause' | 'resume' | 'remove';

interface MsgFromWebview {
    command: string;
    secao?: Secao;
    acao?: AcaoBulkContainer;
    ids?: string[];
    id?: string;
    acaoRapida?: 'logs' | 'shell';
    settings?: { fontSize: number; density: string };
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
                        await this._acaoBulkContainers(msg.acao, msg.ids);
                    }
                    break;

                case 'carregarDetalheContainer':
                    if (msg.id) await this._carregarDetalhe(msg.id);
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
                        emUso: v.emUso,
                    }));
                    this._panel.webview.postMessage({ command: 'dadosVolumes', data: dados });
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
    private async _carregarDetalhe(id: string): Promise<void> {
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
        </div>
        <div class="toolbar-filtro">
            <input type="text" id="v-filtro" class="filtro" placeholder="Filtrar por nome...">
            <label class="sel-label"><input type="checkbox" id="v-sel-todos"> Selecionar todos</label>
        </div>
        <div id="v-info-bar" class="info-bar" style="display:none">
            <span id="v-info-texto"></span>
            <button id="v-btn-remover" class="btn-remover">&#128465; Remover selecionados</button>
        </div>
        <div id="v-loading" class="carregando">Carregando volumes...</div>
        <div id="v-erro" class="erro-msg" style="display:none"></div>
        <table id="v-tabela" style="display:none">
            <thead><tr>
                <th class="no-sort" style="width:40px"></th>
                <th>Nome</th><th>Status</th><th>Driver</th><th>Mount Point</th>
            </tr></thead>
            <tbody id="v-tbody"></tbody>
        </table>
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

    <!-- ══ SETTINGS ════════════════════════════════════════════ -->
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

<script nonce="${nonce}">
var vscode = acquireVsCodeApi();
var secaoAtual = null;
var secaoCarregada = {};
var _savedSettings = ${JSON.stringify(settings)};

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
    secaoAtual = secao;

    document.querySelectorAll('.secao').forEach(function(s) { s.classList.remove('ativa'); });
    var el = document.getElementById('sec-' + secao);
    if (el) el.classList.add('ativa');

    document.querySelectorAll('.nav-item[data-secao]').forEach(function(n) {
        n.classList.toggle('ativo', n.getAttribute('data-secao') === secao);
    });

    // Rola ao topo ao mudar seção
    var mc = document.getElementById('main-content');
    if (mc) mc.scrollTop = 0;

    // Carrega dados se ainda não foram carregados (ou forçar reload)
    if (!secaoCarregada[secao]) {
        secaoCarregada[secao] = true;
        vscode.postMessage({ command: 'carregarSecao', secao: secao });
    }
}

/* ── Sidebar ──────────────────────────────────────────────────────────── */
document.querySelectorAll('.nav-item[data-secao]').forEach(function(el) {
    el.addEventListener('click', function() { navegar(el.getAttribute('data-secao')); });
});

/* ── Handler de mensagens do backend ─────────────────────────────────── */
window.addEventListener('message', function(event) {
    var msg = event.data;
    switch (msg.command) {
        case 'navegar':
            navegar(msg.secao);
            break;
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
                '<button class="qa-btn" data-id="' + esc(c.id) + '" data-ar="logs"    title="Logs">&#128196;</button>' +
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

document.getElementById('v-filtro').addEventListener('input', function() {
    var q = this.value.toLowerCase();
    document.querySelectorAll('#v-tbody tr').forEach(function(tr7) {
        var nome = tr7.querySelector('td:nth-child(2)');
        tr7.style.display = nome && nome.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
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

function vAtualizarInfo() {
    var bar = document.getElementById('v-info-bar');
    var txt = document.getElementById('v-info-texto');
    if (vSelecionados.size > 0) {
        bar.style.display = 'flex'; txt.textContent = vSelecionados.size + ' volume(s) selecionado(s)';
    } else { bar.style.display = 'none'; }
}

function renderVolumes(data) {
    vTodos = data; vSelecionados.clear();
    document.getElementById('v-loading').style.display = 'none';
    document.getElementById('v-erro').style.display = 'none';
    var tabela = document.getElementById('v-tabela');
    if (data.length === 0) { tabela.style.display = 'none'; return; }
    tabela.style.display = 'table';
    var html = '';
    data.forEach(function(v) {
        var badge = v.emUso ? '<span class="badge badge-em-uso">Em uso</span>' : '<span class="badge badge-nao-usado">Sem uso</span>';
        html += '<tr data-id="' + esc(v.id) + '">' +
            '<td><input type="checkbox" class="chk-vol" data-id="' + esc(v.id) + '"></td>' +
            '<td style="font-family:var(--font-mono)">' + esc(v.nome) + '</td>' +
            '<td>' + badge + '</td>' +
            '<td>' + esc(v.driver) + '</td>' +
            '<td style="font-size:0.82em;font-family:var(--font-mono)">' + esc(v.mountpoint) + '</td></tr>';
    });
    document.getElementById('v-tbody').innerHTML = html;
    document.querySelectorAll('#v-tbody .chk-vol').forEach(function(cb) {
        cb.addEventListener('change', function() {
            if (cb.checked) { vSelecionados.add(cb.getAttribute('data-id')); } else { vSelecionados.delete(cb.getAttribute('data-id')); }
            var tr8 = cb.closest('tr'); if (tr8) tr8.className = cb.checked ? 'selecionado' : '';
            vAtualizarInfo();
        });
    });
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

/* ── Logs Inline ─────────────────────────────────────────────── */
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
function mDesenhar(id, pts, maxV, cor) {
    var info = mCtx(id); if (!info) return;
    var ctx = info.ctx, W = info.W, H = info.H;
    ctx.fillStyle = '#060F1C'; ctx.fillRect(0, 0, W, H);
    mGrade(ctx, W, H, maxV, null);
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

/* ══ SETTINGS ══════════════════════════════════════════════════════════════ */
function aplicarSettings(s) {
    var fs = (s.fontSize || 13) + 'px';
    document.documentElement.style.setProperty('--font-base', fs);
    var pads = { compact: '4px 12px', normal: '8px 12px', comfortable: '14px 12px' };
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
        this._pararStatsStream();
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
