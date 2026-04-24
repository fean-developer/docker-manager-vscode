import * as vscode from 'vscode';
import { DockerTreeProvider } from './views/dockerTreeProvider';
import { registrarComandos } from './commands/dockerCommands';
import { DockerClient } from './docker/dockerClient';

/**
 * Ponto de entrada da extensão Docker Manager.
 *
 * SEGURANÇA: O acesso ao socket Docker é equivalente a acesso root.
 * A extensão não expõe o socket, não abre servidores HTTP e não loga dados sensíveis.
 */
export function activate(context: vscode.ExtensionContext): void {
    try {
        console.log('Docker Manager: extensão ativada.');

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

        for (const { viewId, provider } of registrations) {
            try {
                const treeView = vscode.window.createTreeView(viewId, {
                    treeDataProvider: provider,
                    showCollapseAll: true,
                });
                context.subscriptions.push(treeView);
                console.log(`Docker Manager: TreeView registrada para ${viewId}`);
            } catch (err) {
                console.error(`Docker Manager: Erro ao criar TreeView para ${viewId}:`, err);
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
            console.log('Docker Manager: Comandos registrados');
        } catch (err) {
            console.error('Docker Manager: Erro ao registrar comandos:', err);
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
            console.log('Docker Manager: Polling iniciado');
        } catch (err) {
            console.error('Docker Manager: Erro ao iniciar polling:', err);
            // Não quebra a ativação se o polling falhar
        }

        // Verifica conexão com o Docker ao ativar e avisa o usuário se falhar
        try {
            DockerClient.getInstance()
                .verificarConexao()
                .then(async () => {
                    const versao = await DockerClient.getInstance().obterVersao();
                    console.log(`Docker Manager: conectado ao Docker ${versao.Version}.`);
                })
                .catch(err => {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`Docker Manager: Erro de conexão com Docker: ${msg}`);
                    vscode.window.showWarningMessage(
                        `Docker Manager: ${msg}`,
                    );
                });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`Docker Manager: Erro ao instanciar DockerClient: ${msg}`);
            // Não quebra a ativação se DockerClient falhar
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('Docker Manager: ERRO CRÍTICO NA ATIVAÇÃO:', msg);
        vscode.window.showErrorMessage(
            `Docker Manager: Erro crítico na inicialização: ${msg}`,
        );
    }
}

/**
 * Chamado quando a extensão é desativada.
 * Libera recursos e para processos em background.
 */
export function deactivate(): void {
    console.log('Docker Manager: extensão desativada.');
}
