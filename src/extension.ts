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

        // Instancia o provider da árvore e registra nas 4 views da sidebar
        const treeProvider = new DockerTreeProvider();

        const viewIds = [
            'dockerManager.containers',
            'dockerManager.images',
            'dockerManager.volumes',
            'dockerManager.networks',
        ];

        for (const viewId of viewIds) {
            try {
                const treeView = vscode.window.createTreeView(viewId, {
                    treeDataProvider: treeProvider,
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
            registrarComandos(context, () => treeProvider.refresh());
            console.log('Docker Manager: Comandos registrados');
        } catch (err) {
            console.error('Docker Manager: Erro ao registrar comandos:', err);
            throw err;
        }

        // Inicia polling automático a cada 10s
        treeProvider.iniciarPolling();
        context.subscriptions.push({
            dispose: () => treeProvider.pararPolling(),
        });
        console.log('Docker Manager: Polling iniciado');

        // Verifica conexão com o Docker ao ativar e avisa o usuário se falhar
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
