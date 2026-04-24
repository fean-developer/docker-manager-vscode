import * as vscode from 'vscode';
import { ContainerService } from '../services/containerService';
import { ImageService } from '../services/imageService';
import { VolumeService } from '../services/volumeService';
import { DockerTreeItem } from '../views/dockerTreeItem';
import { formatarBytes } from '../services/imageService';

/**
 * Registra todos os comandos da extensão Docker Manager.
 * Todos os comandos destrutivos exigem confirmação do usuário.
 */
export function registrarComandos(
    context: vscode.ExtensionContext,
    refresh: () => void,
): void {
    const containerSvc = new ContainerService();
    const imageSvc = new ImageService();
    const volumeSvc = new VolumeService();

    // ── Comandos de Container ────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('dockerManager.startContainer', async (item: DockerTreeItem) => {
            const nome = item.containerData?.nome ?? item.label as string;
            try {
                await containerSvc.iniciar(item.resourceId);
                vscode.window.showInformationMessage(`Container "${nome}" iniciado com sucesso.`);
                refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Falha ao iniciar "${nome}": ${mensagemErro(err)}`);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('dockerManager.stopContainer', async (item: DockerTreeItem) => {
            const nome = item.containerData?.nome ?? item.label as string;
            try {
                await containerSvc.parar(item.resourceId);
                vscode.window.showInformationMessage(`Container "${nome}" parado com sucesso.`);
                refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Falha ao parar "${nome}": ${mensagemErro(err)}`);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('dockerManager.restartContainer', async (item: DockerTreeItem) => {
            const nome = item.containerData?.nome ?? item.label as string;
            try {
                await containerSvc.reiniciar(item.resourceId);
                vscode.window.showInformationMessage(`Container "${nome}" reiniciado com sucesso.`);
                refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Falha ao reiniciar "${nome}": ${mensagemErro(err)}`);
            }
        }),
    );

    // ── Remoção de Container (destrutivo — exige confirmação) ────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('dockerManager.removeContainer', async (item: DockerTreeItem) => {
            const nome = item.containerData?.nome ?? item.label as string;
            const confirmacao = await vscode.window.showWarningMessage(
                `Remover o container "${nome}"? Esta ação não pode ser desfeita.`,
                { modal: true },
                'Remover',
            );
            if (confirmacao !== 'Remover') return;

            try {
                await containerSvc.remover(item.resourceId, true);
                vscode.window.showInformationMessage(`Container "${nome}" removido.`);
                refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Falha ao remover "${nome}": ${mensagemErro(err)}`);
            }
        }),
    );

    // ── Logs ─────────────────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('dockerManager.showContainerLogs', async (item: DockerTreeItem) => {
            const nome = item.containerData?.nome ?? item.label as string;
            try {
                const logs = await containerSvc.obterLogs(item.resourceId);
                const canal = vscode.window.createOutputChannel(`Docker: ${nome}`);
                canal.clear();
                canal.append(logs);
                canal.show();
            } catch (err) {
                vscode.window.showErrorMessage(`Falha ao obter logs de "${nome}": ${mensagemErro(err)}`);
            }
        }),
    );

    // ── Exec Shell (terminal integrado) ──────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('dockerManager.execShell', async (item: DockerTreeItem) => {
            const nome = item.containerData?.nome ?? item.label as string;
            const id = item.resourceId.substring(0, 12);

            // Detecta shell disponível no container
            const shell = await detectarShell(item.resourceId, containerSvc);

            const terminal = vscode.window.createTerminal({
                name: `Docker: ${nome}`,
                shellPath: '/bin/sh',
                shellArgs: ['-c', `docker exec -it ${id} ${shell}`],
            });
            terminal.show();
        }),
    );

    // ── Inspecionar Container (abre Webview) ─────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('dockerManager.inspectContainer', async (item: DockerTreeItem) => {
            // O webview é criado pelo ContainerDetailPanel (FASE 6)
            const { ContainerDetailPanel } = await import('../webviews/containerDetailPanel');
            ContainerDetailPanel.criar(context.extensionUri, item, containerSvc);
        }),
    );

    // ── Imagens ──────────────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('dockerManager.removeImage', async (item: DockerTreeItem) => {
            const label = item.label as string;
            const confirmacao = await vscode.window.showWarningMessage(
                `Remover a imagem "${label}"? Esta ação não pode ser desfeita.`,
                { modal: true },
                'Remover',
            );
            if (confirmacao !== 'Remover') return;

            try {
                await imageSvc.remover(item.resourceId, false);
                vscode.window.showInformationMessage(`Imagem "${label}" removida.`);
                refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Falha ao remover imagem "${label}": ${mensagemErro(err)}`);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('dockerManager.pruneImages', async () => {
            const confirmacao = await vscode.window.showWarningMessage(
                'Remover todas as imagens não utilizadas (dangling)? Esta ação não pode ser desfeita.',
                { modal: true },
                'Remover',
            );
            if (confirmacao !== 'Remover') return;

            try {
                const liberado = await imageSvc.limpar();
                vscode.window.showInformationMessage(`Imagens limpas. Espaço liberado: ${formatarBytes(liberado)}.`);
                refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Falha ao limpar imagens: ${mensagemErro(err)}`);
            }
        }),
    );

    // ── Volumes ──────────────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('dockerManager.removeVolume', async (item: DockerTreeItem) => {
            const nome = item.label as string;
            const confirmacao = await vscode.window.showWarningMessage(
                `Remover o volume "${nome}"? Os dados serão perdidos permanentemente.`,
                { modal: true },
                'Remover',
            );
            if (confirmacao !== 'Remover') return;

            try {
                await volumeSvc.remover(item.resourceId, false);
                vscode.window.showInformationMessage(`Volume "${nome}" removido.`);
                refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Falha ao remover volume "${nome}": ${mensagemErro(err)}`);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('dockerManager.pruneVolumes', async () => {
            const confirmacao = await vscode.window.showWarningMessage(
                'Remover todos os volumes não utilizados? Os dados serão perdidos permanentemente.',
                { modal: true },
                'Remover',
            );
            if (confirmacao !== 'Remover') return;

            try {
                const liberado = await volumeSvc.limpar();
                vscode.window.showInformationMessage(`Volumes limpos. Espaço liberado: ${formatarBytes(liberado)}.`);
                refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Falha ao limpar volumes: ${mensagemErro(err)}`);
            }
        }),
    );

    // ── Refresh ───────────────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('dockerManager.refresh', () => {
            refresh();
        }),
    );

    // ── Dashboard ─────────────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('dockerManager.openDashboard', async () => {
            const { DashboardPanel } = await import('../webviews/dashboardPanel');
            DashboardPanel.criar(context.extensionUri);
        }),
    );

    // ── Lista de Containers (com checkboxes) ──────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('dockerManager.openContainerList', async () => {
            const { ContainerListPanel } = await import('../webviews/containerListPanel');
            const { ContainerDetailPanel } = await import('../webviews/containerDetailPanel');

            ContainerListPanel.criar(
                context.extensionUri,
                // Callback: abrir painel de detalhe por ID
                async (id: string) => {
                    try {
                        const info = await containerSvc.inspecionar(id);
                        const nome = (info.Name ?? id).replace(/^\//, '');
                        const { DockerTreeItem } = await import('../views/dockerTreeItem');
                        const item = new DockerTreeItem({
                            label: nome,
                            nodeType: 'container-running',
                            resourceId: id,
                            containerData: {
                                nome,
                                imagem: info.Config?.Image ?? '-',
                                estado: info.State?.Status ?? 'unknown',
                                status: info.State?.Status ?? '-',
                                portas: [],
                                criado: new Date(info.Created),
                            },
                        });
                        ContainerDetailPanel.criar(context.extensionUri, item, containerSvc);
                    } catch (err) {
                        vscode.window.showErrorMessage(`Erro ao abrir detalhe: ${mensagemErro(err)}`);
                    }
                },
                // Callback: mostrar logs
                async (id: string) => {
                    try {
                        const info = await containerSvc.inspecionar(id);
                        const nome = (info.Name ?? id).replace(/^\//, '');
                        const logs = await containerSvc.obterLogs(id);
                        const canal = vscode.window.createOutputChannel(`Docker: ${nome}`);
                        canal.clear();
                        canal.append(logs);
                        canal.show();
                    } catch (err) {
                        vscode.window.showErrorMessage(`Erro ao obter logs: ${mensagemErro(err)}`);
                    }
                },
                // Callback: abrir shell
                async (id: string) => {
                    try {
                        const info = await containerSvc.inspecionar(id);
                        const nome = (info.Name ?? id).replace(/^\//, '');
                        const idCurto = id.substring(0, 12);
                        const shell = await detectarShell(id, containerSvc);
                        const terminal = vscode.window.createTerminal({
                            name: `Docker: ${nome}`,
                            shellPath: '/bin/sh',
                            shellArgs: ['-c', `docker exec -it ${idCurto} ${shell}`],
                        });
                        terminal.show();
                    } catch (err) {
                        vscode.window.showErrorMessage(`Erro ao abrir shell: ${mensagemErro(err)}`);
                    }
                },
            );
        }),
    );
}

/**
 * Tenta detectar o shell disponível no container (bash ou sh).
 */
async function detectarShell(id: string, svc: ContainerService): Promise<string> {
    try {
        const info = await svc.inspecionar(id);
        const shells = ['/bin/bash', '/bin/sh', '/bin/ash'];
        for (const s of shells) {
            if (info.Config?.Env?.some(e => e.includes('bash')) || s === '/bin/sh') {
                return s;
            }
        }
    } catch {
        // Ignora — usa fallback
    }
    return '/bin/sh';
}

function mensagemErro(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
