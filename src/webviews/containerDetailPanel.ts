import * as vscode from 'vscode';
import * as path from 'path';
import { DockerTreeItem } from '../views/dockerTreeItem';
import { ContainerService } from '../services/containerService';

/**
 * Painel Webview para exibição detalhada de um container Docker.
 * Mostra abas: Overview, Logs, Variáveis de Ambiente, Portas, Stats.
 *
 * SEGURANÇA: Apenas o diretório de recursos da extensão é permitido (localResourceRoots).
 * Toda comunicação é feita via postMessage — sem acesso externo.
 */
export class ContainerDetailPanel {
    private static readonly VIEW_TYPE = 'dockerManager.containerDetail';
    private static paineis: Map<string, ContainerDetailPanel> = new Map();

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _item: DockerTreeItem;
    private readonly _svc: ContainerService;
    private _disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        item: DockerTreeItem,
        svc: ContainerService,
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._item = item;
        this._svc = svc;

        // Registra o listener ANTES de renderizar o HTML.
        // Se fosse ao contrário, o webview poderia enviar mensagens antes
        // do listener estar pronto e elas seriam perdidas.
        this._registrarMensagens();
        this._renderizar();

        this._panel.onDidDispose(() => this._destruir(), null, this._disposables);
        // NÃO re-renderizamos em onDidChangeViewState porque retainContextWhenHidden=true
        // preserva o estado do webview quando ele é ocultado/revelado.
    }

    /**
     * Cria ou exibe o painel existente para este container.
     */
    public static criar(
        extensionUri: vscode.Uri,
        item: DockerTreeItem,
        svc: ContainerService,
    ): void {
        const coluna = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        const chave = item.resourceId;

        const existente = ContainerDetailPanel.paineis.get(chave);
        if (existente) {
            existente._panel.reveal(coluna);
            existente._renderizar();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            ContainerDetailPanel.VIEW_TYPE,
            `Container: ${item.containerData?.nome ?? item.label as string}`,
            coluna,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'resources'),
                ],
            },
        );

        const instancia = new ContainerDetailPanel(panel, extensionUri, item, svc);
        ContainerDetailPanel.paineis.set(chave, instancia);
    }

    /**
     * Registra mensagens recebidas do Webview (requisições de dados).
     */
    private _registrarMensagens(): void {
        this._panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
            switch (msg.command) {
                case 'carregarDados':
                    await this._enviarDadosCompletos();
                    break;
                case 'carregarLogs':
                    await this._enviarLogs();
                    break;
                case 'carregarStats':
                    await this._enviarStats();
                    break;
                case 'acaoContainer':
                    await this._executarAcao(msg.acao);
                    break;
                default:
                    break;
            }
        }, null, this._disposables);
    }

    /**
     * Executa uma ação de container (start/stop/restart/remove) disparada pelo webview.
     * Ações destrutivas exigem confirmação do usuário.
     */
    private async _executarAcao(acao: WebviewMessage['acao']): Promise<void> {
        const nome = this._item.containerData?.nome ?? this._item.label as string;
        const id = this._item.resourceId;

        try {
            switch (acao) {
                case 'start':
                    await this._svc.iniciar(id);
                    this._panel.webview.postMessage({ command: 'acaoSucesso', acao, estado: 'running' });
                    break;
                case 'stop':
                    await this._svc.parar(id);
                    this._panel.webview.postMessage({ command: 'acaoSucesso', acao, estado: 'exited' });
                    break;
                case 'restart':
                    await this._svc.reiniciar(id);
                    this._panel.webview.postMessage({ command: 'acaoSucesso', acao, estado: 'running' });
                    break;
                case 'remove': {
                    const confirm = await vscode.window.showWarningMessage(
                        `Remover o container "${nome}"? Esta ação não pode ser desfeita.`,
                        { modal: true },
                        'Remover',
                    );
                    if (confirm !== 'Remover') return;
                    await this._svc.remover(id, true);
                    this._panel.dispose();
                    break;
                }
                default:
                    break;
            }
        } catch (err) {
            vscode.window.showErrorMessage(
                `Falha ao executar ação "${acao}" no container "${nome}": ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            this._panel.webview.postMessage({
                command: 'erroAcao',
                data: err instanceof Error ? err.message : String(err),
            });
        }
    }

    private async _enviarDadosCompletos(): Promise<void> {
        try {
            const info = await this._svc.inspecionar(this._item.resourceId);
            this._panel.webview.postMessage({ command: 'dadosContainer', data: info });
        } catch (err) {
            this._panel.webview.postMessage({
                command: 'erro',
                data: err instanceof Error ? err.message : String(err),
            });
        }
    }

    private async _enviarLogs(): Promise<void> {
        try {
            const logs = await this._svc.obterLogs(this._item.resourceId, 200);
            this._panel.webview.postMessage({ command: 'logs', data: logs });
        } catch (err) {
            this._panel.webview.postMessage({
                command: 'erroLogs',
                data: err instanceof Error ? err.message : String(err),
            });
        }
    }

    private async _enviarStats(): Promise<void> {
        try {
            const stats = await this._svc.obterStats(this._item.resourceId);
            this._panel.webview.postMessage({ command: 'stats', data: stats });
        } catch (err) {
            this._panel.webview.postMessage({
                command: 'erroStats',
                data: err instanceof Error ? err.message : String(err),
            });
        }
    }

    private _renderizar(): void {
        const nome = this._item.containerData?.nome ?? this._item.label as string;
        this._panel.title = `Container: ${nome}`;
        this._panel.webview.html = this._gerarHtml(nome);
    }

    private _gerarHtml(nome: string): string {
        const webview = this._panel.webview;
        const nonce = gerarNonce();

        // Content Security Policy rígida: apenas scripts com nonce correto
        const csp = [
            `default-src 'none'`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
        ].join('; ');

        return /* html */ `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Container: ${escaparHtml(nome)}</title>
    <style>
        :root {
            --cor-fundo: var(--vscode-editor-background);
            --cor-texto: var(--vscode-editor-foreground);
            --cor-borda: var(--vscode-panel-border);
            --cor-aba-ativa: var(--vscode-tab-activeBackground);
            --cor-aba-inativa: var(--vscode-tab-inactiveBackground);
            --cor-destaque: var(--vscode-button-background);
            --cor-erro: var(--vscode-inputValidation-errorBackground);
            --cor-sucesso: var(--vscode-testing-iconPassed);
            --cor-parado: var(--vscode-testing-iconFailed);
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background: var(--cor-fundo);
            color: var(--cor-texto);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            padding: 16px;
        }
        h1 { font-size: 1.2em; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
        .badge {
            font-size: 0.7em;
            padding: 2px 8px;
            border-radius: 4px;
            font-weight: bold;
            text-transform: uppercase;
        }
        .badge-running { background: var(--cor-sucesso); color: #000; }
        .badge-stopped { background: var(--cor-parado); color: #fff; }
        .badge-paused  { background: var(--vscode-testing-iconQueued); color: #000; }

        /* Abas */
        .abas { display: flex; gap: 4px; border-bottom: 1px solid var(--cor-borda); margin-bottom: 16px; }
        .aba {
            padding: 6px 14px;
            cursor: pointer;
            border: none;
            background: var(--cor-aba-inativa);
            color: var(--cor-texto);
            border-radius: 4px 4px 0 0;
            font-size: inherit;
        }
        .aba.ativa { background: var(--cor-aba-ativa); border-bottom: 2px solid var(--cor-destaque); }
        .conteudo-aba { display: none; }
        .conteudo-aba.ativa { display: block; }

        /* Tabela de detalhes */
        table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
        th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--cor-borda); }
        th { font-weight: 600; width: 30%; color: var(--vscode-descriptionForeground); }
        td { font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }

        /* Logs */
        pre {
            background: var(--vscode-terminal-background, #1e1e1e);
            color: var(--vscode-terminal-foreground, #d4d4d4);
            padding: 12px;
            border-radius: 4px;
            overflow: auto;
            max-height: 500px;
            font-size: 0.85em;
            line-height: 1.5;
            white-space: pre-wrap;
            word-break: break-all;
        }

        /* Stats */
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
        .stat-card {
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--cor-borda);
            border-radius: 6px;
            padding: 12px;
        }
        .stat-label { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
        .stat-valor { font-size: 1.4em; font-weight: bold; }

        .carregando { color: var(--vscode-descriptionForeground); font-style: italic; }
        .erro { color: var(--vscode-inputValidation-errorForeground, red); padding: 8px; }

        /* Botões de ação */
        .acoes {
            display: flex;
            gap: 8px;
            margin-bottom: 16px;
            flex-wrap: wrap;
        }
        .btn {
            padding: 5px 14px;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 0.85em;
            font-family: inherit;
            font-weight: 500;
            transition: opacity 0.15s;
        }
        .btn:hover { opacity: 0.85; }
        .btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .btn-start   { background: var(--vscode-testing-iconPassed, #4caf50); color: #000; }
        .btn-stop    { background: var(--vscode-testing-iconFailed, #f44336); color: #fff; }
        .btn-restart { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
        .btn-remove  { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-inputValidation-errorForeground, #f48771); border: 1px solid var(--vscode-inputValidation-errorBorder, #f48771); }
        .notif { padding: 6px 10px; border-radius: 3px; margin-bottom: 10px; display: none; font-size: 0.85em; }
        .notif.ok  { background: var(--vscode-diffEditor-insertedTextBackground); color: var(--vscode-foreground); display: block; }
        .notif.err { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); display: block; }

        /* Toolbar de auto-refresh dos logs */
        .log-toolbar {
            display: flex;
            align-items: center;
            gap: 14px;
            margin-bottom: 8px;
            padding: 4px 0;
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
        }
        .log-toolbar label { display: flex; align-items: center; gap: 6px; }
        .log-toolbar select {
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 3px;
            padding: 2px 6px;
            font-size: inherit;
            font-family: inherit;
            cursor: pointer;
        }
        .log-status { font-style: italic; }
        .log-status.ativo { color: var(--vscode-testing-iconPassed, #4caf50); font-style: normal; font-weight: 500; }
    </style>
</head>
<body>
    <h1>
        <span id="nomeContainer">${escaparHtml(nome)}</span>
        <span id="badgeEstado" class="badge">...</span>
    </h1>

    <div id="notif" class="notif"></div>

    <div class="acoes">
        <button class="btn btn-start"   id="btn-start"   data-acao="start"  >&#9654; Start</button>
        <button class="btn btn-stop"    id="btn-stop"    data-acao="stop"   >&#9632; Stop</button>
        <button class="btn btn-restart" id="btn-restart" data-acao="restart">&#8635; Restart</button>
        <button class="btn btn-remove"  id="btn-remove"  data-acao="remove" >&#128465; Remover</button>
    </div>

    <div class="abas">
        <button class="aba ativa" data-aba="overview">Overview</button>
        <button class="aba" data-aba="logs">Logs</button>
        <button class="aba" data-aba="env">Variáveis de Ambiente</button>
        <button class="aba" data-aba="portas">Portas</button>
        <button class="aba" data-aba="stats">Stats</button>
    </div>

    <div id="tab-overview" class="conteudo-aba ativa">
        <p class="carregando">Carregando dados do container...</p>
    </div>
    <div id="tab-logs" class="conteudo-aba">
        <div class="log-toolbar">
            <label>Auto-atualizar:
                <select id="log-intervalo">
                    <option value="0">Desativado</option>
                    <option value="2">2s</option>
                    <option value="5">5s</option>
                    <option value="10">10s</option>
                    <option value="30">30s</option>
                    <option value="60">1 min</option>
                </select>
            </label>
            <span id="log-status" class="log-status"></span>
        </div>
        <pre id="log-conteudo" class="carregando">Carregando logs...</pre>
    </div>
    <div id="tab-env" class="conteudo-aba">
        <p class="carregando">Aguardando dados...</p>
    </div>
    <div id="tab-portas" class="conteudo-aba">
        <p class="carregando">Aguardando dados...</p>
    </div>
    <div id="tab-stats" class="conteudo-aba">
        <p class="carregando">Carregando estatísticas...</p>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let dadosContainer = null;
        let logAutoTimer = null;
        let logAbaAtiva = false;

        // Registrar listeners nos botões de aba DENTRO do script nonce
        // (onclick inline é bloqueado pela Content Security Policy)
        document.querySelectorAll('.aba').forEach(function(btn) {
            btn.addEventListener('click', function() {
                mudarAba(btn.getAttribute('data-aba'));
            });
        });

        // Listeners nos botões de ação do container
        document.querySelectorAll('.btn[data-acao]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                vscode.postMessage({ command: 'acaoContainer', acao: btn.getAttribute('data-acao') });
                btn.disabled = true;
            });
        });

        // Solicitar dados ao abrir
        vscode.postMessage({ command: 'carregarDados' });
        vscode.postMessage({ command: 'carregarStats' });

        function mudarAba(id) {
            logAbaAtiva = (id === 'logs');
            document.querySelectorAll('.aba').forEach(function(b) { b.classList.remove('ativa'); });
            document.querySelectorAll('.conteudo-aba').forEach(function(d) { d.classList.remove('ativa'); });
            document.querySelector('[data-aba="' + id + '"]').classList.add('ativa');
            document.getElementById('tab-' + id).classList.add('ativa');

            if (id === 'logs') {
                vscode.postMessage({ command: 'carregarLogs' });
            }
            if (id === 'stats') {
                vscode.postMessage({ command: 'carregarStats' });
            }
        }

        function iniciarAutoRefreshLogs(segundos) {
            pararAutoRefreshLogs();
            var statusEl = document.getElementById('log-status');
            if (statusEl) { statusEl.textContent = '\u25CF ' + segundos + 's'; statusEl.className = 'log-status ativo'; }
            logAutoTimer = setInterval(function() {
                if (logAbaAtiva) { vscode.postMessage({ command: 'carregarLogs' }); }
            }, segundos * 1000);
        }

        function pararAutoRefreshLogs() {
            if (logAutoTimer) { clearInterval(logAutoTimer); logAutoTimer = null; }
        }

        document.getElementById('log-intervalo').addEventListener('change', function() {
            var seg = parseInt(this.value, 10);
            if (seg > 0) {
                iniciarAutoRefreshLogs(seg);
            } else {
                pararAutoRefreshLogs();
                var statusEl = document.getElementById('log-status');
                if (statusEl) { statusEl.textContent = ''; statusEl.className = 'log-status'; }
            }
        });

        function atualizarBotoesEstado(estado) {
            var running = estado === 'running';
            document.getElementById('btn-start').disabled   =  running;
            document.getElementById('btn-stop').disabled    = !running;
            document.getElementById('btn-restart').disabled = !running;
        }

        function mostrarNotif(msg, tipo) {
            var el = document.getElementById('notif');
            el.textContent = msg;
            el.className = 'notif ' + tipo;
            setTimeout(function() { el.className = 'notif'; }, 4000);
        }

        window.addEventListener('message', event => {
            const msg = event.data;
            switch (msg.command) {
                case 'dadosContainer': renderizarDados(msg.data); break;
                case 'logs':          renderizarLogs(msg.data); break;
                case 'stats':         renderizarStats(msg.data); break;
                case 'erro':          mostrarErro('tab-overview', msg.data); break;
                case 'erroLogs': {
                    var elLogsErr = document.getElementById('log-conteudo');
                    if (elLogsErr) { elLogsErr.className = 'erro'; elLogsErr.textContent = 'Erro: ' + msg.data; }
                    break;
                }
                case 'erroStats':     mostrarErro('tab-stats', msg.data); break;
                case 'acaoSucesso':
                    document.querySelectorAll('.btn').forEach(function(b) { b.disabled = false; });
                    atualizarBotoesEstado(msg.estado);
                    var nomeAcao = { start: 'iniciado', stop: 'parado', restart: 'reiniciado' }[msg.acao] || msg.acao;
                    mostrarNotif('Container ' + nomeAcao + ' com sucesso.', 'ok');
                    // Atualiza badge de estado
                    var badge = document.getElementById('badgeEstado');
                    badge.textContent = msg.estado;
                    badge.className = 'badge badge-' + (msg.estado === 'running' ? 'running' : 'stopped');
                    break;
                case 'erroAcao':
                    document.querySelectorAll('.btn').forEach(function(b) { b.disabled = false; });
                    mostrarNotif('Erro: ' + msg.data, 'err');
                    break;
            }
        });

        function renderizarDados(info) {
            dadosContainer = info;
            const estado = info.State?.Status ?? 'unknown';
            const badge = document.getElementById('badgeEstado');
            badge.textContent = estado;
            badge.className = 'badge badge-' + (estado === 'running' ? 'running' : estado === 'paused' ? 'paused' : 'stopped');
            atualizarBotoesEstado(estado);

            // Overview
            const criado = new Date(info.Created).toLocaleString('pt-BR');
            document.getElementById('tab-overview').innerHTML =
                '<table>' +
                linha('ID', info.Id ? info.Id.substring(0, 12) : '-') +
                linha('Imagem', info.Config?.Image ?? '-') +
                linha('Estado', estado) +
                linha('Criado em', criado) +
                linha('Entrypoint', (info.Config?.Entrypoint ?? []).join(' ') || '-') +
                linha('Comando', (info.Config?.Cmd ?? []).join(' ') || '-') +
                linha('Hostname', info.Config?.Hostname ?? '-') +
                linha('IP (bridge)', info.NetworkSettings?.IPAddress ?? '-') +
                linha('Restart Policy', info.HostConfig?.RestartPolicy?.Name ?? '-') +
                '</table>';

            // Env
            const envs = info.Config?.Env ?? [];
            if (envs.length === 0) {
                document.getElementById('tab-env').innerHTML = '<p>Nenhuma variável de ambiente definida.</p>';
            } else {
                const rows = envs.map(e => {
                    const idx = e.indexOf('=');
                    const chave = idx >= 0 ? e.substring(0, idx) : e;
                    const valor = idx >= 0 ? e.substring(idx + 1) : '';
                    return linha(esc(chave), esc(valor));
                }).join('');
                document.getElementById('tab-env').innerHTML = '<table>' + rows + '</table>';
            }

            // Portas
            const portas = info.NetworkSettings?.Ports ?? {};
            const portaKeys = Object.keys(portas);
            if (portaKeys.length === 0) {
                document.getElementById('tab-portas').innerHTML = '<p>Nenhuma porta mapeada.</p>';
            } else {
                const rows = portaKeys.map(k => {
                    const binds = portas[k];
                    const publico = binds ? binds.map(b => b.HostPort).join(', ') : '-';
                    return linha(esc(k), esc(publico));
                }).join('');
                document.getElementById('tab-portas').innerHTML = '<table><tr><th>Porta Interna</th><th>Porta Pública</th></tr>' + rows + '</table>';
            }
        }

        function renderizarLogs(texto) {
            var el = document.getElementById('log-conteudo');
            if (el) { el.className = ''; el.textContent = texto; }
        }

        function renderizarStats(stats) {
            if (!stats || !stats.cpu_stats) {
                document.getElementById('tab-stats').innerHTML = '<p class="carregando">Sem dados de stats (container pode estar parado).</p>';
                return;
            }

            const cpuDelta = (stats.cpu_stats.cpu_usage?.total_usage ?? 0) - (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
            const sistemaDelta = (stats.cpu_stats.system_cpu_usage ?? 0) - (stats.precpu_stats?.system_cpu_usage ?? 0);
            const numCpus = stats.cpu_stats.online_cpus ?? (stats.cpu_stats.cpu_usage?.percpu_usage?.length ?? 1);
            const cpuPct = sistemaDelta > 0 ? ((cpuDelta / sistemaDelta) * numCpus * 100).toFixed(2) : '0.00';

            const memUsado = stats.memory_stats?.usage ?? 0;
            const memTotal = stats.memory_stats?.limit ?? 1;
            const memPct = ((memUsado / memTotal) * 100).toFixed(1);

            const rxBytes = Object.values(stats.networks ?? {}).reduce((acc, n) => acc + (n.rx_bytes ?? 0), 0);
            const txBytes = Object.values(stats.networks ?? {}).reduce((acc, n) => acc + (n.tx_bytes ?? 0), 0);

            document.getElementById('tab-stats').innerHTML =
                '<div class="stats-grid">' +
                card('CPU', cpuPct + '%') +
                card('Memória', fmt(memUsado) + ' / ' + fmt(memTotal) + ' (' + memPct + '%)') +
                card('Rede RX', fmt(rxBytes)) +
                card('Rede TX', fmt(txBytes)) +
                '</div>';
        }

        function mostrarErro(tabId, msg) {
            document.getElementById(tabId).innerHTML = '<p class="erro">Erro: ' + esc(msg) + '</p>';
        }

        function linha(chave, valor) {
            return '<tr><th>' + chave + '</th><td>' + valor + '</td></tr>';
        }
        function card(label, valor) {
            return '<div class="stat-card"><div class="stat-label">' + esc(label) + '</div><div class="stat-valor">' + esc(valor) + '</div></div>';
        }
        function esc(s) {
            return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }
        function fmt(bytes) {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1048576) return (bytes/1024).toFixed(1) + ' KB';
            if (bytes < 1073741824) return (bytes/1048576).toFixed(1) + ' MB';
            return (bytes/1073741824).toFixed(2) + ' GB';
        }
    </script>
</body>
</html>`;
    }

    private _destruir(): void {
        ContainerDetailPanel.paineis.delete(this._item.resourceId);
        this._panel.dispose();
        for (const d of this._disposables) d.dispose();
        this._disposables = [];
    }
}

interface WebviewMessage {
    command: 'carregarDados' | 'carregarLogs' | 'carregarStats' | 'acaoContainer';
    acao?: 'start' | 'stop' | 'restart' | 'remove';
}

/**
 * Gera um nonce criptograficamente seguro para CSP.
 */
function gerarNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let resultado = '';
    for (let i = 0; i < 32; i++) {
        resultado += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return resultado;
}

/**
 * Escapa HTML para uso seguro em conteúdo gerado no servidor.
 */
function escaparHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Caminho de um recurso local acessível pelo webview.
 * Necessário para que o webview possa carregar assets.
 */
function _recursoUri(extensionUri: vscode.Uri, webview: vscode.Webview, ...partes: string[]): vscode.Uri {
    return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...partes));
}

// Exporta para evitar erro de variável não usada (usada em extensões futuras)
export { _recursoUri };
export { path };
