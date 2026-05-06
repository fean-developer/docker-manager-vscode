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
            const html = ContainerDetailPanel._ansiParaHtml(logs);
            this._panel.webview.postMessage({ command: 'logs', data: html });
        } catch (err) {
            this._panel.webview.postMessage({
                command: 'erroLogs',
                data: err instanceof Error ? err.message : String(err),
            });
        }
    }

    /**
     * Converte sequências ANSI de cor para HTML com spans coloridos.
     * Processado no lado TypeScript para evitar embutir bytes de controle no template HTML.
     */
    private static _ansiParaHtml(texto: string): string {
        const CORES: Record<string, string> = {
            '30': '#555555', '31': '#cc0000', '32': '#4e9a06', '33': '#c4a000',
            '34': '#3465a4', '35': '#75507b', '36': '#06989a', '37': '#d3d7cf',
            '90': '#888a85', '91': '#ef2929', '92': '#8ae234', '93': '#fce94f',
            '94': '#729fcf', '95': '#ad7fa8', '96': '#34e2e2', '97': '#eeeeec',
        };
        const escHtml = (s: string) =>
            s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        // Regex segura — \x1b aqui está em código TypeScript compilado, não no HTML gerado
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

        /* Gráficos de tempo real */
        .graficos-ao-vivo { margin-top: 20px; }
        .grafico-bloco { margin-bottom: 14px; }
        .grafico-titulo {
            font-size: 0.78em;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .grafico-legenda { font-weight: normal; font-size: 0.95em; }
        canvas.grafico-canvas {
            width: 100%;
            height: 110px;
            display: block;
            border-radius: 4px;
            background: var(--vscode-editorWidget-background, #1e1e1e);
            border: 1px solid var(--cor-borda);
        }

        /* Inspect (JSON Tree/Text) */
        .inspect-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 10px;
        }
        .inspect-titulo {
            font-weight: 600;
            font-size: 1em;
            color: var(--vscode-descriptionForeground);
        }
        .inspect-toolbar { display: flex; gap: 4px; }
        .btn-inspect-mode {
            padding: 3px 12px;
            border: 1px solid var(--cor-borda);
            background: var(--cor-aba-inativa);
            color: var(--cor-texto);
            border-radius: 3px;
            cursor: pointer;
            font-size: 0.82em;
            font-family: inherit;
        }
        .btn-inspect-mode.ativa {
            background: var(--cor-aba-ativa);
            border-color: var(--cor-destaque);
        }
        .inspect-view {
            background: var(--vscode-terminal-background, #1e1e1e);
            color: var(--vscode-terminal-foreground, #d4d4d4);
            padding: 12px;
            border-radius: 4px;
            overflow: auto;
            max-height: 600px;
            font-size: 0.85em;
            line-height: 1.6;
            font-family: var(--vscode-editor-font-family, monospace);
        }
        pre.inspect-view { white-space: pre; word-break: break-all; }
        .json-filhos { padding-left: 18px; border-left: 1px solid rgba(128,128,128,0.15); margin-left: 4px; }
        .json-item { margin: 1px 0; }
        .json-toggle {
            display: inline-block;
            cursor: pointer;
            width: 14px;
            color: var(--vscode-descriptionForeground);
            user-select: none;
            font-size: 0.75em;
            vertical-align: middle;
        }
        .json-toggle:hover { color: var(--cor-destaque); }
        .json-chave       { color: #9cdcfe; }
        .json-str         { color: #ce9178; }
        .json-num         { color: #b5cea8; }
        .json-bool        { color: #569cd6; }
        .json-null        { color: #569cd6; font-style: italic; }
        .json-bracket     { color: var(--vscode-terminal-foreground, #d4d4d4); }
        .json-fecha       { color: var(--vscode-terminal-foreground, #d4d4d4); }
        .json-dois-pontos { color: var(--vscode-terminal-foreground, #d4d4d4); }
        .json-virgula     { color: var(--vscode-terminal-foreground, #d4d4d4); }
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
        <button class="aba" data-aba="inspect">Inspect</button>
    </div>

    <div id="tab-overview" class="conteudo-aba ativa">
        <div id="overview-tabela"><p class="carregando">Carregando dados do container...</p></div>
        <div class="graficos-ao-vivo">
            <div class="grafico-bloco">
                <div class="grafico-titulo">
                    CPU ao vivo
                    <span class="grafico-legenda" id="label-cpu-atual" style="color:#4fc3f7">--</span>
                </div>
                <canvas id="canvas-cpu" class="grafico-canvas"></canvas>
            </div>
            <div class="grafico-bloco">
                <div class="grafico-titulo">
                    Mem&#243;ria ao vivo
                    <span class="grafico-legenda" id="label-mem-atual" style="color:#81c784">--</span>
                </div>
                <canvas id="canvas-mem" class="grafico-canvas"></canvas>
            </div>
            <div class="grafico-bloco">
                <div class="grafico-titulo">
                    Rede ao vivo
                    <span id="label-rede-atual" class="grafico-legenda">
                        <span style="color:#ffb74d">&#8595; RX: --</span>&nbsp;&nbsp;
                        <span style="color:#ef5350">&#8593; TX: --</span>
                    </span>
                </div>
                <canvas id="canvas-rede" class="grafico-canvas"></canvas>
            </div>
        </div>
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
    <div id="tab-inspect" class="conteudo-aba">
        <div class="inspect-header">
            <span class="inspect-titulo">Inspect</span>
            <div class="inspect-toolbar">
                <button class="btn-inspect-mode ativa" data-mode="tree">&#60;/&#62; Tree</button>
                <button class="btn-inspect-mode" data-mode="text">&#9776; Text</button>
            </div>
        </div>
        <p id="inspect-carregando" class="carregando">Aguardando dados do container...</p>
        <div id="inspect-tree" class="inspect-view" style="display:none;"></div>
        <pre id="inspect-text" class="inspect-view" style="display:none;"></pre>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let dadosContainer = null;
        let logAutoTimer = null;
        let logAbaAtiva = false;
        let contadorJson = 0;
        let inspecaoModo = 'tree';

        // Histórico de métricas para gráficos em tempo real (máx 60 amostras ≈ 2 min)
        const MAX_PONTOS = 60;
        const historicoCpu = [];
        const historicoMem = [];
        const historicoRx = [];
        const historicoTx = [];
        let prevRxTotal = null;
        let prevTxTotal = null;

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

        // Polling de stats a cada 2s para atualizar gráficos ao vivo
        setInterval(function() { vscode.postMessage({ command: 'carregarStats' }); }, 2000);

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
            if (id === 'inspect') {
                renderizarInspecao();
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

        // Delegação de eventos: toggle de nós JSON e botões de modo inspect
        document.addEventListener('click', function(evt) {
            var alvo = evt.target;
            // Protege contra clique em nó de texto (sem classList)
            if (!alvo || typeof alvo.classList === 'undefined') return;
            if (alvo.classList.contains('json-toggle')) {
                var jnid = alvo.getAttribute('data-jnid');
                if (jnid) {
                    var jnEl = document.getElementById(jnid);
                    if (jnEl) {
                        var visivel = jnEl.style.display !== 'none';
                        jnEl.style.display = visivel ? 'none' : '';
                        alvo.textContent = visivel ? '\u25B6' : '\u25BC';
                    }
                }
            }
            if (alvo.classList.contains('btn-inspect-mode')) {
                var modo = alvo.getAttribute('data-mode');
                if (modo) {
                    inspecaoModo = modo;
                    document.querySelectorAll('.btn-inspect-mode').forEach(function(b) { b.classList.remove('ativa'); });
                    alvo.classList.add('ativa');
                    renderizarInspecao();
                }
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
                case 'stats':
                    atualizarHistoricoStats(msg.data);
                    renderizarStats(msg.data);
                    desenharGraficos();
                    break;
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
            document.getElementById('overview-tabela').innerHTML =
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
            if (!el) return;
            el.className = '';
            // texto já chega como HTML com spans de cor processados no servidor TypeScript
            el.innerHTML = texto;
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

        function atualizarHistoricoStats(stats) {
            if (!stats || !stats.cpu_stats) return;
            var cuTotal  = stats.cpu_stats.cpu_usage ? stats.cpu_stats.cpu_usage.total_usage : 0;
            var pcuTotal = stats.precpu_stats && stats.precpu_stats.cpu_usage ? stats.precpu_stats.cpu_usage.total_usage : 0;
            var sisDelta = (stats.cpu_stats.system_cpu_usage || 0) - (stats.precpu_stats ? (stats.precpu_stats.system_cpu_usage || 0) : 0);
            var numCpus  = stats.cpu_stats.online_cpus ||
                           (stats.cpu_stats.cpu_usage && stats.cpu_stats.cpu_usage.percpu_usage ? stats.cpu_stats.cpu_usage.percpu_usage.length : 1);
            var cpuPct   = sisDelta > 0 ? Math.min(100, ((cuTotal - pcuTotal) / sisDelta) * numCpus * 100) : 0;

            var memUsado = stats.memory_stats ? (stats.memory_stats.usage || 0) : 0;
            var memTotal = stats.memory_stats ? (stats.memory_stats.limit || 1) : 1;
            var memPct   = Math.min(100, (memUsado / memTotal) * 100);

            var redes    = stats.networks ? Object.values(stats.networks) : [];
            var rxTotal  = redes.reduce(function(acc, n) { return acc + (n.rx_bytes || 0); }, 0);
            var txTotal  = redes.reduce(function(acc, n) { return acc + (n.tx_bytes || 0); }, 0);
            var rxDelta  = prevRxTotal !== null ? Math.max(0, rxTotal - prevRxTotal) / 2 : 0;
            var txDelta  = prevTxTotal !== null ? Math.max(0, txTotal - prevTxTotal) / 2 : 0;
            prevRxTotal  = rxTotal;
            prevTxTotal  = txTotal;

            historicoCpu.push(cpuPct);
            historicoMem.push(memPct);
            historicoRx.push(rxDelta);
            historicoTx.push(txDelta);
            if (historicoCpu.length > MAX_PONTOS) historicoCpu.shift();
            if (historicoMem.length > MAX_PONTOS) historicoMem.shift();
            if (historicoRx.length  > MAX_PONTOS) historicoRx.shift();
            if (historicoTx.length  > MAX_PONTOS) historicoTx.shift();

            var lCpu = document.getElementById('label-cpu-atual');
            if (lCpu) lCpu.textContent = cpuPct.toFixed(1) + '%';
            var lMem = document.getElementById('label-mem-atual');
            if (lMem) lMem.textContent = memPct.toFixed(1) + '%';
            var lRede = document.getElementById('label-rede-atual');
            if (lRede) lRede.innerHTML =
                '<span style="color:#ffb74d">&#8595; RX: ' + fmt(rxDelta) + '/s</span>' +
                '&nbsp;&nbsp;<span style="color:#ef5350">&#8593; TX: ' + fmt(txDelta) + '/s</span>';
        }

        function desenharGraficos() {
            desenharGrafico('canvas-cpu', historicoCpu, 100, '%', '#4fc3f7');
            desenharGrafico('canvas-mem', historicoMem, 100, '%', '#81c784');
            desenharGraficoRede('canvas-rede', historicoRx, historicoTx);
        }

        function hexToRgba(hex, a) {
            var r = parseInt(hex.slice(1, 3), 16);
            var g = parseInt(hex.slice(3, 5), 16);
            var b = parseInt(hex.slice(5, 7), 16);
            return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
        }

        function prepararCanvas(canvas) {
            var w = canvas.getBoundingClientRect().width | 0;
            if (w < 10) w = (canvas.width > 10 ? canvas.width : 500);
            if (canvas.width !== w) canvas.width = w;
            if (canvas.height !== 110) canvas.height = 110;
        }

        function desenharGrafico(id, dados, maxY, unidade, cor) {
            var c = document.getElementById(id);
            if (!c) return;
            prepararCanvas(c);
            var ctx = c.getContext('2d');
            var W = c.width, H = c.height;
            var pl = 42, pr = 46, pt = 8, pb = 20;
            var gW = W - pl - pr, gH = H - pt - pb;

            ctx.clearRect(0, 0, W, H);

            // Grade e rótulos eixo Y
            ctx.lineWidth = 0.5;
            ctx.font = '9px monospace';
            for (var i = 0; i <= 4; i++) {
                var gy = pt + gH * i / 4;
                ctx.strokeStyle = 'rgba(128,128,128,0.18)';
                ctx.beginPath(); ctx.moveTo(pl, gy); ctx.lineTo(pl + gW, gy); ctx.stroke();
                ctx.fillStyle = 'rgba(180,180,180,0.7)';
                ctx.textAlign = 'right';
                ctx.fillText(Math.round(maxY * (1 - i / 4)) + unidade, pl - 4, gy + 3);
            }

            if (dados.length < 2) return;

            // Preenchimento gradiente
            var grad = ctx.createLinearGradient(0, pt, 0, pt + gH);
            grad.addColorStop(0, hexToRgba(cor, 0.35));
            grad.addColorStop(1, hexToRgba(cor, 0.02));
            ctx.beginPath();
            for (var k = 0; k < dados.length; k++) {
                var xf = pl + (k / (MAX_PONTOS - 1)) * gW;
                var yf = pt + gH * (1 - Math.min(1, dados[k] / maxY));
                if (k === 0) ctx.moveTo(xf, yf); else ctx.lineTo(xf, yf);
            }
            ctx.lineTo(pl + ((dados.length - 1) / (MAX_PONTOS - 1)) * gW, pt + gH);
            ctx.lineTo(pl, pt + gH);
            ctx.closePath();
            ctx.fillStyle = grad;
            ctx.fill();

            // Linha principal
            ctx.beginPath();
            for (var j = 0; j < dados.length; j++) {
                var xp = pl + (j / (MAX_PONTOS - 1)) * gW;
                var yp = pt + gH * (1 - Math.min(1, dados[j] / maxY));
                if (j === 0) ctx.moveTo(xp, yp); else ctx.lineTo(xp, yp);
            }
            ctx.strokeStyle = cor;
            ctx.lineWidth = 1.5;
            ctx.lineJoin = 'round';
            ctx.stroke();

            // Ponto atual
            var ux = pl + ((dados.length - 1) / (MAX_PONTOS - 1)) * gW;
            var uy = pt + gH * (1 - Math.min(1, dados[dados.length - 1] / maxY));
            ctx.beginPath(); ctx.arc(ux, uy, 3, 0, Math.PI * 2);
            ctx.fillStyle = cor; ctx.fill();

            // Valor atual à direita
            ctx.font = 'bold 10px monospace';
            ctx.fillStyle = cor;
            ctx.textAlign = 'left';
            ctx.fillText(dados[dados.length - 1].toFixed(1) + unidade, pl + gW + 5, pt + 12);
        }

        function desenharGraficoRede(id, dadosRx, dadosTx) {
            var c = document.getElementById(id);
            if (!c) return;
            prepararCanvas(c);
            var ctx = c.getContext('2d');
            var W = c.width, H = c.height;
            var pl = 54, pr = 46, pt = 8, pb = 20;
            var gW = W - pl - pr, gH = H - pt - pb;

            ctx.clearRect(0, 0, W, H);

            var todosVals = dadosRx.concat(dadosTx);
            var maxV = todosVals.length > 0 ? Math.max.apply(null, todosVals) : 0;
            if (maxV < 1024) maxV = 1024;

            var unid, esc2;
            if      (maxV >= 1073741824) { unid = 'GB/s'; esc2 = 1073741824; }
            else if (maxV >= 1048576)    { unid = 'MB/s'; esc2 = 1048576; }
            else if (maxV >= 1024)       { unid = 'KB/s'; esc2 = 1024; }
            else                         { unid = 'B/s';  esc2 = 1; }

            // Grade e rótulos
            ctx.lineWidth = 0.5;
            ctx.font = '9px monospace';
            for (var i = 0; i <= 4; i++) {
                var gy = pt + gH * i / 4;
                ctx.strokeStyle = 'rgba(128,128,128,0.18)';
                ctx.beginPath(); ctx.moveTo(pl, gy); ctx.lineTo(pl + gW, gy); ctx.stroke();
                ctx.fillStyle = 'rgba(180,180,180,0.7)';
                ctx.textAlign = 'right';
                ctx.fillText((maxV / esc2 * (1 - i / 4)).toFixed(1) + ' ' + unid, pl - 4, gy + 3);
            }

            function linhaRede(dados, cor) {
                if (dados.length < 2) return;
                var grad2 = ctx.createLinearGradient(0, pt, 0, pt + gH);
                grad2.addColorStop(0, hexToRgba(cor, 0.25));
                grad2.addColorStop(1, hexToRgba(cor, 0.02));
                ctx.beginPath();
                for (var k = 0; k < dados.length; k++) {
                    var xf = pl + (k / (MAX_PONTOS - 1)) * gW;
                    var yf = pt + gH * (1 - Math.min(1, dados[k] / maxV));
                    if (k === 0) ctx.moveTo(xf, yf); else ctx.lineTo(xf, yf);
                }
                ctx.lineTo(pl + ((dados.length - 1) / (MAX_PONTOS - 1)) * gW, pt + gH);
                ctx.lineTo(pl, pt + gH);
                ctx.closePath();
                ctx.fillStyle = grad2;
                ctx.fill();
                ctx.beginPath();
                for (var j = 0; j < dados.length; j++) {
                    var xp = pl + (j / (MAX_PONTOS - 1)) * gW;
                    var yp = pt + gH * (1 - Math.min(1, dados[j] / maxV));
                    if (j === 0) ctx.moveTo(xp, yp); else ctx.lineTo(xp, yp);
                }
                ctx.strokeStyle = cor;
                ctx.lineWidth = 1.5;
                ctx.lineJoin = 'round';
                ctx.stroke();
                if (dados.length > 0) {
                    var ux = pl + ((dados.length - 1) / (MAX_PONTOS - 1)) * gW;
                    var uy = pt + gH * (1 - Math.min(1, dados[dados.length - 1] / maxV));
                    ctx.beginPath(); ctx.arc(ux, uy, 3, 0, Math.PI * 2);
                    ctx.fillStyle = cor; ctx.fill();
                }
            }

            linhaRede(dadosRx, '#ffb74d');
            linhaRede(dadosTx, '#ef5350');

            // Valores atuais
            ctx.font = 'bold 10px monospace';
            ctx.textAlign = 'left';
            if (dadosRx.length > 0) {
                ctx.fillStyle = '#ffb74d';
                ctx.fillText('\u2193' + (dadosRx[dadosRx.length - 1] / esc2).toFixed(1) + unid, pl + gW + 5, pt + 12);
            }
            if (dadosTx.length > 0) {
                ctx.fillStyle = '#ef5350';
                ctx.fillText('\u2191' + (dadosTx[dadosTx.length - 1] / esc2).toFixed(1) + unid, pl + gW + 5, pt + 26);
            }
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

        // Renderiza a aba Inspect no modo árvore (tree) ou texto bruto (text)
        function renderizarInspecao() {
            var carregando = document.getElementById('inspect-carregando');
            var treeEl = document.getElementById('inspect-tree');
            var textEl = document.getElementById('inspect-text');
            if (!dadosContainer) {
                if (carregando) carregando.style.display = 'block';
                if (treeEl) treeEl.style.display = 'none';
                if (textEl) textEl.style.display = 'none';
                return;
            }
            if (carregando) carregando.style.display = 'none';
            try {
                if (inspecaoModo === 'tree') {
                    contadorJson = 0;
                    if (treeEl) { treeEl.style.display = 'block'; treeEl.innerHTML = criarArvoreJson(dadosContainer, 0); }
                    if (textEl) textEl.style.display = 'none';
                } else {
                    if (treeEl) treeEl.style.display = 'none';
                    if (textEl) { textEl.style.display = 'block'; textEl.textContent = JSON.stringify(dadosContainer, null, 2); }
                }
            } catch (e) {
                // Fallback seguro: exibe JSON puro se a árvore falhar
                if (treeEl) treeEl.style.display = 'none';
                if (textEl) { textEl.style.display = 'block'; textEl.textContent = JSON.stringify(dadosContainer, null, 2); }
            }
        }

        // Gera HTML recursivo de árvore JSON colapsável
        function criarArvoreJson(valor, nivel) {
            if (valor === null) return '<span class="json-null">null</span>';
            if (valor === undefined) return '<span class="json-null">undefined</span>';
            if (typeof valor === 'boolean') return '<span class="json-bool">' + esc(String(valor)) + '</span>';
            if (typeof valor === 'number') return '<span class="json-num">' + valor + '</span>';
            if (typeof valor === 'string') {
                if (valor === '') return '<span class="json-str">\u201c\u201d</span>';
                return '<span class="json-str">\u201c' + esc(valor) + '\u201d</span>';
            }
            if (Array.isArray(valor)) {
                if (valor.length === 0) return '<span class="json-bracket">[]</span>';
                var nidArr = 'jn' + (++contadorJson);
                var hArr = '<span class="json-toggle" data-jnid="' + nidArr + '">\u25BC</span> ';
                hArr += '<span class="json-bracket">[</span>';
                hArr += '<div id="' + nidArr + '" class="json-filhos">';
                for (var ia = 0; ia < valor.length; ia++) {
                    hArr += '<div class="json-item">' + criarArvoreJson(valor[ia], nivel + 1);
                    if (ia < valor.length - 1) hArr += '<span class="json-virgula">,</span>';
                    hArr += '</div>';
                }
                hArr += '</div><span class="json-fecha">]</span>';
                return hArr;
            }
            if (typeof valor === 'object') {
                var chaves = Object.keys(valor);
                if (chaves.length === 0) return '<span class="json-bracket">{}</span>';
                var nidObj = 'jn' + (++contadorJson);
                var hObj = '<span class="json-toggle" data-jnid="' + nidObj + '">\u25BC</span> ';
                hObj += '<span class="json-bracket">{</span>';
                hObj += '<div id="' + nidObj + '" class="json-filhos">';
                for (var ib = 0; ib < chaves.length; ib++) {
                    var kk = chaves[ib];
                    hObj += '<div class="json-item">';
                    hObj += '<span class="json-chave">' + esc(kk) + '</span>';
                    hObj += '<span class="json-dois-pontos">: </span>';
                    hObj += criarArvoreJson(valor[kk], nivel + 1);
                    if (ib < chaves.length - 1) hObj += '<span class="json-virgula">,</span>';
                    hObj += '</div>';
                }
                hObj += '</div><span class="json-fecha">}</span>';
                return hObj;
            }
            return esc(String(valor));
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
