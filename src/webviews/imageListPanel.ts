import * as vscode from 'vscode';
import { ImageService } from '../services/imageService';

type AcaoBulk = 'remove';

interface MensagemWebview {
    command: 'carregar' | 'acaoBulk';
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
            'Docker Manager — Imagens',
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
        return `
            <!DOCTYPE html>
            <html lang="pt-BR">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Imagens Docker</title>
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
                    <h1>📦 Imagens Docker</h1>

                    <div class="toolbar">
                        <input type="text" id="filtro" placeholder="Filtrar por tag...">
                        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                            <input type="checkbox" id="selecionarTodos">
                            <span>Selecionar todos</span>
                        </label>
                    </div>

                    <div id="infoBar" class="info-bar" style="display: none;">
                        <span id="infoTexto"></span>
                        <button id="btnRemover" class="btn-remove" style="display: none;">
                            ✕ Remover selecionadas
                        </button>
                    </div>

                    <div id="loading" class="loading">Carregando imagens...</div>
                    <table id="tabelaImagens" style="display: none;">
                        <thead>
                            <tr>
                                <th></th>
                                <th>Tag</th>
                                <th>Status</th>
                                <th>Tamanho</th>
                                <th>Criada</th>
                            </tr>
                        </thead>
                        <tbody id="corpoTabela"></tbody>
                    </table>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    let imagensFull = [];
                    let selecionadas = new Set();

                    // Carregar imagens na inicialização
                    document.addEventListener('DOMContentLoaded', () => {
                        vscode.postMessage({ command: 'carregar' });
                    });

                    // Receber imagens do backend
                    window.addEventListener('message', (e) => {
                        const { type, dados } = e.data;
                        if (type === 'imagens-carregadas') {
                            imagensFull = dados;
                            renderizar();
                        }
                    });

                    function renderizar() {
                        const tabela = document.getElementById('tabelaImagens');
                        const loading = document.getElementById('loading');
                        const corpo = document.getElementById('corpoTabela');
                        const infoBar = document.getElementById('infoBar');
                        const selecionarTodos = document.getElementById('selecionarTodos');

                        if (imagensFull.length === 0) {
                            loading.innerHTML = '<div class="empty-state">Nenhuma imagem encontrada</div>';
                            tabela.style.display = 'none';
                            infoBar.style.display = 'none';
                            return;
                        }

                        loading.style.display = 'none';
                        tabela.style.display = 'table';

                        corpo.innerHTML = imagensFull.map(img => \`
                            <tr>
                                <td>
                                    <input type="checkbox" class="checkbox-item" data-id="\${img.id}" 
                                        onchange="atualizarSelecao()">
                                </td>
                                <td>\${escapeHtml(img.tags)}</td>
                                <td>
                                    \${img.emUso
                                        ? '<span class="badge badge-em-uso">Em uso</span>'
                                        : '<span class="badge badge-nao-usado">Não utilizada</span>'
                                    }
                                </td>
                                <td>\${img.tamanho}</td>
                                <td>\${img.criada}</td>
                            </tr>
                        \`).join('');

                        // Setup checkbox "Selecionar Todos"
                        selecionarTodos.onchange = () => {
                            const checkboxes = document.querySelectorAll('.checkbox-item');
                            if (selecionarTodos.checked) {
                                checkboxes.forEach(cb => {
                                    cb.checked = true;
                                    selecionadas.add(cb.dataset.id);
                                });
                            } else {
                                checkboxes.forEach(cb => cb.checked = false);
                                selecionadas.clear();
                            }
                            atualizarSelecao();
                        };

                        atualizarSelecao();
                    }

                    function atualizarSelecao() {
                        selecionadas.clear();
                        document.querySelectorAll('.checkbox-item:checked').forEach(cb => {
                            selecionadas.add(cb.dataset.id);
                        });

                        const infoBar = document.getElementById('infoBar');
                        const infoTexto = document.getElementById('infoTexto');
                        const btnRemover = document.getElementById('btnRemover');

                        if (selecionadas.size > 0) {
                            infoBar.style.display = 'flex';
                            infoTexto.textContent = \`\${selecionadas.size} imagem(ns) selecionada(s)\`;
                            btnRemover.style.display = 'block';
                        } else {
                            infoBar.style.display = 'none';
                        }
                    }

                    document.getElementById('btnRemover').addEventListener('click', () => {
                        vscode.postMessage({
                            command: 'acaoBulk',
                            acao: 'remove',
                            ids: Array.from(selecionadas),
                        });
                    });

                    document.getElementById('filtro').addEventListener('input', (e) => {
                        const filtro = e.target.value.toLowerCase();
                        document.querySelectorAll('tbody tr').forEach(tr => {
                            const tag = tr.querySelector('td:nth-child(2)').textContent.toLowerCase();
                            tr.style.display = tag.includes(filtro) ? '' : 'none';
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
        ImageListPanel.instancia = undefined;
        this._disposables.forEach(d => d.dispose());
    }
}
