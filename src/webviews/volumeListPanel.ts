import * as vscode from 'vscode';
import { VolumeService } from '../services/volumeService';

type AcaoBulk = 'remove';

interface MensagemWebview {
    command: 'carregar' | 'acaoBulk';
    acao?: AcaoBulk;
    ids?: string[];
}

/**
 * Painel Webview com lista completa de volumes.
 * Suporta seleção múltipla via checkboxes e remoção em lote.
 */
export class VolumeListPanel {
    private static readonly VIEW_TYPE = 'dockerManager.volumeList';
    private static instancia: VolumeListPanel | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _svc: VolumeService;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._svc = new VolumeService();

        this._registrarMensagens();
        this._renderizar();
        this._panel.onDidDispose(() => this._destruir(), null, this._disposables);
    }

    public static criar(extensionUri: vscode.Uri): void {
        if (VolumeListPanel.instancia) {
            VolumeListPanel.instancia._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            VolumeListPanel.VIEW_TYPE,
            'Container Manager — Volumes',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'resources'),
                ],
            },
        );

        VolumeListPanel.instancia = new VolumeListPanel(panel, extensionUri);
    }

    private _registrarMensagens(): void {
        this._panel.webview.onDidReceiveMessage(
            async (msg: MensagemWebview) => {
                switch (msg.command) {
                    case 'carregar':
                        await this._carregarVolumes();
                        break;

                    case 'acaoBulk':
                        if (msg.acao === 'remove' && msg.ids && msg.ids.length > 0) {
                            await this._removerVolumes(msg.ids);
                        }
                        break;
                }
            },
            null,
            this._disposables,
        );
    }

    private async _carregarVolumes(): Promise<void> {
        try {
            const volumes = await this._svc.listar();

            const dados = volumes.map(v => ({
                id: v.nome,
                nome: v.nome,
                driver: v.driver,
                mountpoint: v.mountpoint,
                emUso: v.emUso,
            }));

            this._panel.webview.postMessage({
                type: 'volumes-carregados',
                dados,
            });
        } catch (err) {
            vscode.window.showErrorMessage(
                `Erro ao carregar volumes: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    private async _removerVolumes(ids: string[]): Promise<void> {
        const confirmacao = await vscode.window.showWarningMessage(
            `Remover ${ids.length} volume(ns)? Esta ação é irreversível.`,
            { modal: true },
            'Remover',
        );

        if (confirmacao !== 'Remover') {
            return;
        }

        try {
            let removidos = 0;
            let erros = 0;

            for (const id of ids) {
                try {
                    await this._svc.remover(id);
                    removidos++;
                } catch (err) {
                    erros++;
                    console.error(`Erro ao remover volume ${id}:`, err);
                }
            }

            vscode.window.showInformationMessage(
                `✓ ${removidos} volume(ns) removido(s)${erros > 0 ? ` | ${erros} erro(s)` : ''}`,
            );

            await this._carregarVolumes();
        } catch (err) {
            vscode.window.showErrorMessage(
                `Erro ao remover volumes: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
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
                <title>Volumes Docker</title>
                <style>
                    * {
                        margin: 0;
                        padding: 0;
                        box-sizing: border-box;
                    }

                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
                        background: var(--vscode-editor-background);
                        color: var(--vscode-editor-foreground);
                        padding: 20px;
                    }

                    .container {
                        max-width: 1200px;
                        margin: 0 auto;
                    }

                    h1 {
                        font-size: 24px;
                        margin-bottom: 20px;
                        display: flex;
                        align-items: center;
                        gap: 10px;
                    }

                    .toolbar {
                        display: flex;
                        gap: 10px;
                        margin-bottom: 20px;
                        flex-wrap: wrap;
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

                    button:hover {
                        background: var(--vscode-button-hoverBackground);
                    }

                    button:disabled {
                        opacity: 0.5;
                        cursor: not-allowed;
                    }

                    .btn-remove {
                        background: var(--vscode-testing-iconErrored);
                    }

                    .btn-remove:hover {
                        background: #cc0000;
                    }

                    .info-bar {
                        background: var(--vscode-inputValidation-infoBackground);
                        border: 1px solid var(--vscode-inputValidation-infoBorder);
                        color: var(--vscode-inputValidation-infoForeground);
                        padding: 10px 12px;
                        border-radius: 4px;
                        margin-bottom: 15px;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                    }

                    .badge {
                        display: inline-block;
                        padding: 2px 8px;
                        border-radius: 12px;
                        font-size: 11px;
                        font-weight: 600;
                    }

                    .badge-em-uso {
                        background: #1a8a1a33;
                        color: #4caf50;
                        border: 1px solid #4caf50;
                    }

                    .badge-nao-usado {
                        background: #e65c0033;
                        color: #ff9800;
                        border: 1px solid #ff9800;
                    }

                    table {
                        width: 100%;
                        border-collapse: collapse;
                        background: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 4px;
                        overflow: hidden;
                    }

                    thead {
                        background: var(--vscode-tab-activeBackground);
                        font-weight: 600;
                    }

                    th, td {
                        padding: 12px;
                        text-align: left;
                        border-bottom: 1px solid var(--vscode-panel-border);
                    }

                    th:first-child, td:first-child {
                        width: 40px;
                        padding-left: 12px;
                    }

                    tbody tr:hover {
                        background: var(--vscode-list-hoverBackground);
                    }

                    input[type="checkbox"] {
                        cursor: pointer;
                        width: 18px;
                        height: 18px;
                    }

                    .empty-state {
                        text-align: center;
                        padding: 40px 20px;
                        color: var(--vscode-descriptionForeground);
                    }

                    .loading {
                        text-align: center;
                        padding: 20px;
                        color: var(--vscode-descriptionForeground);
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>💾 Volumes Docker</h1>

                    <div class="toolbar">
                        <input type="text" id="filtro" placeholder="Filtrar por nome...">
                        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                            <input type="checkbox" id="selecionarTodos">
                            <span>Selecionar todos</span>
                        </label>
                    </div>

                    <div id="infoBar" class="info-bar" style="display: none;">
                        <span id="infoTexto"></span>
                        <button id="btnRemover" class="btn-remove" style="display: none;">
                            ✕ Remover selecionados
                        </button>
                    </div>

                    <div id="loading" class="loading">Carregando volumes...</div>
                    <table id="tabelaVolumes" style="display: none;">
                        <thead>
                            <tr>
                                <th></th>
                                <th>Nome</th>
                                <th>Status</th>
                                <th>Driver</th>
                                <th>Mount Point</th>
                            </tr>
                        </thead>
                        <tbody id="corpoTabela"></tbody>
                    </table>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    let volumesFull = [];
                    let selecionados = new Set();

                    // Carregar volumes na inicialização
                    document.addEventListener('DOMContentLoaded', () => {
                        vscode.postMessage({ command: 'carregar' });
                    });

                    // Receber volumes do backend
                    window.addEventListener('message', (e) => {
                        const { type, dados } = e.data;
                        if (type === 'volumes-carregados') {
                            volumesFull = dados;
                            renderizar();
                        }
                    });

                    function renderizar() {
                        const tabela = document.getElementById('tabelaVolumes');
                        const loading = document.getElementById('loading');
                        const corpo = document.getElementById('corpoTabela');
                        const infoBar = document.getElementById('infoBar');
                        const selecionarTodos = document.getElementById('selecionarTodos');

                        if (volumesFull.length === 0) {
                            loading.innerHTML = '<div class="empty-state">Nenhum volume encontrado</div>';
                            tabela.style.display = 'none';
                            infoBar.style.display = 'none';
                            return;
                        }

                        loading.style.display = 'none';
                        tabela.style.display = 'table';

                        corpo.innerHTML = volumesFull.map(vol => \`
                            <tr>
                                <td>
                                    <input type="checkbox" class="checkbox-item" data-id="\${vol.id}" 
                                        onchange="atualizarSelecao()">
                                </td>
                                <td>\${escapeHtml(vol.nome)}</td>
                                <td>
                                    \${vol.emUso
                                        ? '<span class="badge badge-em-uso">Em uso</span>'
                                        : '<span class="badge badge-nao-usado">Não utilizado</span>'
                                    }
                                </td>
                                <td>\${vol.driver}</td>
                                <td><code>\${escapeHtml(vol.mountpoint)}</code></td>
                            </tr>
                        \`).join('');

                        // Setup checkbox "Selecionar Todos"
                        selecionarTodos.onchange = () => {
                            const checkboxes = document.querySelectorAll('.checkbox-item');
                            if (selecionarTodos.checked) {
                                checkboxes.forEach(cb => {
                                    cb.checked = true;
                                    selecionados.add(cb.dataset.id);
                                });
                            } else {
                                checkboxes.forEach(cb => cb.checked = false);
                                selecionados.clear();
                            }
                            atualizarSelecao();
                        };

                        atualizarSelecao();
                    }

                    function atualizarSelecao() {
                        selecionados.clear();
                        document.querySelectorAll('.checkbox-item:checked').forEach(cb => {
                            selecionados.add(cb.dataset.id);
                        });

                        const infoBar = document.getElementById('infoBar');
                        const infoTexto = document.getElementById('infoTexto');
                        const btnRemover = document.getElementById('btnRemover');

                        if (selecionados.size > 0) {
                            infoBar.style.display = 'flex';
                            infoTexto.textContent = \`\${selecionados.size} volume(ns) selecionado(s)\`;
                            btnRemover.style.display = 'block';
                        } else {
                            infoBar.style.display = 'none';
                        }
                    }

                    document.getElementById('btnRemover').addEventListener('click', () => {
                        vscode.postMessage({
                            command: 'acaoBulk',
                            acao: 'remove',
                            ids: Array.from(selecionados),
                        });
                    });

                    document.getElementById('filtro').addEventListener('input', (e) => {
                        const filtro = e.target.value.toLowerCase();
                        document.querySelectorAll('tbody tr').forEach(tr => {
                            const nome = tr.querySelector('td:nth-child(2)').textContent.toLowerCase();
                            tr.style.display = nome.includes(filtro) ? '' : 'none';
                        });
                    });

                    function escapeHtml(unsafe) {
                        return unsafe.replace(/[&<>"']/g, c => ({
                            '&': '&amp;',
                            '<': '&lt;',
                            '>': '&gt;',
                            '"': '&quot;',
                            "'": '&#039;',
                        }[c]));
                    }
                </script>
            </body>
            </html>
        `;
    }

    private _destruir(): void {
        VolumeListPanel.instancia = undefined;
        this._disposables.forEach(d => d.dispose());
    }
}
