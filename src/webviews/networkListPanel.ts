import * as vscode from 'vscode';
import { NetworkService } from '../services/networkService';

interface MensagemWebview {
    command: 'carregar' | 'remover';
    ids?: string[];
}

// Redes internas do Docker que não devem ser removidas
const REDES_SISTEMA = new Set(['bridge', 'host', 'none']);

/**
 * Painel Webview com lista completa de redes Docker.
 * Suporta seleção múltipla via checkboxes e remoção em lote (exceto redes do sistema).
 */
export class NetworkListPanel {
    private static readonly VIEW_TYPE = 'dockerManager.networkList';
    private static instancia: NetworkListPanel | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _svc: NetworkService;
    private _disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel) {
        this._panel = panel;
        this._svc = new NetworkService();

        this._registrarMensagens();
        this._renderizar();
        this._panel.onDidDispose(() => this._destruir(), null, this._disposables);
    }

    public static criar(extensionUri: vscode.Uri): void {
        if (NetworkListPanel.instancia) {
            NetworkListPanel.instancia._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            NetworkListPanel.VIEW_TYPE,
            'Docker Manager — Redes',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
            },
        );

        NetworkListPanel.instancia = new NetworkListPanel(panel);
    }

    private _registrarMensagens(): void {
        this._panel.webview.onDidReceiveMessage(
            async (msg: MensagemWebview) => {
                switch (msg.command) {
                    case 'carregar':
                        await this._carregarRedes();
                        break;
                    case 'remover':
                        if (msg.ids && msg.ids.length > 0) {
                            await this._removerRedes(msg.ids);
                        }
                        break;
                }
            },
            null,
            this._disposables,
        );
    }

    private async _carregarRedes(): Promise<void> {
        try {
            const redes = await this._svc.listar();
            const dados = redes.map(r => ({
                id: r.id,
                nome: r.nome,
                driver: r.driver,
                escopo: r.escopo,
                subnet: r.ipam.subnet ?? '-',
                gateway: r.ipam.gateway ?? '-',
                ipamDriver: r.ipam.driver,
                containers: r.containersConectados,
                sistema: REDES_SISTEMA.has(r.nome),
            }));

            this._panel.webview.postMessage({ type: 'redes-carregadas', dados });
        } catch (err) {
            vscode.window.showErrorMessage(
                `Erro ao carregar redes: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    private async _removerRedes(ids: string[]): Promise<void> {
        const confirmacao = await vscode.window.showWarningMessage(
            `Remover ${ids.length} rede(s)? Containers conectados serão desconectados.`,
            { modal: true },
            'Remover',
        );

        if (confirmacao !== 'Remover') {
            return;
        }

        let removidas = 0;
        let erros = 0;

        for (const id of ids) {
            try {
                await this._svc.remover(id);
                removidas++;
            } catch (err) {
                erros++;
                console.error(`Erro ao remover rede ${id}:`, err);
            }
        }

        vscode.window.showInformationMessage(
            `✓ ${removidas} rede(s) removida(s)${erros > 0 ? ` | ${erros} erro(s)` : ''}`,
        );

        await this._carregarRedes();
    }

    private _renderizar(): void {
        this._panel.webview.html = this._obterHtml();
    }

    private _obterHtml(): string {
        return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Redes Docker</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 20px;
        }

        .container { max-width: 1200px; margin: 0 auto; }

        h1 { font-size: 24px; margin-bottom: 20px; display: flex; align-items: center; gap: 10px; }

        .toolbar {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            flex-wrap: wrap;
            align-items: center;
        }

        input[type="text"] {
            flex: 1;
            min-width: 200px;
            padding: 8px 12px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
        }

        button {
            padding: 8px 16px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            transition: background 0.2s;
        }
        button:hover { background: var(--vscode-button-hoverBackground); }
        button:disabled { opacity: 0.5; cursor: not-allowed; }

        .btn-remove { background: #c0392b; }
        .btn-remove:hover { background: #a93226; }

        .info-bar {
            background: var(--vscode-inputValidation-infoBackground);
            border: 1px solid var(--vscode-inputValidation-infoBorder);
            padding: 10px 12px;
            border-radius: 4px;
            margin-bottom: 15px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            overflow: hidden;
        }
        thead { background: var(--vscode-tab-activeBackground); font-weight: 600; }
        th, td {
            padding: 10px 12px;
            text-align: left;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 13px;
        }
        th:first-child, td:first-child { width: 40px; }
        tbody tr:hover { background: var(--vscode-list-hoverBackground); }

        input[type="checkbox"] { cursor: pointer; width: 16px; height: 16px; }

        .badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
        }
        .badge-sistema {
            background: #1565c033;
            color: #42a5f5;
            border: 1px solid #42a5f5;
        }

        code {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 11px;
            background: var(--vscode-textBlockQuote-background);
            padding: 1px 5px;
            border-radius: 3px;
        }

        .empty-state, .loading {
            text-align: center;
            padding: 40px 20px;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
<div class="container">
    <h1>🔗 Redes Docker</h1>

    <div class="toolbar">
        <input type="text" id="filtro" placeholder="Filtrar por nome...">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
            <input type="checkbox" id="selecionarTodos">
            <span>Selecionar todos</span>
        </label>
    </div>

    <div id="infoBar" class="info-bar" style="display:none;">
        <span id="infoTexto"></span>
        <button id="btnRemover" class="btn-remove">✕ Remover selecionadas</button>
    </div>

    <div id="loading" class="loading">Carregando redes...</div>

    <table id="tabela" style="display:none;">
        <thead>
            <tr>
                <th></th>
                <th>Nome</th>
                <th>Driver</th>
                <th>Escopo</th>
                <th>Subnet</th>
                <th>Gateway</th>
                <th>IPAM Driver</th>
                <th>Containers</th>
            </tr>
        </thead>
        <tbody id="corpo"></tbody>
    </table>
</div>

<script>
    const vscode = acquireVsCodeApi();
    let redesFull = [];
    let selecionadas = new Set();

    document.addEventListener('DOMContentLoaded', () => {
        vscode.postMessage({ command: 'carregar' });
    });

    window.addEventListener('message', e => {
        const { type, dados } = e.data;
        if (type === 'redes-carregadas') {
            redesFull = dados;
            renderizar();
        }
    });

    function renderizar() {
        const tabela = document.getElementById('tabela');
        const loading = document.getElementById('loading');
        const corpo = document.getElementById('corpo');

        if (redesFull.length === 0) {
            loading.innerHTML = '<div class="empty-state">Nenhuma rede encontrada</div>';
            tabela.style.display = 'none';
            return;
        }

        loading.style.display = 'none';
        tabela.style.display = 'table';

        corpo.innerHTML = redesFull.map(r => \`
            <tr>
                <td>
                    \${r.sistema
                        ? '<input type="checkbox" disabled title="Rede do sistema não pode ser removida">'
                        : \`<input type="checkbox" class="checkbox-item" data-id="\${r.id}" onchange="atualizarSelecao()">\`
                    }
                </td>
                <td>
                    \${escapeHtml(r.nome)}
                    \${r.sistema ? ' <span class="badge badge-sistema">System</span>' : ''}
                </td>
                <td>\${r.driver}</td>
                <td>\${r.escopo}</td>
                <td><code>\${r.subnet}</code></td>
                <td><code>\${r.gateway}</code></td>
                <td>\${r.ipamDriver}</td>
                <td>\${r.containers}</td>
            </tr>
        \`).join('');

        document.getElementById('selecionarTodos').onchange = e => {
            const checkboxes = document.querySelectorAll('.checkbox-item');
            if (e.target.checked) {
                checkboxes.forEach(cb => { cb.checked = true; selecionadas.add(cb.dataset.id); });
            } else {
                checkboxes.forEach(cb => { cb.checked = false; });
                selecionadas.clear();
            }
            atualizarSelecao();
        };

        atualizarSelecao();
    }

    function atualizarSelecao() {
        selecionadas.clear();
        document.querySelectorAll('.checkbox-item:checked').forEach(cb => selecionadas.add(cb.dataset.id));

        const infoBar = document.getElementById('infoBar');
        const infoTexto = document.getElementById('infoTexto');

        if (selecionadas.size > 0) {
            infoBar.style.display = 'flex';
            infoTexto.textContent = \`\${selecionadas.size} rede(s) selecionada(s)\`;
        } else {
            infoBar.style.display = 'none';
        }
    }

    document.getElementById('btnRemover').addEventListener('click', () => {
        vscode.postMessage({ command: 'remover', ids: Array.from(selecionadas) });
    });

    document.getElementById('filtro').addEventListener('input', e => {
        const filtro = e.target.value.toLowerCase();
        document.querySelectorAll('#corpo tr').forEach(tr => {
            const nome = tr.querySelector('td:nth-child(2)').textContent.toLowerCase();
            tr.style.display = nome.includes(filtro) ? '' : 'none';
        });
    });

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c =>
            ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[c])
        );
    }
</script>
</body>
</html>`;
    }

    private _destruir(): void {
        NetworkListPanel.instancia = undefined;
        this._disposables.forEach(d => d.dispose());
    }
}
