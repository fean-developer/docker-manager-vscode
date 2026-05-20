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
            } else if (msg.command === 'abrirDashboard') {
                // já está no dashboard
            } else if (msg.command === 'abrirContainers') {
                await vscode.commands.executeCommand('dockerManager.openContainerList');
            } else if (msg.command === 'abrirImagens') {
                await vscode.commands.executeCommand('dockerManager.openImageList');
            } else if (msg.command === 'abrirVolumes') {
                await vscode.commands.executeCommand('dockerManager.openVolumeList');
            } else if (msg.command === 'abrirRedes') {
                await vscode.commands.executeCommand('dockerManager.openNetworkList');
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
            --bg-deep:    #0B1220;
            --bg-dark:    #0F172A;
            --panel:      rgba(255,255,255,0.05);
            --borda:      rgba(255,255,255,0.08);
            --cyan:       #00F7FF;
            --purple:     #7C3AED;
            --pink:       #FF2DAA;
            --green:      #00FF88;
            --muted:      rgba(255,255,255,0.45);
            --text:       #e2e8f0;
            --ok:         #00FF88;
            --parado:     #FF2DAA;
            --font-mono:  'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background: var(--bg-deep);
            color: var(--text);
            font-family: 'Inter', system-ui, sans-serif;
            font-size: 13px;
            padding: 0;
            overflow: hidden;
        }
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

        /* Header HUD */
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 24px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--borda);
        }
        .header h1 {
            font-size: 1.2em;
            font-weight: 700;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: var(--cyan);
            text-shadow: 0 0 18px rgba(0,247,255,0.5);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .btn-refresh {
            background: transparent;
            color: var(--cyan);
            border: 1px solid var(--cyan);
            border-radius: 4px;
            padding: 5px 14px;
            cursor: pointer;
            font-size: 0.82em;
            font-family: var(--font-mono);
            text-transform: uppercase;
            letter-spacing: 0.05em;
            transition: background 0.15s, box-shadow 0.15s;
        }
        .btn-refresh:hover {
            background: rgba(0,247,255,0.1);
            box-shadow: 0 0 12px rgba(0,247,255,0.3);
        }

        /* Node Info */
        .node-info {
            background: var(--panel);
            border: 1px solid var(--borda);
            border-radius: 8px;
            padding: 16px 20px;
            margin-bottom: 24px;
            backdrop-filter: blur(8px);
            box-shadow: 0 0 24px rgba(0,247,255,0.06);
        }
        .node-info h2 {
            font-size: 0.75em;
            color: var(--cyan);
            text-transform: uppercase;
            letter-spacing: 0.1em;
            margin-bottom: 12px;
            font-family: var(--font-mono);
        }
        .node-table { width: 100%; border-collapse: collapse; }
        .node-table td { padding: 4px 12px 4px 0; vertical-align: top; }
        .node-table td:first-child { color: var(--muted); width: 160px; font-size: 0.82em; font-family: var(--font-mono); }
        .node-table td:last-child { font-family: var(--font-mono); font-size: 0.82em; color: var(--text); }

        /* Cards de recursos */
        .cards-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
            gap: 16px;
        }
        .card {
            background: var(--panel);
            border: 1px solid var(--borda);
            border-radius: 8px;
            padding: 18px 20px;
            display: flex;
            align-items: center;
            gap: 16px;
            cursor: pointer;
            transition: border-color 0.2s, box-shadow 0.2s, transform 0.15s;
            backdrop-filter: blur(8px);
        }
        .card:hover {
            border-color: var(--cyan);
            box-shadow: 0 0 20px rgba(0,247,255,0.18);
            transform: translateY(-2px);
        }
        .card-icon {
            font-size: 1.8em;
            width: 48px;
            height: 48px;
            border-radius: 8px;
            background: rgba(0,247,255,0.1);
            border: 1px solid rgba(0,247,255,0.2);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }
        .card-body { flex: 1; }
        .card-numero {
            font-size: 2em;
            font-weight: 700;
            line-height: 1;
            color: var(--cyan);
            font-family: var(--font-mono);
            text-shadow: 0 0 12px rgba(0,247,255,0.4);
        }
        .card-titulo { font-size: 0.82em; color: var(--muted); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.06em; }
        .card-detalhe { font-size: 0.75em; margin-top: 6px; font-family: var(--font-mono); }
        .running-txt { color: var(--ok); }
        .stopped-txt { color: var(--parado); }

        .erro { color: var(--parado); padding: 12px; font-family: var(--font-mono); }
        .carregando { color: var(--muted); font-style: italic; padding: 20px 0; font-family: var(--font-mono); }
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
        <div class="nav-item ativo" data-cmd="abrirDashboard"><span class="nav-icon">&#128202;</span>Dashboard</div>
        <div class="nav-item" data-cmd="abrirContainers"><span class="nav-icon">&#128230;</span>Containers</div>
        <div class="nav-item" data-cmd="abrirImagens"><span class="nav-icon">&#128190;</span>Imagens</div>
        <div class="nav-item" data-cmd="abrirRedes"><span class="nav-icon">&#128279;</span>Redes</div>
        <div class="nav-item" data-cmd="abrirVolumes"><span class="nav-icon">&#128452;</span>Volumes</div>
    </nav>
</aside>
<div class="main-content">
    <div class="header">
        <h1>&#127919; Docker &mdash; Dashboard</h1>
        <button class="btn-refresh" id="btn-refresh">&#8635; Atualizar</button>
    </div>

    <div id="node-info-wrap" class="node-info" style="display:none">
        <h2>&#9881; Node Info</h2>
        <table class="node-table" id="node-table"></table>
    </div>

    <div id="cards-wrap" class="cards-grid" style="display:none">
        <div class="card" id="card-containers" title="Abrir lista de containers">
            <div class="card-icon">&#128230;</div>
            <div class="card-body">
                <div class="card-numero" id="cnt-total">-</div>
                <div class="card-titulo">Containers</div>
                <div class="card-detalhe" id="cnt-detalhe"></div>
            </div>
        </div>
        <div class="card" id="card-imagens" title="Abrir lista de imagens">
            <div class="card-icon">&#128190;</div>
            <div class="card-body">
                <div class="card-numero" id="img-total">-</div>
                <div class="card-titulo">Imagens</div>
                <div class="card-detalhe" id="img-detalhe"></div>
            </div>
        </div>
        <div class="card" id="card-volumes" title="Abrir lista de volumes">
            <div class="card-icon">&#128452;</div>
            <div class="card-body">
                <div class="card-numero" id="vol-total">-</div>
                <div class="card-titulo">Volumes</div>
            </div>
        </div>
        <div class="card" id="card-redes" title="Abrir lista de redes">
            <div class="card-icon">&#128279;</div>
            <div class="card-body">
                <div class="card-numero" id="net-total">-</div>
                <div class="card-titulo">Redes</div>
            </div>
        </div>
    </div>

    <div id="status-carregando" class="carregando">Carregando dados do Docker...</div>
    <div id="erro-msg" class="erro" style="display:none"></div>
</div></div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        document.getElementById('btn-refresh').addEventListener('click', function() {
            carregar();
        });

        // Registrar navegação nos cards
        document.getElementById('card-containers').addEventListener('click', () => vscode.postMessage({ command: 'abrirContainers' }));
        document.getElementById('card-imagens').addEventListener('click', () => vscode.postMessage({ command: 'abrirImagens' }));
        document.getElementById('card-volumes').addEventListener('click', () => vscode.postMessage({ command: 'abrirVolumes' }));
        document.getElementById('card-redes').addEventListener('click', () => vscode.postMessage({ command: 'abrirRedes' }));

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

        // Sidebar navigation
        document.querySelectorAll('.nav-item[data-cmd]').forEach(function(el) {
            el.addEventListener('click', function() {
                vscode.postMessage({ command: el.getAttribute('data-cmd') });
            });
        });

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
