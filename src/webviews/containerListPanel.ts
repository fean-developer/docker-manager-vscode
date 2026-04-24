import * as vscode from 'vscode';
import { ContainerService } from '../services/containerService';

type AcaoBulk = 'start' | 'stop' | 'restart' | 'kill' | 'remove';
type AcaoRapida = 'inspect' | 'logs' | 'shell';

interface MensagemWebview {
    command: 'carregar' | 'acaoBulk' | 'acaoRapida';
    acao?: AcaoBulk;
    ids?: string[];
    id?: string;
    acaoRapida?: AcaoRapida;
}

/**
 * Painel Webview com lista completa de containers.
 * Suporta seleção múltipla via checkboxes e ações em lote (Start, Stop, Restart, Kill, Remove).
 */
export class ContainerListPanel {
    private static readonly VIEW_TYPE = 'dockerManager.containerList';
    private static instancia: ContainerListPanel | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _svc: ContainerService;
    private readonly _extensionUri: vscode.Uri;
    private readonly _onAbrirDetalhe: (id: string) => void;
    private readonly _onAbrirLogs: (id: string) => void;
    private readonly _onAbrirShell: (id: string) => void;
    private _disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        onAbrirDetalhe: (id: string) => void,
        onAbrirLogs: (id: string) => void,
        onAbrirShell: (id: string) => void,
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._svc = new ContainerService();
        this._onAbrirDetalhe = onAbrirDetalhe;
        this._onAbrirLogs = onAbrirLogs;
        this._onAbrirShell = onAbrirShell;

        this._registrarMensagens();
        this._renderizar();
        this._panel.onDidDispose(() => this._destruir(), null, this._disposables);
    }

    public static criar(
        extensionUri: vscode.Uri,
        onAbrirDetalhe: (id: string) => void,
        onAbrirLogs: (id: string) => void,
        onAbrirShell: (id: string) => void,
    ): void {
        const coluna = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

        if (ContainerListPanel.instancia) {
            ContainerListPanel.instancia._panel.reveal(coluna);
            ContainerListPanel.instancia._enviarLista();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            ContainerListPanel.VIEW_TYPE,
            'Docker — Containers',
            coluna,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
            },
        );

        ContainerListPanel.instancia = new ContainerListPanel(
            panel, extensionUri, onAbrirDetalhe, onAbrirLogs, onAbrirShell,
        );
    }

    private _registrarMensagens(): void {
        this._panel.webview.onDidReceiveMessage(async (msg: MensagemWebview) => {
            switch (msg.command) {
                case 'carregar':
                    await this._enviarLista();
                    break;
                case 'acaoBulk':
                    if (msg.acao && msg.ids && msg.ids.length > 0) {
                        await this._executarAcaoBulk(msg.acao, msg.ids);
                    }
                    break;
                case 'acaoRapida':
                    if (msg.id && msg.acaoRapida) {
                        this._executarAcaoRapida(msg.acaoRapida, msg.id);
                    }
                    break;
                default:
                    break;
            }
        }, null, this._disposables);
    }

    private async _enviarLista(): Promise<void> {
        try {
            const containers = await this._svc.listar();
            this._panel.webview.postMessage({ command: 'lista', data: containers });
        } catch (err) {
            this._panel.webview.postMessage({
                command: 'erro',
                data: err instanceof Error ? err.message : String(err),
            });
        }
    }

    private async _executarAcaoBulk(acao: AcaoBulk, ids: string[]): Promise<void> {
        if (acao === 'remove') {
            const confirm = await vscode.window.showWarningMessage(
                `Remover ${ids.length} container(s)? Esta ação não pode ser desfeita.`,
                { modal: true },
                'Remover',
            );
            if (confirm !== 'Remover') {
                this._panel.webview.postMessage({ command: 'acaoCancelada' });
                return;
            }
        }

        if (acao === 'kill') {
            const confirm = await vscode.window.showWarningMessage(
                `Matar ${ids.length} container(s) com SIGKILL?`,
                { modal: true },
                'Matar',
            );
            if (confirm !== 'Matar') {
                this._panel.webview.postMessage({ command: 'acaoCancelada' });
                return;
            }
        }

        const erros: string[] = [];

        await Promise.allSettled(ids.map(async id => {
            try {
                switch (acao) {
                    case 'start':   await this._svc.iniciar(id); break;
                    case 'stop':    await this._svc.parar(id); break;
                    case 'restart': await this._svc.reiniciar(id); break;
                    case 'kill':    await this._svc.matar(id); break;
                    case 'remove':  await this._svc.remover(id, true); break;
                }
            } catch (err) {
                erros.push(err instanceof Error ? err.message : String(err));
            }
        }));

        if (erros.length > 0) {
            vscode.window.showErrorMessage(`${erros.length} erro(s): ${erros.join('; ')}`);
        }

        // Recarrega a lista após a ação
        await this._enviarLista();
    }

    private _executarAcaoRapida(acao: AcaoRapida, id: string): void {
        switch (acao) {
            case 'inspect': this._onAbrirDetalhe(id); break;
            case 'logs':    this._onAbrirLogs(id); break;
            case 'shell':   this._onAbrirShell(id); break;
        }
    }

    private _renderizar(): void {
        const nonce = gerarNonce();
        const csp = [
            `default-src 'none'`,
            `style-src 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
        ].join('; ');

        this._panel.webview.html = this._gerarHtml(nonce, csp);
    }

    private _gerarHtml(nonce: string, csp: string): string {
        return /* html */ `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Docker — Containers</title>
    <style>
        :root {
            --fundo:    var(--vscode-editor-background);
            --texto:    var(--vscode-editor-foreground);
            --borda:    var(--vscode-panel-border);
            --card-bg:  var(--vscode-editorWidget-background);
            --desc:     var(--vscode-descriptionForeground);
            --destaque: var(--vscode-button-background);
            --hover:    var(--vscode-list-hoverBackground);
            --sel:      var(--vscode-list-activeSelectionBackground);
            --ok:       #4caf50;
            --parado:   #f44336;
            --paused:   #ff9800;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background: var(--fundo);
            color: var(--texto);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            padding: 16px;
        }

        /* Header */
        .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
        .header h1 { font-size: 1.2em; }

        /* Toolbar de ações */
        .toolbar {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-wrap: wrap;
            margin-bottom: 12px;
            padding: 8px 10px;
            background: var(--card-bg);
            border: 1px solid var(--borda);
            border-radius: 4px;
        }
        .btn {
            padding: 4px 12px;
            border: 1px solid transparent;
            border-radius: 3px;
            cursor: pointer;
            font-size: 0.82em;
            font-family: inherit;
            font-weight: 500;
            transition: opacity 0.15s;
        }
        .btn:hover { opacity: 0.85; }
        .btn:disabled { opacity: 0.35; cursor: not-allowed; }
        .btn-start   { background: var(--ok); color: #000; }
        .btn-stop    { background: #d32f2f; color: #fff; }
        .btn-kill    { background: #7b1fa2; color: #fff; }
        .btn-restart { background: var(--destaque); color: var(--vscode-button-foreground); }
        .btn-pause   { background: var(--paused); color: #000; }
        .btn-resume  { background: #1976d2; color: #fff; }
        .btn-remove  { background: transparent; color: var(--parado); border-color: var(--parado); }
        .btn-refresh { background: transparent; color: var(--desc); border-color: var(--borda); margin-left: auto; }
        .sel-count   { font-size: 0.82em; color: var(--desc); padding: 0 6px; }

        /* Busca */
        .busca-wrap { margin-bottom: 12px; }
        .busca {
            width: 100%;
            max-width: 400px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, var(--borda));
            border-radius: 3px;
            padding: 5px 10px;
            font-size: 0.9em;
            font-family: inherit;
        }
        .busca::placeholder { color: var(--desc); }

        /* Tabela */
        .tabela-wrap { overflow-x: auto; }
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.85em;
        }
        thead th {
            background: var(--card-bg);
            border-bottom: 2px solid var(--borda);
            padding: 8px 10px;
            text-align: left;
            font-weight: 600;
            color: var(--desc);
            white-space: nowrap;
            user-select: none;
            cursor: pointer;
        }
        thead th:hover { color: var(--texto); }
        thead th.no-sort { cursor: default; }
        tbody tr {
            border-bottom: 1px solid var(--borda);
            transition: background 0.1s;
        }
        tbody tr:hover { background: var(--hover); }
        tbody tr.selecionado { background: var(--sel); }
        td { padding: 7px 10px; vertical-align: middle; }

        /* Checkbox */
        input[type=checkbox] { cursor: pointer; width: 14px; height: 14px; }

        /* Badge de estado */
        .badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 3px;
            font-size: 0.78em;
            font-weight: bold;
            text-transform: lowercase;
            letter-spacing: 0.03em;
        }
        .badge-running  { background: var(--ok);     color: #000; }
        .badge-exited   { background: var(--parado); color: #fff; }
        .badge-paused   { background: var(--paused); color: #000; }
        .badge-created  { background: #607d8b;       color: #fff; }
        .badge-dead     { background: #424242;       color: #fff; }
        .badge-restarting { background: #1976d2;     color: #fff; }

        /* Portas */
        .portas { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.82em; }
        .porta-link { color: var(--vscode-textLink-foreground); text-decoration: none; }
        .porta-link:hover { text-decoration: underline; }

        /* Quick actions */
        .quick-actions { display: flex; gap: 4px; }
        .qa-btn {
            background: transparent;
            border: none;
            color: var(--desc);
            cursor: pointer;
            padding: 2px 5px;
            border-radius: 3px;
            font-size: 1em;
            line-height: 1;
        }
        .qa-btn:hover { background: var(--hover); color: var(--texto); }

        .nome-link { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
        .nome-link:hover { text-decoration: underline; }

        .carregando { color: var(--desc); font-style: italic; padding: 20px 0; }
        .erro-msg { color: var(--parado); padding: 12px; }
        .vazia { color: var(--desc); padding: 20px; text-align: center; }

        .sort-arrow { font-size: 0.7em; margin-left: 4px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>&#128230; Containers</h1>
    </div>

    <div class="toolbar" id="toolbar">
        <button class="btn btn-start"   data-acao="start"   disabled>&#9654; Start</button>
        <button class="btn btn-stop"    data-acao="stop"    disabled>&#9632; Stop</button>
        <button class="btn btn-kill"    data-acao="kill"    disabled>&#9760; Kill</button>
        <button class="btn btn-restart" data-acao="restart" disabled>&#8635; Restart</button>
        <button class="btn btn-pause"   data-acao="pause"   disabled>&#9646;&#9646; Pause</button>
        <button class="btn btn-resume"  data-acao="resume"  disabled>&#9654;&#9654; Resume</button>
        <button class="btn btn-remove"  data-acao="remove"  disabled>&#128465; Remove</button>
        <span class="sel-count" id="sel-count"></span>
        <button class="btn btn-refresh" id="btn-refresh">&#8635; Atualizar</button>
    </div>

    <div class="busca-wrap">
        <input class="busca" type="text" id="busca" placeholder="Buscar por nome, imagem ou estado..." />
    </div>

    <div id="status-carregando" class="carregando">Carregando containers...</div>
    <div id="erro-msg" class="erro-msg" style="display:none"></div>

    <div class="tabela-wrap" id="tabela-wrap" style="display:none">
        <table id="tabela">
            <thead>
                <tr>
                    <th class="no-sort" style="width:36px"><input type="checkbox" id="check-all" title="Selecionar todos" /></th>
                    <th data-col="nome">Nome <span class="sort-arrow"></span></th>
                    <th data-col="estado" style="width:110px">Estado <span class="sort-arrow"></span></th>
                    <th data-col="imagem">Imagem <span class="sort-arrow"></span></th>
                    <th data-col="criado">Criado em <span class="sort-arrow"></span></th>
                    <th data-col="ip" style="width:120px">IP <span class="sort-arrow"></span></th>
                    <th>Portas</th>
                    <th class="no-sort" style="width:80px">Ações</th>
                </tr>
            </thead>
            <tbody id="tbody"></tbody>
        </table>
        <p class="vazia" id="vazia" style="display:none">Nenhum container encontrado.</p>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        var todosContainers = [];
        var filtrado        = [];
        var selecionados    = new Set();
        var sortCol         = 'estado';
        var sortAsc         = true;

        // ── Bootstrap ───────────────────────────────────────────────────────
        document.getElementById('btn-refresh').addEventListener('click', carregar);
        document.getElementById('busca').addEventListener('input', function() { aplicarFiltro(); });
        document.getElementById('check-all').addEventListener('change', function() {
            if (this.checked) {
                filtrado.forEach(function(c) { selecionados.add(c.id); });
            } else {
                selecionados.clear();
            }
            renderizarTabela();
            atualizarToolbar();
        });

        // Botões de ação bulk
        document.querySelectorAll('.btn[data-acao]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var acao = btn.getAttribute('data-acao');
                if (selecionados.size === 0) return;
                desabilitarToolbar(true);
                vscode.postMessage({ command: 'acaoBulk', acao: acao, ids: Array.from(selecionados) });
            });
        });

        // Ordenação por coluna
        document.querySelectorAll('thead th[data-col]').forEach(function(th) {
            th.addEventListener('click', function() {
                var col = th.getAttribute('data-col');
                if (sortCol === col) { sortAsc = !sortAsc; } else { sortCol = col; sortAsc = true; }
                aplicarFiltro();
            });
        });

        // ── Mensagens do backend ────────────────────────────────────────────
        window.addEventListener('message', function(event) {
            var msg = event.data;
            switch (msg.command) {
                case 'lista':
                    todosContainers = msg.data;
                    selecionados.clear();
                    aplicarFiltro();
                    document.getElementById('status-carregando').style.display = 'none';
                    document.getElementById('tabela-wrap').style.display = '';
                    desabilitarToolbar(false);
                    break;
                case 'erro':
                    document.getElementById('status-carregando').style.display = 'none';
                    var el = document.getElementById('erro-msg');
                    el.textContent = 'Erro: ' + msg.data;
                    el.style.display = '';
                    desabilitarToolbar(false);
                    break;
                case 'acaoCancelada':
                    desabilitarToolbar(false);
                    break;
            }
        });

        // ── Filtro + ordenação ───────────────────────────────────────────────
        function aplicarFiltro() {
            var q = document.getElementById('busca').value.toLowerCase();
            filtrado = todosContainers.filter(function(c) {
                return !q ||
                    c.nome.toLowerCase().includes(q) ||
                    c.imagem.toLowerCase().includes(q) ||
                    c.estado.toLowerCase().includes(q) ||
                    c.status.toLowerCase().includes(q);
            });

            filtrado.sort(function(a, b) {
                var va = String(a[sortCol] ?? '');
                var vb = String(b[sortCol] ?? '');
                return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
            });

            // Remove selecionados que não aparecem mais no filtro
            var filtradoIds = new Set(filtrado.map(function(c) { return c.id; }));
            selecionados.forEach(function(id) { if (!filtradoIds.has(id)) selecionados.delete(id); });

            renderizarTabela();
            atualizarToolbar();
        }

        // ── Renderização da tabela ───────────────────────────────────────────
        function renderizarTabela() {
            var tbody = document.getElementById('tbody');

            // Atualiza setas de ordenação
            document.querySelectorAll('thead th[data-col]').forEach(function(th) {
                var arrow = th.querySelector('.sort-arrow');
                if (th.getAttribute('data-col') === sortCol) {
                    arrow.textContent = sortAsc ? ' ▲' : ' ▼';
                } else {
                    arrow.textContent = '';
                }
            });

            if (filtrado.length === 0) {
                tbody.innerHTML = '';
                document.getElementById('vazia').style.display = '';
                document.getElementById('check-all').checked = false;
                document.getElementById('check-all').indeterminate = false;
                return;
            }
            document.getElementById('vazia').style.display = 'none';

            var html = '';
            filtrado.forEach(function(c) {
                var sel = selecionados.has(c.id);
                var badgeClass = 'badge-' + (c.estado === 'exited' ? 'exited' :
                    c.estado === 'running' ? 'running' :
                    c.estado === 'paused'  ? 'paused'  :
                    c.estado === 'created' ? 'created' :
                    c.estado === 'dead'    ? 'dead'    : 'restarting');

                var portas = (c.portas || [])
                    .filter(function(p) { return p.portaPublica; })
                    .map(function(p) {
                        return '<a class="porta-link" href="http://localhost:' + p.portaPublica + '" title="Abrir no navegador">'
                            + p.portaPublica + ':' + p.portaPrivada + '/' + p.protocolo + '</a>';
                    }).join(' ');

                var criado = c.criado ? new Date(c.criado).toLocaleString('pt-BR') : '-';

                html += '<tr class="' + (sel ? 'selecionado' : '') + '" data-id="' + esc(c.id) + '">' +
                    '<td><input type="checkbox" class="chk-row" data-id="' + esc(c.id) + '" ' + (sel ? 'checked' : '') + ' /></td>' +
                    '<td><span class="nome-link" data-id="' + esc(c.id) + '" data-acao-rapida="inspect">' + esc(c.nome) + '</span></td>' +
                    '<td><span class="badge ' + badgeClass + '">' + esc(c.estado) + '</span></td>' +
                    '<td style="font-family:monospace;font-size:0.82em">' + esc(c.imagem) + '</td>' +
                    '<td style="white-space:nowrap">' + criado + '</td>' +
                    '<td style="font-family:monospace;font-size:0.82em">' + esc(c.ip || '-') + '</td>' +
                    '<td class="portas">' + (portas || '-') + '</td>' +
                    '<td><div class="quick-actions">' +
                        '<button class="qa-btn" data-id="' + esc(c.id) + '" data-acao-rapida="logs"    title="Ver Logs">&#128196;</button>' +
                        '<button class="qa-btn" data-id="' + esc(c.id) + '" data-acao-rapida="inspect" title="Inspecionar">&#128269;</button>' +
                        (c.estado === 'running' ? '<button class="qa-btn" data-id="' + esc(c.id) + '" data-acao-rapida="shell" title="Terminal">&#9166;</button>' : '') +
                    '</div></td>' +
                '</tr>';
            });

            tbody.innerHTML = html;

            // Delegação de eventos nos checkboxes
            tbody.querySelectorAll('.chk-row').forEach(function(chk) {
                chk.addEventListener('change', function() {
                    var id = chk.getAttribute('data-id');
                    if (chk.checked) { selecionados.add(id); } else { selecionados.delete(id); }
                    // Atualiza classe da linha
                    var tr = chk.closest('tr');
                    if (tr) { tr.className = chk.checked ? 'selecionado' : ''; }
                    atualizarToolbar();
                });
            });

            // Clique no nome abre detalhe
            tbody.querySelectorAll('[data-acao-rapida]').forEach(function(el) {
                el.addEventListener('click', function(e) {
                    e.stopPropagation();
                    vscode.postMessage({
                        command: 'acaoRapida',
                        id: el.getAttribute('data-id'),
                        acaoRapida: el.getAttribute('data-acao-rapida'),
                    });
                });
            });

            // Atualiza estado do check-all
            var numSel = selecionados.size;
            var checkAll = document.getElementById('check-all');
            checkAll.checked = numSel > 0 && numSel === filtrado.length;
            checkAll.indeterminate = numSel > 0 && numSel < filtrado.length;
        }

        // ── Toolbar ──────────────────────────────────────────────────────────
        function atualizarToolbar() {
            var n = selecionados.size;
            var selLabel = document.getElementById('sel-count');
            selLabel.textContent = n > 0 ? n + ' selecionado(s)' : '';

            var temSel = n > 0;
            document.querySelectorAll('.btn[data-acao]').forEach(function(btn) {
                btn.disabled = !temSel;
            });
        }

        function desabilitarToolbar(disabled) {
            document.querySelectorAll('.btn[data-acao], #btn-refresh').forEach(function(btn) {
                btn.disabled = disabled || (btn.hasAttribute('data-acao') && selecionados.size === 0);
            });
        }

        // ── Utilitários ───────────────────────────────────────────────────────
        function esc(s) {
            return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        function carregar() {
            document.getElementById('status-carregando').style.display = '';
            document.getElementById('tabela-wrap').style.display = 'none';
            document.getElementById('erro-msg').style.display = 'none';
            vscode.postMessage({ command: 'carregar' });
        }

        // Carrega ao abrir
        carregar();
    </script>
</body>
</html>`;
    }

    private _destruir(): void {
        ContainerListPanel.instancia = undefined;
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
