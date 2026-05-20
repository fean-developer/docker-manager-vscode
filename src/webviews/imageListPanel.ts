import * as vscode from 'vscode';
import { ImageService } from '../services/imageService';

type AcaoBulk = 'remove';

interface MensagemWebview {
    command: 'carregar' | 'acaoBulk' | 'abrirDashboard' | 'abrirContainers' | 'abrirImagens' | 'abrirVolumes' | 'abrirRedes';
    acao?: AcaoBulk;
    ids?: string[];
}

/**
 * Painel Webview com lista completa de imagens.
 * Suporta seleção múltipla via checkboxes e remoção em lote.
 */
export class ImageListPanel {
    private static readonly VIEW_TYPE = 'dockerManager.imageList';
    private static instancia: ImageListPanel | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _svc: ImageService;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._svc = new ImageService();

        this._registrarMensagens();
        this._renderizar();
        this._panel.onDidDispose(() => this._destruir(), null, this._disposables);
    }

    public static criar(extensionUri: vscode.Uri): void {
        if (ImageListPanel.instancia) {
            ImageListPanel.instancia._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            ImageListPanel.VIEW_TYPE,
            'Container Manager — Imagens',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'resources'),
                ],
            },
        );

        ImageListPanel.instancia = new ImageListPanel(panel, extensionUri);
    }

    private _registrarMensagens(): void {
        this._panel.webview.onDidReceiveMessage(
            async (msg: MensagemWebview) => {
                switch (msg.command) {
                    case 'carregar':
                        await this._carregarImagens();
                        break;

                    case 'acaoBulk':
                        if (msg.acao === 'remove' && msg.ids && msg.ids.length > 0) {
                            await this._removerImagens(msg.ids);
                        }
                        break;

                    case 'abrirDashboard':
                        await vscode.commands.executeCommand('dockerManager.openDashboard');
                        break;
                    case 'abrirContainers':
                        await vscode.commands.executeCommand('dockerManager.openContainerList');
                        break;
                    case 'abrirImagens':
                        // já está na lista de imagens
                        break;
                    case 'abrirVolumes':
                        await vscode.commands.executeCommand('dockerManager.openVolumeList');
                        break;
                    case 'abrirRedes':
                        await vscode.commands.executeCommand('dockerManager.openNetworkList');
                        break;
                }
            },
            null,
            this._disposables,
        );
    }

    private async _carregarImagens(): Promise<void> {
        try {
            const imagens = await this._svc.listar();

            const dados = imagens.map(img => ({
                id: img.id,
                tags: img.tags.length > 0 ? img.tags[0] : img.idCurto,
                tamanho: img.tamanhoFormatado,
                criada: new Date(img.criada).toLocaleDateString('pt-BR'),
                emUso: img.emUso,
            }));

            this._panel.webview.postMessage({
                type: 'imagens-carregadas',
                dados,
            });
        } catch (err) {
            vscode.window.showErrorMessage(
                `Erro ao carregar imagens: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    private async _removerImagens(ids: string[]): Promise<void> {
        const confirmacao = await vscode.window.showWarningMessage(
            `Remover ${ids.length} imagem(ns)?`,
            { modal: true },
            'Remover',
        );

        if (confirmacao !== 'Remover') {
            return;
        }

        try {
            let removidas = 0;
            let erros = 0;

            for (const id of ids) {
                try {
                    await this._svc.remover(id);
                    removidas++;
                } catch (err) {
                    erros++;
                    console.error(`Erro ao remover imagem ${id}:`, err);
                }
            }

            vscode.window.showInformationMessage(
                `✓ ${removidas} imagem(ns) removida(s)${erros > 0 ? ` | ${erros} erro(s)` : ''}`,
            );

            await this._carregarImagens();
        } catch (err) {
            vscode.window.showErrorMessage(
                `Erro ao remover imagens: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    private _renderizar(): void {
        this._panel.webview.html = this._obterHtml();
    }

    private _obterHtml(): string {
        const nonce = gerarNonce();
        const csp = [
            `default-src 'none'`,
            `style-src 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Imagens Docker</title>
    <style>
        :root {
            --bg-deep:   #0B1220;
            --bg-dark:   #0F172A;
            --panel:     rgba(255,255,255,0.05);
            --borda:     rgba(255,255,255,0.08);
            --cyan:      #00F7FF;
            --pink:      #FF2DAA;
            --green:     #00FF88;
            --muted:     rgba(255,255,255,0.45);
            --text:      #e2e8f0;
            --font-mono: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: var(--bg-deep); color: var(--text); font-family: 'Inter', system-ui, sans-serif; font-size: 13px; padding: 0; overflow: hidden; }
        /* Sidebar HUD */
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
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: var(--bg-dark); }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: var(--cyan); }
        h1 { font-size: 1.1em; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--cyan); text-shadow: 0 0 14px rgba(0,247,255,0.45); margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--borda); }
        .toolbar { display: flex; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; align-items: center; }
        .filtro {
            flex: 1; min-width: 200px; padding: 6px 12px;
            background: var(--panel); color: var(--text);
            border: 1px solid var(--borda); border-radius: 4px;
            font-family: var(--font-mono); font-size: 0.88em;
        }
        .filtro::placeholder { color: var(--muted); }
        .filtro:focus { outline: none; border-color: var(--cyan); box-shadow: 0 0 8px rgba(0,247,255,0.2); }
        .sel-label { display: flex; align-items: center; gap: 6px; font-size: 0.82em; color: var(--muted); cursor: pointer; font-family: var(--font-mono); }
        input[type="checkbox"] { cursor: pointer; width: 14px; height: 14px; accent-color: var(--cyan); }
        .info-bar {
            background: rgba(0,247,255,0.06); border: 1px solid rgba(0,247,255,0.2);
            padding: 8px 12px; border-radius: 6px; margin-bottom: 12px;
            display: flex; justify-content: space-between; align-items: center;
            font-family: var(--font-mono); font-size: 0.82em;
        }
        .btn-remove {
            background: rgba(255,45,170,0.15); color: var(--pink); border: 1px solid var(--pink);
            border-radius: 4px; padding: 4px 12px; cursor: pointer; font-family: var(--font-mono); font-size: 0.78em; text-transform: uppercase;
        }
        .btn-remove:hover { box-shadow: 0 0 10px rgba(255,45,170,0.3); }
        .btn-remove:disabled { opacity: 0.3; cursor: not-allowed; }
        .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; font-family: var(--font-mono); }
        .badge-em-uso { background: rgba(0,255,136,0.15); color: var(--green); border: 1px solid rgba(0,255,136,0.3); }
        .badge-nao-usado { background: rgba(245,158,11,0.15); color: #f59e0b; border: 1px solid rgba(245,158,11,0.3); }
        table { width: 100%; border-collapse: collapse; font-size: 0.83em; }
        thead th { background: var(--bg-dark); border-bottom: 1px solid var(--borda); padding: 8px 12px; text-align: left; font-weight: 600; color: var(--muted); font-family: var(--font-mono); font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.05em; }
        td { padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: middle; }
        tbody tr:hover { background: rgba(255,255,255,0.04); }
        tbody tr.selecionado { background: rgba(0,247,255,0.07); }
        .empty-state, .loading { text-align: center; padding: 40px 20px; color: var(--muted); font-family: var(--font-mono); }
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
        <div class="nav-item" data-cmd="abrirDashboard"><span class="nav-icon">&#128202;</span>Dashboard</div>
        <div class="nav-item" data-cmd="abrirContainers"><span class="nav-icon">&#128230;</span>Containers</div>
        <div class="nav-item ativo" data-cmd="abrirImagens"><span class="nav-icon">&#128190;</span>Imagens</div>
        <div class="nav-item" data-cmd="abrirRedes"><span class="nav-icon">&#128279;</span>Redes</div>
        <div class="nav-item" data-cmd="abrirVolumes"><span class="nav-icon">&#128452;</span>Volumes</div>
    </nav>
</aside>
<div class="main-content">
    <h1>&#128190; Imagens Docker</h1>
    <div class="toolbar">
        <input type="text" id="filtro" class="filtro" placeholder="Filtrar por tag...">
        <label class="sel-label"><input type="checkbox" id="selecionarTodos"> Selecionar todos</label>
    </div>
    <div id="infoBar" class="info-bar" style="display:none">
        <span id="infoTexto"></span>
        <button id="btnRemover" class="btn-remove">&#128465; Remover selecionadas</button>
    </div>
    <div id="loading" class="loading">Carregando imagens...</div>
    <table id="tabela" style="display:none">
        <thead>
            <tr>
                <th style="width:40px"></th>
                <th>Tag</th>
                <th>Status</th>
                <th>Tamanho</th>
                <th>Criada</th>
            </tr>
        </thead>
        <tbody id="corpo"></tbody>
    </table>

    <script nonce="${nonce}">
        var vscode = acquireVsCodeApi();
        var imagensFull = [];
        var selecionadas = new Set();

        document.addEventListener('DOMContentLoaded', function() {
            vscode.postMessage({ command: 'carregar' });
        });

        window.addEventListener('message', function(e) {
            var msg = e.data;
            if (msg.type === 'imagens-carregadas') {
                imagensFull = msg.dados;
                renderizar();
            }
        });

        function renderizar() {
            var tabela = document.getElementById('tabela');
            var loading = document.getElementById('loading');
            var corpo = document.getElementById('corpo');

            if (imagensFull.length === 0) {
                loading.innerHTML = '<div class="empty-state">Nenhuma imagem encontrada</div>';
                tabela.style.display = 'none';
                return;
            }
            loading.style.display = 'none';
            tabela.style.display = 'table';

            var html = '';
            imagensFull.forEach(function(img) {
                var sel = selecionadas.has(img.id);
                var badge = img.emUso
                    ? '<span class="badge badge-em-uso">Em uso</span>'
                    : '<span class="badge badge-nao-usado">Sem uso</span>';
                html += '<tr class="' + (sel ? 'selecionado' : '') + '" data-id="' + esc(img.id) + '">' +
                    '<td><input type="checkbox" class="checkbox-item" data-id="' + esc(img.id) + '"' + (sel ? ' checked' : '') + '></td>' +
                    '<td style="font-family:var(--font-mono)">' + esc(img.tags) + '</td>' +
                    '<td>' + badge + '</td>' +
                    '<td>' + esc(img.tamanho) + '</td>' +
                    '<td>' + esc(img.criada) + '</td>' +
                    '</tr>';
            });
            corpo.innerHTML = html;

            corpo.querySelectorAll('.checkbox-item').forEach(function(cb) {
                cb.addEventListener('change', function() {
                    if (cb.checked) { selecionadas.add(cb.getAttribute('data-id')); }
                    else { selecionadas.delete(cb.getAttribute('data-id')); }
                    var tr = cb.closest('tr');
                    if (tr) { tr.className = cb.checked ? 'selecionado' : ''; }
                    atualizarSelecao();
                });
            });

            atualizarSelecao();
        }

        document.getElementById('selecionarTodos').addEventListener('change', function() {
            var checks = document.querySelectorAll('.checkbox-item');
            if (this.checked) {
                checks.forEach(function(cb) { cb.checked = true; selecionadas.add(cb.getAttribute('data-id')); });
            } else {
                checks.forEach(function(cb) { cb.checked = false; });
                selecionadas.clear();
            }
            document.querySelectorAll('tbody tr').forEach(function(tr) { tr.className = selecionadas.has(tr.getAttribute('data-id')) ? 'selecionado' : ''; });
            atualizarSelecao();
        });

        function atualizarSelecao() {
            var infoBar = document.getElementById('infoBar');
            var infoTexto = document.getElementById('infoTexto');
            if (selecionadas.size > 0) {
                infoBar.style.display = 'flex';
                infoTexto.textContent = selecionadas.size + ' imagem(ns) selecionada(s)';
            } else {
                infoBar.style.display = 'none';
            }
        }

        document.getElementById('btnRemover').addEventListener('click', function() {
            vscode.postMessage({ command: 'acaoBulk', acao: 'remove', ids: Array.from(selecionadas) });
        });

        document.getElementById('filtro').addEventListener('input', function() {
            var q = this.value.toLowerCase();
            document.querySelectorAll('tbody tr').forEach(function(tr) {
                var tag = tr.querySelector('td:nth-child(2)').textContent.toLowerCase();
                tr.style.display = tag.includes(q) ? '' : 'none';
            });
        });

        function esc(s) {
            return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }
        // Sidebar navigation
        document.querySelectorAll('.nav-item[data-cmd]').forEach(function(el) {
            el.addEventListener('click', function() {
                vscode.postMessage({ command: el.getAttribute('data-cmd') });
            });
        });
    </script>
</div></div>
</body>
</html>`;
    }

    private _destruir(): void {
        ImageListPanel.instancia = undefined;
        this._disposables.forEach(d => d.dispose());
    }
}

function gerarNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let r = '';
    for (let i = 0; i < 32; i++) r += chars.charAt(Math.floor(Math.random() * chars.length));
    return r;
}
