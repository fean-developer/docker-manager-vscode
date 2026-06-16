import * as vscode from 'vscode';
import { DockerTreeProvider } from './views/dockerTreeProvider';
import { registrarComandos } from './commands/dockerCommands';
import { DockerClient } from './docker/dockerClient';
import { MainPanel } from './webviews/mainPanel';
import { KubernetesClient } from './kubernetes/kubernetesClient';
import { registrarComandosKubernetes } from './commands/kubernetesCommands';

/**
 * Ponto de entrada da extensão Container Manager.
 *
 * SEGURANÇA: O acesso ao socket Docker é equivalente a acesso root.
 * A extensão não expõe o socket, não abre servidores HTTP e não loga dados sensíveis.
 */
export function activate(context: vscode.ExtensionContext): void {
    try {
        console.log('Container Manager: extensão ativada.');

        // Cria uma instância de provider para cada view (cada uma com seu tipo específico)
        const containerProvider = new DockerTreeProvider('containers');
        const imageProvider = new DockerTreeProvider('images');
        const volumeProvider = new DockerTreeProvider('volumes');
        const networkProvider = new DockerTreeProvider('networks');

        // Registra cada provider em sua respectiva view
        const registrations = [
            { viewId: 'dockerManager.containers', provider: containerProvider },
            { viewId: 'dockerManager.images', provider: imageProvider },
            { viewId: 'dockerManager.volumes', provider: volumeProvider },
            { viewId: 'dockerManager.networks', provider: networkProvider },
        ];

        let dashboardAberto = false;
        for (const { viewId, provider } of registrations) {
            try {
                const treeView = vscode.window.createTreeView(viewId, {
                    treeDataProvider: provider,
                    showCollapseAll: true,
                });
                // Abre o dashboard e fecha a sidebar ao clicar na ActivityBar
                // Se o dashboard já está aberto, não faz nada (o usuário está usando a sidebar)
                treeView.onDidChangeVisibility(e => {
                    if (e.visible) {
                        // Se o dashboard foi fechado, permite reabrir
                        if (!MainPanel.estaAberto()) {
                            dashboardAberto = false;
                        }
                        if (!dashboardAberto) {
                            dashboardAberto = true;
                            vscode.commands.executeCommand('dockerManager.openDashboard').then(() => {
                                vscode.commands.executeCommand('workbench.action.closeSidebar');
                            });
                        }
                    }
                }, null, context.subscriptions);
                context.subscriptions.push(treeView);
                console.log(`Container Manager: TreeView registrada para ${viewId}`);
            } catch (err) {
                console.error(`Container Manager: Erro ao criar TreeView para ${viewId}:`, err);
                throw err;
            }
        }

        // Registra todos os comandos (com confirmações para ações destrutivas)
        try {
            // Passa uma função de refresh que atualiza todos os providers
            registrarComandos(context, () => {
                containerProvider.refresh();
                imageProvider.refresh();
                volumeProvider.refresh();
                networkProvider.refresh();
            });
            console.log('Container Manager: Comandos registrados');
        } catch (err) {
            console.error('Container Manager: Erro ao registrar comandos:', err);
            throw err;
        }

        // Inicia polling automático a cada 10s para todos os providers
        try {
            containerProvider.iniciarPolling();
            imageProvider.iniciarPolling();
            volumeProvider.iniciarPolling();
            networkProvider.iniciarPolling();

            context.subscriptions.push({
                dispose: () => {
                    containerProvider.pararPolling();
                    imageProvider.pararPolling();
                    volumeProvider.pararPolling();
                    networkProvider.pararPolling();
                },
            });
            console.log('Container Manager: Polling iniciado');
        } catch (err) {
            console.error('Container Manager: Erro ao iniciar polling:', err);
            // Não quebra a ativação se o polling falhar
        }

        // Verifica conexão com o Docker ao ativar e avisa o usuário se falhar
        try {
            DockerClient.getInstance()
                .verificarConexao()
                .then(async () => {
                    const versao = await DockerClient.getInstance().obterVersao();
                    console.log(`Container Manager: conectado ao Docker ${versao.Version}.`);
                })
                .catch(err => {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`Container Manager: Erro de conexão com Docker: ${msg}`);
                    vscode.window.showWarningMessage(
                        `Container Manager: ${msg}`,
                    );
                });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`Container Manager: Erro ao instanciar DockerClient: ${msg}`);
            // Não quebra a ativação se DockerClient falhar
        }

        // Inicializa Kubernetes — em try/catch independente para nunca bloquear Docker
        inicializarKubernetes(context);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('Container Manager: ERRO CRÍTICO NA ATIVAÇÃO:', msg);
        vscode.window.showErrorMessage(
            `Container Manager: Erro crítico na inicialização: ${msg}`,
        );
    }
}

/**
 * Inicializa o gerenciamento Kubernetes de forma isolada.
 * Qualquer falha aqui não afeta o Docker Manager.
 */
function inicializarKubernetes(context: vscode.ExtensionContext): void {
    try {
        const client = KubernetesClient.getInstance();
        if (!client.verificarKubeconfig()) {
            console.log('Container Manager: kubeconfig não encontrado — Kubernetes Manager desabilitado.');
            return;
        }

        client.carregar();
        console.log('Container Manager: kubeconfig carregado.');

        // UI gerenciada pelo painel SPA — registra apenas os comandos
        registrarComandosKubernetes(context, () => { /* sem TreeView para atualizar */ });
        console.log('Container Manager: Comandos Kubernetes registrados.');

        // Alerta se o cluster ativo não for local
        client.verificarConexao().then(() => {
            if (!client.eClusterLocal()) {
                vscode.window.showWarningMessage(
                    `Kubernetes Manager: cluster remoto detectado (${client.getServidorAtivo()}). ` +
                    'Operações destrutivas afetarão o cluster remoto.',
                );
            }
            console.log(`Container Manager: Kubernetes conectado — contexto "${client.getContextoAtivo()}".`);
        }).catch(err => {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`Container Manager: Kubernetes sem conexão — ${msg}`);
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`Container Manager: Kubernetes Manager não inicializado: ${msg}`);
        // Não propaga — Docker continua funcionando
    }
}

/**
 * Chamado quando a extensão é desativada.
 * Libera recursos e para processos em background.
 */
export function deactivate(): void {
    console.log('Container Manager: extensão desativada.');
}
