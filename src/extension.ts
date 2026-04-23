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
        const treeView = vscode.window.createTreeView(viewId, {
            treeDataProvider: treeProvider,
            showCollapseAll: true,
        });
        context.subscriptions.push(treeView);
    }

    // Registra todos os comandos (com confirmações para ações destrutivas)
    registrarComandos(context, () => treeProvider.refresh());

    // Inicia polling automático a cada 10s
    treeProvider.iniciarPolling();
    context.subscriptions.push({
        dispose: () => treeProvider.pararPolling(),
    });

    // Verifica conexão com o Docker ao ativar e avisa o usuário se falhar
    DockerClient.getInstance()
        .verificarConexao()
        .then(async () => {
            const versao = await DockerClient.getInstance().obterVersao();
            console.log(`Docker Manager: conectado ao Docker ${versao.Version}.`);
        })
        .catch(err => {
            vscode.window.showWarningMessage(
                `Docker Manager: ${err instanceof Error ? err.message : String(err)}`,
            );
        });
}

/**
 * Chamado quando a extensão é desativada.
 * Libera recursos e para processos em background.
 */
export function deactivate(): void {
    console.log('Docker Manager: extensão desativada.');
}
