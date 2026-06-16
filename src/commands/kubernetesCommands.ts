import * as vscode from 'vscode';
import { KubernetesClient } from '../kubernetes/kubernetesClient';
import { KubernetesTreeItem } from '../views/kubernetesTreeItem';
import { PodService } from '../services/podService';
import { DeploymentService } from '../services/deploymentService';
import { StatefulSetService } from '../services/statefulSetService';
import { DaemonSetService } from '../services/daemonSetService';
import { PVCService } from '../services/pvcService';

/**
 * Registra todos os comandos Kubernetes da extensão.
 * Todos os comandos destrutivos exigem confirmação modal do usuário.
 */
export function registrarComandosKubernetes(
    context: vscode.ExtensionContext,
    refresh: () => void,
): void {
    const k8sClient = KubernetesClient.getInstance();
    const podSvc = new PodService();
    const deploymentSvc = new DeploymentService();
    const statefulSetSvc = new StatefulSetService();
    const daemonSetSvc = new DaemonSetService();
    const pvcSvc = new PVCService();

    // ── Seleção de Contexto ──────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('kubernetesManager.selectContext', async () => {
            try {
                k8sClient.carregar();
                const contextos = k8sClient.listarContextos();
                if (contextos.length === 0) {
                    vscode.window.showWarningMessage('Nenhum contexto Kubernetes encontrado no kubeconfig.');
                    return;
                }

                const opcoes = contextos.map(c => ({
                    label: c.ativo ? `$(check) ${c.nome}` : c.nome,
                    description: `cluster: ${c.cluster} | user: ${c.usuario}`,
                    contexto: c.nome,
                }));

                const selecionado = await vscode.window.showQuickPick(opcoes, {
                    title: 'Selecionar Contexto Kubernetes',
                    placeHolder: 'Escolha o contexto ativo',
                });

                if (!selecionado) { return; }

                k8sClient.reset();
                k8sClient.carregar();
                k8sClient.definirContexto(selecionado.contexto);

                // Alerta se cluster não for local
                if (!k8sClient.eClusterLocal()) {
                    const confirmado = await vscode.window.showWarningMessage(
                        `⚠ O contexto "${selecionado.contexto}" aponta para um cluster REMOTO (${k8sClient.getServidorAtivo()}). Tem certeza?`,
                        { modal: true },
                        'Continuar',
                    );
                    if (confirmado !== 'Continuar') {
                        return;
                    }
                }

                vscode.window.showInformationMessage(`Contexto Kubernetes alterado para "${selecionado.contexto}".`);
                refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Erro ao selecionar contexto: ${mensagemErro(err)}`);
            }
        }),
    );

    // ── Seleção de Namespace ─────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('kubernetesManager.selectNamespace', async () => {
            try {
                const { NamespaceService } = await import('../services/namespaceService');
                const nsSvc = new NamespaceService();
                const namespaces = await nsSvc.listar();
                const opcoes = namespaces.map(ns => ({
                    label: ns.nome,
                    description: ns.status,
                }));

                const selecionado = await vscode.window.showQuickPick(opcoes, {
                    title: 'Selecionar Namespace',
                    placeHolder: `Namespace atual: ${k8sClient.getNamespaceAtivo()}`,
                });

                if (!selecionado) { return; }

                k8sClient.definirNamespace(selecionado.label);
                vscode.window.showInformationMessage(`Namespace alterado para "${selecionado.label}".`);
                refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Erro ao listar namespaces: ${mensagemErro(err)}`);
            }
        }),
    );

    // ── Refresh ──────────────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('kubernetesManager.refresh', () => {
            refresh();
        }),
    );

    // ── Abrir Painel Kubernetes ──────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('kubernetesManager.openKubernetesDashboard', async () => {
            await vscode.commands.executeCommand('dockerManager.openDashboard');
        }),
    );

    // ── Pods ─────────────────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('kubernetesManager.podLogs', async (item: KubernetesTreeItem) => {
            const pod = item.podData;
            if (!pod) {
                vscode.window.showErrorMessage('Item selecionado não é um pod.');
                return;
            }
            try {
                await podSvc.abrirLogsNoTerminal(pod.namespace, pod.nome);
            } catch (err) {
                vscode.window.showErrorMessage(`Erro ao abrir logs: ${mensagemErro(err)}`);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('kubernetesManager.podExec', async (item: KubernetesTreeItem) => {
            const pod = item.podData;
            if (!pod) {
                vscode.window.showErrorMessage('Item selecionado não é um pod.');
                return;
            }
            if (pod.status !== 'Running') {
                vscode.window.showWarningMessage(`O pod "${pod.nome}" não está em execução (status: ${pod.status}).`);
                return;
            }
            try {
                // Selecionar container se houver mais de um
                let containerSelecionado: string | undefined;
                if (pod.imagens.length > 1) {
                    const selecionado = await vscode.window.showQuickPick(
                        pod.imagens.map(img => ({ label: img.split(':')[0]?.split('/').pop() ?? img, description: img })),
                        { title: 'Selecionar Container', placeHolder: 'Escolha o container para exec' },
                    );
                    containerSelecionado = selecionado?.label;
                }
                await podSvc.exec(pod.namespace, pod.nome, containerSelecionado ?? '');
            } catch (err) {
                vscode.window.showErrorMessage(`Erro ao abrir shell no pod: ${mensagemErro(err)}`);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('kubernetesManager.deletePod', async (item: KubernetesTreeItem) => {
            const pod = item.podData;
            if (!pod) {
                vscode.window.showErrorMessage('Item selecionado não é um pod.');
                return;
            }
            const confirmado = await vscode.window.showWarningMessage(
                `Deletar o pod "${pod.nome}" no namespace "${pod.namespace}"? Esta ação não pode ser desfeita.`,
                { modal: true },
                'Deletar',
            );
            if (confirmado !== 'Deletar') { return; }

            try {
                await podSvc.deletar(pod.namespace, pod.nome);
                vscode.window.showInformationMessage(`Pod "${pod.nome}" deletado.`);
                refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Erro ao deletar pod "${pod.nome}": ${mensagemErro(err)}`);
            }
        }),
    );

    // ── Deployments ──────────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('kubernetesManager.scaleDeployment', async (item: KubernetesTreeItem) => {
            const d = item.deploymentData;
            if (!d) {
                vscode.window.showErrorMessage('Item selecionado não é um deployment.');
                return;
            }
            const entrada = await vscode.window.showInputBox({
                title: `Escalar Deployment "${d.nome}"`,
                prompt: `Réplicas atuais: ${d.replicasDesejadas}. Novo número de réplicas:`,
                value: String(d.replicasDesejadas),
                validateInput: v => {
                    const n = parseInt(v, 10);
                    if (isNaN(n) || n < 0) { return 'Digite um número inteiro não-negativo.'; }
                    return null;
                },
            });
            if (!entrada) { return; }

            const replicas = parseInt(entrada, 10);
            if (replicas === 0) {
                const confirmado = await vscode.window.showWarningMessage(
                    `Escalar para 0 réplicas removerá todos os pods do deployment "${d.nome}". Confirmar?`,
                    { modal: true },
                    'Escalar para 0',
                );
                if (confirmado !== 'Escalar para 0') { return; }
            }

            try {
                await deploymentSvc.escalar(d.namespace, d.nome, replicas);
                vscode.window.showInformationMessage(`Deployment "${d.nome}" escalado para ${replicas} réplica(s).`);
                refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Erro ao escalar deployment: ${mensagemErro(err)}`);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('kubernetesManager.restartDeployment', async (item: KubernetesTreeItem) => {
            const d = item.deploymentData;
            if (!d) {
                vscode.window.showErrorMessage('Item selecionado não é um deployment.');
                return;
            }
            try {
                await deploymentSvc.reiniciarRollout(d.namespace, d.nome);
                vscode.window.showInformationMessage(`Rollout restart iniciado para o deployment "${d.nome}".`);
                refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Erro ao reiniciar deployment: ${mensagemErro(err)}`);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('kubernetesManager.deleteDeployment', async (item: KubernetesTreeItem) => {
            const d = item.deploymentData;
            if (!d) {
                vscode.window.showErrorMessage('Item selecionado não é um deployment.');
                return;
            }
            const confirmado = await vscode.window.showWarningMessage(
                `Deletar o deployment "${d.nome}" no namespace "${d.namespace}"? Todos os pods gerenciados serão removidos.`,
                { modal: true },
                'Deletar',
            );
            if (confirmado !== 'Deletar') { return; }

            try {
                await deploymentSvc.deletar(d.namespace, d.nome);
                vscode.window.showInformationMessage(`Deployment "${d.nome}" deletado.`);
                refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Erro ao deletar deployment: ${mensagemErro(err)}`);
            }
        }),
    );

    // ── StatefulSets ─────────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('kubernetesManager.scaleStatefulSet', async (item: KubernetesTreeItem) => {
            const ss = item.statefulSetData;
            if (!ss) {
                vscode.window.showErrorMessage('Item selecionado não é um StatefulSet.');
                return;
            }
            const entrada = await vscode.window.showInputBox({
                title: `Escalar StatefulSet "${ss.nome}"`,
                prompt: `Réplicas atuais: ${ss.replicasDesejadas}. Novo número de réplicas:`,
                value: String(ss.replicasDesejadas),
                validateInput: v => {
                    const n = parseInt(v, 10);
                    if (isNaN(n) || n < 0) { return 'Digite um número inteiro não-negativo.'; }
                    return null;
                },
            });
            if (!entrada) { return; }

            try {
                await statefulSetSvc.escalar(ss.namespace, ss.nome, parseInt(entrada, 10));
                vscode.window.showInformationMessage(`StatefulSet "${ss.nome}" escalado para ${entrada} réplica(s).`);
                refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Erro ao escalar StatefulSet: ${mensagemErro(err)}`);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('kubernetesManager.deleteStatefulSet', async (item: KubernetesTreeItem) => {
            const ss = item.statefulSetData;
            if (!ss) {
                vscode.window.showErrorMessage('Item selecionado não é um StatefulSet.');
                return;
            }
            const confirmado = await vscode.window.showWarningMessage(
                `Deletar o StatefulSet "${ss.nome}" no namespace "${ss.namespace}"? Esta ação não pode ser desfeita.`,
                { modal: true },
                'Deletar',
            );
            if (confirmado !== 'Deletar') { return; }

            try {
                await statefulSetSvc.deletar(ss.namespace, ss.nome);
                vscode.window.showInformationMessage(`StatefulSet "${ss.nome}" deletado.`);
                refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Erro ao deletar StatefulSet: ${mensagemErro(err)}`);
            }
        }),
    );

    // ── DaemonSets ───────────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('kubernetesManager.deleteDaemonSet', async (item: KubernetesTreeItem) => {
            const ds = item.daemonSetData;
            if (!ds) {
                vscode.window.showErrorMessage('Item selecionado não é um DaemonSet.');
                return;
            }
            const confirmado = await vscode.window.showWarningMessage(
                `Deletar o DaemonSet "${ds.nome}" no namespace "${ds.namespace}"? Esta ação não pode ser desfeita.`,
                { modal: true },
                'Deletar',
            );
            if (confirmado !== 'Deletar') { return; }

            try {
                await daemonSetSvc.deletar(ds.namespace, ds.nome);
                vscode.window.showInformationMessage(`DaemonSet "${ds.nome}" deletado.`);
                refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Erro ao deletar DaemonSet: ${mensagemErro(err)}`);
            }
        }),
    );

    // ── PVCs ─────────────────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('kubernetesManager.deletePvc', async (item: KubernetesTreeItem) => {
            const pvc = item.pvcData;
            if (!pvc) {
                vscode.window.showErrorMessage('Item selecionado não é um PVC.');
                return;
            }
            const confirmado = await vscode.window.showWarningMessage(
                `Deletar o PVC "${pvc.nome}" no namespace "${pvc.namespace}"? Os dados persistidos podem ser perdidos permanentemente.`,
                { modal: true },
                'Deletar',
            );
            if (confirmado !== 'Deletar') { return; }

            try {
                await pvcSvc.deletar(pvc.namespace, pvc.nome);
                vscode.window.showInformationMessage(`PVC "${pvc.nome}" deletado.`);
                refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Erro ao deletar PVC: ${mensagemErro(err)}`);
            }
        }),
    );
}

/**
 * Extrai mensagem de erro de qualquer tipo de exceção.
 */
function mensagemErro(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
