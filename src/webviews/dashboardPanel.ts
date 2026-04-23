import * as vscode from 'vscode';
import { DockerClient } from '../docker/dockerClient';
import { ContainerService, ContainerInfo } from '../services/containerService';
import { ImageService, ImageInfo } from '../services/imageService';
import { VolumeService } from '../services/volumeService';
import { NetworkService } from '../services/networkService';

/**
 * Painel Webview do Dashboard Docker — visão geral do ambiente local.
 * Exibe informações do Engine e contadores de recursos (containers, imagens, volumes, redes).
 */
export class DashboardPanel {
    private static readonly VIEW_TYPE = 'dockerManager.dashboard';
    private static instancia: DashboardPanel | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    private readonly _containerSvc: ContainerService;
    private readonly _imageSvc: ImageService;
    private readonly _volumeSvc: VolumeService;
    private readonly _networkSvc: NetworkService;

    private constructor(panel: vscode.WebviewPanel) {
        this._panel = panel;
        this._containerSvc = new ContainerService();
        this._imageSvc = new ImageService();
        this._volumeSvc = new VolumeService();
        this._networkSvc = new NetworkService();

        this._registrarMensagens();
        this._renderizar();

        this._panel.onDidDispose(() => this._destruir(), null, this._disposables);
    }

    public static criar(extensionUri: vscode.Uri): void {
        const coluna = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

        if (DashboardPanel.instancia) {
            DashboardPanel.instancia._panel.reveal(coluna);
            DashboardPanel.instancia._enviarDados();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            DashboardPanel.VIEW_TYPE,
            'Docker — Dashboard',
            coluna,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
            },
        );

        DashboardPanel.instancia = new DashboardPanel(panel);
    }

    private _registrarMensagens(): void {
        this._panel.webview.onDidReceiveMessage(async (msg: { command: string }) => {
            if (msg.command === 'carregar') {
                await this._enviarDados();
            }
        }, null, this._disposables);
    }

    private _renderizar(): void {
        this._panel.webview.html = this._gerarHtml();
    }

    private async _enviarDados(): Promise<void> {
        try {
            const [versao, info, containers, imagens, volumes, redes] = await Promise.all([
                DockerClient.getInstance().obterVersao(),
                DockerClient.getInstance().obterInfoSistema(),
                this._containerSvc.listar(),
                this._imageSvc.listar(),
                this._volumeSvc.listar(),
                this._networkSvc.listar(),
            ]);

            const running = containers.filter((c: ContainerInfo) => c.estado === 'running').length;
            const stopped = containers.filter((c: ContainerInfo) => c.estado !== 'running').length;

            const totalBytes = imagens.reduce((acc: number, img: ImageInfo) => acc + img.tamanho, 0);

            this._panel.webview.postMessage({
                command: 'dados',
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
                    containers: {
                        total: containers.length,
                        running,
                        stopped,
                    },
                    imagens: {
                        total: imagens.length,
                        tamanhoTotal: totalBytes,
                    },
                    volumes: {
                        total: volumes.length,
                    },
                    redes: {
                        total: redes.length,
                    },
                },
            });
        } catch (err) {
            this._panel.webview.postMessage({
                command: 'erro',
                data: err instanceof Error ? err.message : String(err),
            });
        }
    }

    private _gerarHtml(): string {
        const nonce = gerarNonce();
        const csp = [
            `default-src 'none'`,
            `style-src 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
        ].join('; ');

        return /* html */ `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Docker Dashboard</title>
    <style>
        :root {
            --fundo:     var(--vscode-editor-background);
            --texto:     var(--vscode-editor-foreground);
            --borda:     var(--vscode-panel-border);
            --card-bg:   var(--vscode-editorWidget-background);
            --destaque:  var(--vscode-button-background);
            --desc:      var(--vscode-descriptionForeground);
            --ok:        #4caf50;
            --parado:    #f44336;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background: var(--fundo);
            color: var(--texto);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            padding: 20px;
        }

        /* Header */
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 24px;
        }
        .header h1 { font-size: 1.3em; display: flex; align-items: center; gap: 8px; }
        .btn-refresh {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            padding: 5px 14px;
            cursor: pointer;
            font-size: 0.85em;
            font-family: inherit;
        }
        .btn-refresh:hover { opacity: 0.85; }

        /* Node Info */
        .node-info {
            background: var(--card-bg);
            border: 1px solid var(--borda);
            border-radius: 6px;
            padding: 16px 20px;
            margin-bottom: 24px;
        }
        .node-info h2 { font-size: 0.9em; color: var(--desc); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
        .node-table { width: 100%; border-collapse: collapse; }
        .node-table td { padding: 4px 12px 4px 0; vertical-align: top; }
        .node-table td:first-child { color: var(--desc); width: 160px; font-size: 0.85em; }
        .node-table td:last-child { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; }

        /* Cards de recursos */
        .cards-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
            gap: 16px;
        }
        .card {
            background: var(--card-bg);
            border: 1px solid var(--borda);
            border-radius: 6px;
            padding: 18px 20px;
            display: flex;
            align-items: center;
            gap: 16px;
            cursor: pointer;
            transition: border-color 0.15s;
        }
        .card:hover { border-color: var(--destaque); }
        .card-icon {
            font-size: 2.2em;
            width: 52px;
            height: 52px;
            border-radius: 50%;
            background: var(--destaque);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }
        .card-body { flex: 1; }
        .card-numero { font-size: 2em; font-weight: bold; line-height: 1; }
        .card-titulo { font-size: 0.95em; color: var(--desc); margin-top: 2px; }
        .card-detalhe { font-size: 0.78em; margin-top: 6px; }
        .running-txt { color: var(--ok); }
        .stopped-txt { color: var(--parado); }

        .erro { color: var(--parado); padding: 12px; }
        .carregando { color: var(--desc); font-style: italic; padding: 20px 0; }
    </style>
</head>
<body>
    <div class="header">
        <h1>&#127959; Docker — Dashboard</h1>
        <button class="btn-refresh" id="btn-refresh">&#8635; Atualizar</button>
    </div>

    <div id="node-info-wrap" class="node-info" style="display:none">
        <h2>&#9881; Node Info</h2>
        <table class="node-table" id="node-table"></table>
    </div>

    <div id="cards-wrap" class="cards-grid" style="display:none">
        <div class="card" id="card-containers">
            <div class="card-icon">&#128230;</div>
            <div class="card-body">
                <div class="card-numero" id="cnt-total">-</div>
                <div class="card-titulo">Containers</div>
                <div class="card-detalhe" id="cnt-detalhe"></div>
            </div>
        </div>
        <div class="card" id="card-imagens">
            <div class="card-icon">&#128190;</div>
            <div class="card-body">
                <div class="card-numero" id="img-total">-</div>
                <div class="card-titulo">Imagens</div>
                <div class="card-detalhe" id="img-detalhe"></div>
            </div>
        </div>
        <div class="card" id="card-volumes">
            <div class="card-icon">&#128452;</div>
            <div class="card-body">
                <div class="card-numero" id="vol-total">-</div>
                <div class="card-titulo">Volumes</div>
            </div>
        </div>
        <div class="card" id="card-redes">
            <div class="card-icon">&#128279;</div>
            <div class="card-body">
                <div class="card-numero" id="net-total">-</div>
                <div class="card-titulo">Redes</div>
            </div>
        </div>
    </div>

    <div id="status-carregando" class="carregando">Carregando dados do Docker...</div>
    <div id="erro-msg" class="erro" style="display:none"></div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        document.getElementById('btn-refresh').addEventListener('click', function() {
            carregar();
        });

        function carregar() {
            document.getElementById('status-carregando').style.display = '';
            document.getElementById('node-info-wrap').style.display = 'none';
            document.getElementById('cards-wrap').style.display = 'none';
            document.getElementById('erro-msg').style.display = 'none';
            vscode.postMessage({ command: 'carregar' });
        }

        window.addEventListener('message', function(event) {
            var msg = event.data;
            if (msg.command === 'dados') {
                renderizar(msg.data);
            } else if (msg.command === 'erro') {
                document.getElementById('status-carregando').style.display = 'none';
                var el = document.getElementById('erro-msg');
                el.textContent = 'Erro: ' + msg.data;
                el.style.display = '';
            }
        });

        function renderizar(d) {
            document.getElementById('status-carregando').style.display = 'none';

            // Node info
            var rows =
                tr('Hostname',       esc(d.engine.hostname)) +
                tr('Docker Version', esc(d.engine.versao)) +
                tr('API Version',    esc(d.engine.api)) +
                tr('OS',             esc(d.engine.os)) +
                tr('Arquitetura',    esc(d.engine.arch)) +
                tr('CPUs',           String(d.engine.cpus)) +
                tr('Memória',        fmt(d.engine.memoria));
            document.getElementById('node-table').innerHTML = rows;
            document.getElementById('node-info-wrap').style.display = '';

            // Containers
            document.getElementById('cnt-total').textContent = String(d.containers.total);
            document.getElementById('cnt-detalhe').innerHTML =
                '<span class="running-txt">&#9679; ' + d.containers.running + ' em execução</span>' +
                ' &nbsp; <span class="stopped-txt">&#9679; ' + d.containers.stopped + ' parados</span>';

            // Imagens
            document.getElementById('img-total').textContent = String(d.imagens.total);
            document.getElementById('img-detalhe').textContent = fmt(d.imagens.tamanhoTotal);

            // Volumes
            document.getElementById('vol-total').textContent = String(d.volumes.total);

            // Redes
            document.getElementById('net-total').textContent = String(d.redes.total);

            document.getElementById('cards-wrap').style.display = '';
        }

        function tr(chave, valor) {
            return '<tr><td>' + esc(chave) + '</td><td>' + valor + '</td></tr>';
        }
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

        // Carrega ao abrir
        carregar();
    </script>
</body>
</html>`;
    }

    private _destruir(): void {
        DashboardPanel.instancia = undefined;
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
