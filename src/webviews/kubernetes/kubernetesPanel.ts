import type { NodeInfo } from '../../services/nodeService';
import type { NamespaceInfo } from '../../services/namespaceService';
import type { PodInfo } from '../../services/podService';
import type { DeploymentInfo } from '../../services/deploymentService';
import type { StatefulSetInfo } from '../../services/statefulSetService';
import type { DaemonSetInfo } from '../../services/daemonSetService';
import type { ServiceK8sInfo } from '../../services/kubernetesServiceService';
import type { PVCInfo } from '../../services/pvcService';
import type { ConfigMapInfo } from '../../services/configMapService';
import type { SecretInfo } from '../../services/secretService';

/**
 * Geração de HTML para o painel Kubernetes no MainPanel SPA.
 * Cada função retorna um fragmento HTML para injetar via postMessage.
 * Segue o design do MainPanel (CSS vars, dark mode, tabelas, badges).
 */

// ── Utilitários de formatação ────────────────────────────────────────────────

function badgeStatus(status: string): string {
    const cor = classificarCor(status);
    return `<span class="k8s-badge" style="background:${cor.bg};color:${cor.fg}">${esc(status)}</span>`;
}

function classificarCor(status: string): { bg: string; fg: string } {
    const s = status.toLowerCase();
    if (s === 'running' || s === 'active' || s === 'bound' || s === 'ready') {
        return { bg: 'rgba(0,255,136,0.15)', fg: '#00FF88' };
    }
    if (s === 'pending' || s === 'waiting') {
        return { bg: 'rgba(245,158,11,0.15)', fg: '#f59e0b' };
    }
    if (s === 'failed' || s === 'crashloopbackoff' || s === 'error' || s === 'lost') {
        return { bg: 'rgba(255,45,170,0.15)', fg: '#FF2DAA' };
    }
    if (s === 'terminated' || s === 'notready') {
        return { bg: 'rgba(255,45,170,0.12)', fg: '#ff6b9d' };
    }
    return { bg: 'rgba(255,255,255,0.1)', fg: 'rgba(255,255,255,0.55)' };
}

function esc(s: string | undefined | null): string {
    if (!s) { return ''; }
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function bytes(n: number): string {
    if (n === 0) { return '0 B'; }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const idx = Math.floor(Math.log(n) / Math.log(1024));
    return `${(n / Math.pow(1024, idx)).toFixed(1)} ${units[idx]}`;
}

function linhaVazia(cols: number, msg: string): string {
    return `<tr><td colspan="${cols}" style="color:var(--muted);text-align:center;padding:18px">${esc(msg)}</td></tr>`;
}

// ── Estilos compartilhados K8s (injetados uma vez junto com o HTML) ───────────

export const CSS_K8S = /* css */`
.k8s-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 0.78em;
    font-family: var(--font-mono, monospace);
    font-weight: 600;
    letter-spacing: 0.02em;
}
.k8s-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.82em;
    table-layout: fixed;
}
.k8s-table th {
    background: rgba(255,255,255,0.04);
    color: var(--muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    font-size: 0.75em;
    padding: 7px 10px;
    text-align: left;
    border-bottom: 1px solid rgba(255,255,255,0.07);
}
.k8s-table td {
    padding: 7px 10px;
    border-bottom: 1px solid rgba(255,255,255,0.04);
    vertical-align: middle;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.k8s-table tr:hover td { background: rgba(255,255,255,0.03); }
.k8s-card { background: var(--panel, rgba(255,255,255,0.05)); border: 1px solid var(--borda, rgba(255,255,255,0.08)); border-radius: 10px; padding: 16px; }
.k8s-card-titulo { font-size: 0.68em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin-bottom: 8px; }
.k8s-card-valor { font-size: 1.8em; font-weight: 700; color: var(--cyan, #00F7FF); font-family: var(--font-mono, monospace); }
.k8s-grid-overview { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; margin-bottom: 20px; }
.k8s-section-titulo { font-size: 0.72em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin: 20px 0 10px; }
.k8s-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.k8s-input-ns { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); color: var(--text, #e2e8f0); border-radius: 5px; padding: 4px 10px; font-size: 0.82em; font-family: var(--font-mono, monospace); }
.k8s-btn { background: rgba(0,247,255,0.1); border: 1px solid rgba(0,247,255,0.25); color: var(--cyan, #00F7FF); border-radius: 5px; padding: 4px 12px; font-size: 0.78em; cursor: pointer; font-family: var(--font-mono, monospace); transition: background 0.15s; }
.k8s-btn:hover { background: rgba(0,247,255,0.2); }
.k8s-btn-danger { background: rgba(255,45,170,0.1); border-color: rgba(255,45,170,0.3); color: var(--pink, #FF2DAA); }
.k8s-btn-danger:hover { background: rgba(255,45,170,0.2); }

/* ── Volumes (estilo Storage Manager) ── */
.k8s-vol-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.k8s-vol-ns-label { font-size: 0.82em; color: var(--muted, #64748b); }
.k8s-vol-ns-label strong { color: #A78BFA; font-family: var(--font-mono, monospace); }
.k8s-vol-count { font-size: 0.75em; color: var(--muted, #64748b); background: rgba(255,255,255,0.07); padding: 2px 10px; border-radius: 10px; margin-left: auto; }
.k8s-vol-table-wrap { border: 1px solid var(--borda, rgba(255,255,255,0.08)); border-radius: 8px; overflow: hidden; }
.k8s-vol-table { width: 100%; border-collapse: collapse; font-size: 0.82em; }
.k8s-vol-table thead th { background: rgba(255,255,255,0.04); color: var(--muted, #64748b); font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; font-size: 0.72em; padding: 8px 10px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.08); }
.k8s-vol-row { cursor: pointer; transition: background 0.15s; }
.k8s-vol-row:hover td { background: rgba(255,255,255,0.04); }
.k8s-vol-row td { padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: middle; }
.k8s-vol-row.aberto td { border-bottom: none; background: rgba(124,58,237,0.05); }
.k8s-vol-chevron-cell { width: 28px; text-align: center; }
.k8s-vol-chevron { display: inline-block; color: var(--muted, #64748b); font-size: 0.7em; transition: transform 0.2s; }
.k8s-vol-row.aberto .k8s-vol-chevron { transform: rotate(90deg); color: #A78BFA; }
.k8s-vol-name { font-family: var(--font-mono, monospace); font-weight: 600; color: var(--text, #e2e8f0); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.k8s-vol-status-badge { display: inline-block; padding: 2px 10px; border-radius: 4px; font-size: 0.82em; font-weight: 700; font-family: var(--font-mono, monospace); }
.k8s-vol-cap { display: flex; align-items: center; gap: 8px; }
.k8s-vol-cap-valor { font-family: var(--font-mono, monospace); font-weight: 600; color: var(--cyan, #00F7FF); font-size: 0.9em; }
.k8s-vol-detail { background: rgba(124,58,237,0.04); }
.k8s-vol-detail td { padding: 12px 10px 16px 10px; border-bottom: 1px solid rgba(255,255,255,0.06); }
.k8s-vol-detail-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; padding: 4px 0; }
.k8s-vol-detail-label { font-size: 0.68em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted, #64748b); margin-bottom: 4px; }
.k8s-vol-detail-val { font-size: 0.85em; color: var(--text, #e2e8f0); }
.k8s-vol-vazio { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 60px 20px; color: var(--muted, #64748b); font-size: 0.88em; text-align: center; }

/* ── Dashboard Kubernetes (estilo Docker Manager) ── */
.k8s-dash-info { background: var(--panel, rgba(255,255,255,0.04)); border: 1px solid var(--borda, rgba(255,255,255,0.08)); border-radius: 8px; padding: 16px 20px; margin-bottom: 24px; backdrop-filter: blur(8px); }
.k8s-dash-info h2 { font-size: 0.75em; color: #A78BFA; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 12px; font-family: var(--font-mono, monospace); display: flex; align-items: center; gap: 6px; }
.k8s-dash-info-table { width: 100%; border-collapse: collapse; }
.k8s-dash-info-table td { padding: 4px 12px 4px 0; vertical-align: top; }
.k8s-dash-info-table td:first-child { color: var(--muted, #64748b); width: 160px; font-size: 0.82em; font-family: var(--font-mono, monospace); }
.k8s-dash-info-table td:last-child { font-family: var(--font-mono, monospace); font-size: 0.82em; color: var(--text, #e2e8f0); }
.k8s-dash-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 16px; margin-bottom: 28px; }
.k8s-dash-card { background: var(--panel, rgba(255,255,255,0.04)); border: 1px solid var(--borda, rgba(255,255,255,0.08)); border-radius: 8px; padding: 18px 20px; display: flex; align-items: center; gap: 16px; cursor: pointer; transition: border-color 0.2s, box-shadow 0.2s, transform 0.15s; backdrop-filter: blur(8px); }
.k8s-dash-card:hover { border-color: #7C3AED; box-shadow: 0 0 16px rgba(124,58,237,0.18); transform: translateY(-2px); }
.k8s-dash-card-icon { font-size: 1.6em; opacity: 0.85; }
.k8s-dash-card-numero { font-size: 1.9em; font-weight: 700; color: #A78BFA; font-family: var(--font-mono, monospace); line-height: 1; }
.k8s-dash-card-titulo { font-size: 0.72em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted, #64748b); margin-top: 2px; }
.k8s-dash-card-detalhe { font-size: 0.72em; color: var(--muted, #64748b); margin-top: 4px; }
.k8s-dash-card-detalhe .ok { color: #00FF88; }
.k8s-dash-card-detalhe .warn { color: #f59e0b; }
.k8s-dash-card-detalhe .err { color: #FF2DAA; }
.k8s-dash-card.warn { border-color: rgba(245,158,11,0.4); }
.k8s-dash-card.warn .k8s-dash-card-numero { color: #f59e0b; }
.k8s-dash-card.err { border-color: rgba(255,45,170,0.4); }
.k8s-dash-card.err .k8s-dash-card-numero { color: #FF2DAA; }
`;

// ── Gerador de HTML — Visão Geral do Cluster ─────────────────────────────────

export interface ContadoresK8s {
    pods: number;
    podsRunning: number;
    deployments: number;
    deploymentsOk: number;
    statefulsets: number;
    daemonsets: number;
    services: number;
    pvcs: number;
    configmaps: number;
    secrets: number;
}

export function gerarHtmlClusterOverview(
    contexto: string,
    servidor: string,
    namespace: string,
    nodes: NodeInfo[],
    namespaces: NamespaceInfo[],
    contadores: ContadoresK8s,
): string {
    const nodesReady = nodes.filter(n => n.status.toLowerCase() === 'ready').length;
    const podsOther = contadores.pods - contadores.podsRunning;
    const deplNotOk = contadores.deployments - contadores.deploymentsOk;

    const nodesCardClass = nodesReady < nodes.length ? 'warn' : '';
    const nodesDetalhe = nodesReady < nodes.length
        ? `<span class="warn">&#9679; ${nodes.length - nodesReady} n&atilde;o-pronto(s)</span>`
        : `<span class="ok">&#9679; todos prontos</span>`;
    const podsCardClass = podsOther > 0 ? 'warn' : '';
    const podsDetalhe = contadores.pods > 0
        ? `<span class="ok">&#9679; ${contadores.podsRunning} running</span>` +
          (podsOther > 0 ? ` <span class="warn">&#9679; ${podsOther} outros</span>` : '')
        : '';
    const deplCardClass = deplNotOk > 0 ? 'warn' : '';
    const deplDetalhe = contadores.deployments > 0
        ? `<span class="ok">&#9679; ${contadores.deploymentsOk} prontos</span>` +
          (deplNotOk > 0 ? ` <span class="warn">&#9679; ${deplNotOk} pendentes</span>` : '')
        : '';

    const nodeRows = nodes.length === 0
        ? linhaVazia(6, 'Nenhum nó encontrado.')
        : nodes.map(n => `
<tr>
  <td title="${esc(n.nome)}">${esc(n.nome)}</td>
  <td>${badgeStatus(n.status)}</td>
  <td>${esc(n.roles.join(', '))}</td>
  <td>${esc(n.versao)}</td>
  <td>${esc(n.cpu.capacidade)}</td>
  <td>${esc(n.memoria.capacidade)}</td>
</tr>`).join('');

    const nsRows = namespaces.length === 0
        ? linhaVazia(2, 'Nenhum namespace encontrado.')
        : namespaces.map(ns => `
<tr>
  <td title="${esc(ns.nome)}">${esc(ns.nome)}</td>
  <td>${badgeStatus(ns.status)}</td>
</tr>`).join('');

    return /* html */`
<!-- ── Cluster Info (estilo Node Info do Docker Manager) ── -->
<div class="k8s-dash-info">
  <h2>&#9096; Cluster Info</h2>
  <table class="k8s-dash-info-table">
    <tr><td>Contexto</td><td>${esc(contexto)}</td></tr>
    <tr><td>Servidor</td><td>${esc(servidor)}</td></tr>
    <tr><td>Namespace</td><td>${esc(namespace)}</td></tr>
    <tr><td>N&#243;s</td><td>${nodes.length} (${nodesReady} prontos)</td></tr>
    <tr><td>Namespaces</td><td>${namespaces.length}</td></tr>
  </table>
</div>

<!-- ── Cards de resumo (estilo Docker Manager) ── -->
<div class="k8s-dash-cards">
  <div class="k8s-dash-card ${podsCardClass}" data-k8s-goto="workloads">
    <div class="k8s-dash-card-icon">&#9096;</div>
    <div>
      <div class="k8s-dash-card-numero">${contadores.pods}</div>
      <div class="k8s-dash-card-titulo">Pods</div>
      <div class="k8s-dash-card-detalhe">${podsDetalhe}</div>
    </div>
  </div>
  <div class="k8s-dash-card ${deplCardClass}" data-k8s-goto="workloads">
    <div class="k8s-dash-card-icon">&#128196;</div>
    <div>
      <div class="k8s-dash-card-numero">${contadores.deployments}</div>
      <div class="k8s-dash-card-titulo">Deployments</div>
      <div class="k8s-dash-card-detalhe">${deplDetalhe}</div>
    </div>
  </div>
  <div class="k8s-dash-card ${nodesCardClass}" data-k8s-goto="cluster">
    <div class="k8s-dash-card-icon">&#127760;</div>
    <div>
      <div class="k8s-dash-card-numero">${nodes.length}</div>
      <div class="k8s-dash-card-titulo">Nodes</div>
      <div class="k8s-dash-card-detalhe">${nodesDetalhe}</div>
    </div>
  </div>
  <div class="k8s-dash-card" data-k8s-goto="cluster">
    <div class="k8s-dash-card-icon">&#128452;</div>
    <div>
      <div class="k8s-dash-card-numero">${namespaces.length}</div>
      <div class="k8s-dash-card-titulo">Namespaces</div>
    </div>
  </div>
  <div class="k8s-dash-card" data-k8s-goto="networking">
    <div class="k8s-dash-card-icon">&#128279;</div>
    <div>
      <div class="k8s-dash-card-numero">${contadores.services}</div>
      <div class="k8s-dash-card-titulo">Services</div>
    </div>
  </div>
  <div class="k8s-dash-card" data-k8s-goto="storage">
    <div class="k8s-dash-card-icon">&#128190;</div>
    <div>
      <div class="k8s-dash-card-numero">${contadores.pvcs}</div>
      <div class="k8s-dash-card-titulo">PVCs</div>
    </div>
  </div>
  <div class="k8s-dash-card" data-k8s-goto="config">
    <div class="k8s-dash-card-icon">&#128214;</div>
    <div>
      <div class="k8s-dash-card-numero">${contadores.configmaps}</div>
      <div class="k8s-dash-card-titulo">ConfigMaps</div>
    </div>
  </div>
  <div class="k8s-dash-card" data-k8s-goto="config">
    <div class="k8s-dash-card-icon">&#128274;</div>
    <div>
      <div class="k8s-dash-card-numero">${contadores.secrets}</div>
      <div class="k8s-dash-card-titulo">Secrets</div>
    </div>
  </div>
</div>

<!-- ── Tabela de Nós ── -->
<div class="k8s-section-titulo">N&#243;s (${nodes.length})</div>
<div class="k8s-card" style="margin-bottom:16px;overflow-x:auto">
  <table class="k8s-table">
    <colgroup>
      <col style="width:30%"><col style="width:12%"><col style="width:18%">
      <col style="width:18%"><col style="width:10%"><col style="width:12%">
    </colgroup>
    <thead><tr>
      <th>Nome</th><th>Status</th><th>Roles</th><th>Vers&#227;o</th><th>CPU</th><th>Mem&#243;ria</th>
    </tr></thead>
    <tbody>${nodeRows}</tbody>
  </table>
</div>

<!-- ── Tabela de Namespaces ── -->
<div class="k8s-section-titulo">Namespaces (${namespaces.length})</div>
<div class="k8s-card" style="overflow-x:auto">
  <table class="k8s-table">
    <colgroup><col style="width:70%"><col style="width:30%"></colgroup>
    <thead><tr><th>Nome</th><th>Status</th></tr></thead>
    <tbody>${nsRows}</tbody>
  </table>
</div>`;
}

// ── Gerador de HTML — Workloads ───────────────────────────────────────────────

export function gerarHtmlWorkloads(
    namespace: string,
    pods: PodInfo[],
    deployments: DeploymentInfo[],
    statefulsets: StatefulSetInfo[],
    daemonsets: DaemonSetInfo[],
): string {
    const podRows = pods.length === 0
        ? linhaVazia(6, 'Nenhum pod encontrado.')
        : pods.map(p => `
<tr>
  <td><span class="k8s-pod-link" data-nome="${esc(p.nome)}" data-ns="${esc(p.namespace)}" title="Ver detalhes">${esc(p.nome)}</span></td>
  <td>${esc(p.namespace)}</td>
  <td>${badgeStatus(p.status)}</td>
  <td>${p.restarts}</td>
  <td>${esc(p.nodeName ?? '-')}</td>
  <td>
    <div style="display:flex;gap:4px">
      <button class="k8s-qa-btn" data-acao="pod-shell"  data-nome="${esc(p.nome)}" data-ns="${esc(p.namespace)}" title="Shell" ${p.status !== 'Running' ? 'disabled' : ''}>&#9166;</button>
      <button class="k8s-qa-btn k8s-qa-del" data-acao="pod-delete" data-nome="${esc(p.nome)}" data-ns="${esc(p.namespace)}" title="Deletar">&#128465;</button>
    </div>
  </td>
</tr>`).join('');

    const deplRows = deployments.length === 0
        ? linhaVazia(6, 'Nenhum deployment encontrado.')
        : deployments.map(d => {
            const ok = d.replicasDisponiveis >= d.replicasDesejadas && d.replicasDesejadas > 0;
            const statusTxt = `${d.replicasProntas}/${d.replicasDesejadas}`;
            return `
<tr>
  <td title="${esc(d.nome)}">${esc(d.nome)}</td>
  <td>${esc(d.namespace)}</td>
  <td>${badgeStatus(ok ? 'ready' : 'pending')}</td>
  <td>${esc(statusTxt)}</td>
  <td title="${esc(d.imagens.join(', '))}" style="color:var(--muted);font-size:0.78em">${esc(d.imagens[0] ?? '-')}</td>
  <td>
    <div style="display:flex;gap:4px">
      <button class="k8s-qa-btn" data-acao="depl-scale"   data-nome="${esc(d.nome)}" data-ns="${esc(d.namespace)}" data-replicas="${d.replicasDesejadas}" title="Escalar">&#9651;</button>
      <button class="k8s-qa-btn" data-acao="depl-restart" data-nome="${esc(d.nome)}" data-ns="${esc(d.namespace)}" title="Reiniciar">&#8635;</button>
      <button class="k8s-qa-btn k8s-qa-del" data-acao="depl-delete" data-nome="${esc(d.nome)}" data-ns="${esc(d.namespace)}" title="Deletar">&#128465;</button>
    </div>
  </td>
</tr>`;
        }).join('');

    const ssRows = statefulsets.length === 0
        ? linhaVazia(5, 'Nenhum StatefulSet encontrado.')
        : statefulsets.map(ss => `
<tr>
  <td title="${esc(ss.nome)}">${esc(ss.nome)}</td>
  <td>${esc(ss.namespace)}</td>
  <td>${ss.replicasProntas}/${ss.replicasDesejadas}</td>
  <td title="${esc(ss.imagens.join(', '))}" style="color:var(--muted);font-size:0.78em">${esc(ss.imagens[0] ?? '-')}</td>
  <td>
    <div style="display:flex;gap:4px">
      <button class="k8s-qa-btn" data-acao="ss-scale"  data-nome="${esc(ss.nome)}" data-ns="${esc(ss.namespace)}" data-replicas="${ss.replicasDesejadas}" title="Escalar">&#9651;</button>
      <button class="k8s-qa-btn k8s-qa-del" data-acao="ss-delete" data-nome="${esc(ss.nome)}" data-ns="${esc(ss.namespace)}" title="Deletar">&#128465;</button>
    </div>
  </td>
</tr>`).join('');

    const dsRows = daemonsets.length === 0
        ? linhaVazia(4, 'Nenhum DaemonSet encontrado.')
        : daemonsets.map(ds => `
<tr>
  <td title="${esc(ds.nome)}">${esc(ds.nome)}</td>
  <td>${esc(ds.namespace)}</td>
  <td>${ds.numberAvailable}/${ds.desiredNumberScheduled}</td>
  <td title="${esc(ds.imagens.join(', '))}" style="color:var(--muted);font-size:0.78em">${esc(ds.imagens[0] ?? '-')}</td>
</tr>`).join('');

    return /* html */`
<div class="k8s-toolbar">
  <span style="color:var(--muted);font-size:0.78em">Namespace:</span>
  <span style="font-family:var(--font-mono);font-size:0.82em;color:var(--cyan)">${esc(namespace)}</span>
  <button class="k8s-btn" id="btn-topologia" style="margin-left:auto" title="Visualizar grafo de dependências de serviços">&#128200; Topologia</button>
</div>

<div class="k8s-section-titulo">Pods (${pods.length})</div>
<div class="k8s-card" style="margin-bottom:16px;overflow-x:auto">
  <table class="k8s-table">
    <colgroup>
      <col style="width:26%"><col style="width:13%"><col style="width:12%">
      <col style="width:7%"><col style="width:22%"><col style="width:20%">
    </colgroup>
    <thead><tr>
      <th>Nome</th><th>Namespace</th><th>Status</th><th>Restarts</th><th>N&#243;</th><th>A&#231;&#245;es</th>
    </tr></thead>
    <tbody>${podRows}</tbody>
  </table>
</div>

<div class="k8s-section-titulo">Deployments (${deployments.length})</div>
<div class="k8s-card" style="margin-bottom:16px;overflow-x:auto">
  <table class="k8s-table">
    <colgroup>
      <col style="width:24%"><col style="width:13%"><col style="width:11%">
      <col style="width:9%"><col style="width:27%"><col style="width:16%">
    </colgroup>
    <thead><tr>
      <th>Nome</th><th>Namespace</th><th>Status</th><th>R&#233;plicas</th><th>Imagem</th><th>A&#231;&#245;es</th>
    </tr></thead>
    <tbody>${deplRows}</tbody>
  </table>
</div>

<div class="k8s-section-titulo">StatefulSets (${statefulsets.length})</div>
<div class="k8s-card" style="margin-bottom:16px;overflow-x:auto">
  <table class="k8s-table">
    <colgroup>
      <col style="width:28%"><col style="width:16%"><col style="width:12%"><col style="width:28%"><col style="width:16%">
    </colgroup>
    <thead><tr>
      <th>Nome</th><th>Namespace</th><th>R&#233;plicas</th><th>Imagem</th><th>A&#231;&#245;es</th>
    </tr></thead>
    <tbody>${ssRows}</tbody>
  </table>
</div>

<div class="k8s-section-titulo">DaemonSets (${daemonsets.length})</div>
<div class="k8s-card" style="overflow-x:auto">
  <table class="k8s-table">
    <colgroup>
      <col style="width:30%"><col style="width:18%"><col style="width:15%"><col style="width:37%">
    </colgroup>
    <thead><tr>
      <th>Nome</th><th>Namespace</th><th>Agendados</th><th>Imagem</th>
    </tr></thead>
    <tbody>${dsRows}</tbody>
  </table>
</div>`;
}

// ── Gerador de HTML — Networking ─────────────────────────────────────────────

export function gerarHtmlNetworking(
    namespace: string,
    services: ServiceK8sInfo[],
): string {
    const rows = services.length === 0
        ? linhaVazia(5, 'Nenhum servi&#231;o encontrado.')
        : services.map(s => {
            const portas = s.portas.map(p => `${p.porta}${p.protocolo !== 'TCP' ? `/${p.protocolo}` : ''}${p.nodePort ? `:${p.nodePort}` : ''}`).join(', ');
            return `
<tr>
  <td title="${esc(s.nome)}">${esc(s.nome)}</td>
  <td>${esc(s.namespace)}</td>
  <td>${esc(s.tipo)}</td>
  <td>${esc(s.clusterIP)}</td>
  <td style="font-family:var(--font-mono);font-size:0.78em">${esc(portas || '-')}</td>
</tr>`;
        }).join('');

    return /* html */`
<div class="k8s-toolbar">
  <span style="color:var(--muted);font-size:0.78em">Namespace:</span>
  <span style="font-family:var(--font-mono);font-size:0.82em;color:var(--cyan)">${esc(namespace)}</span>
</div>

<div class="k8s-section-titulo">Services (${services.length})</div>
<div class="k8s-card" style="overflow-x:auto">
  <table class="k8s-table">
    <colgroup>
      <col style="width:28%"><col style="width:15%"><col style="width:13%">
      <col style="width:15%"><col style="width:29%">
    </colgroup>
    <thead><tr>
      <th>Nome</th><th>Namespace</th><th>Tipo</th><th>Cluster IP</th><th>Portas</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
}

// ── Gerador de HTML — Storage (estilo Storage Manager) ───────────────────────

export function gerarHtmlStorage(
    namespace: string,
    pvcs: PVCInfo[],
): string {
    if (pvcs.length === 0) {
        return /* html */`
<div class="k8s-vol-toolbar">
  <span class="k8s-vol-ns-label">&#128452; Namespace: <strong>${esc(namespace)}</strong></span>
</div>
<div class="k8s-vol-vazio">
  <div style="font-size:2.5em;opacity:0.3">&#128452;</div>
  <div>Nenhum PersistentVolumeClaim encontrado neste namespace.</div>
</div>`;
    }

    const rows = pvcs.map((p, idx) => {
        const cor = p.status === 'Bound' ? '#00FF88'
            : p.status === 'Pending' ? '#f59e0b'
            : '#FF2DAA';
        const corBg = p.status === 'Bound' ? 'rgba(0,255,136,0.12)'
            : p.status === 'Pending' ? 'rgba(245,158,11,0.12)'
            : 'rgba(255,45,170,0.12)';
        const accessModeAbrev = (p.accessModes ?? []).map(m =>
            m === 'ReadWriteOnce' ? 'RWO'
            : m === 'ReadWriteMany' ? 'RWX'
            : m === 'ReadOnlyMany' ? 'ROX'
            : m === 'ReadWriteOncePod' ? 'RWOP'
            : m).join(', ') || '-';
        const criado = p.criado ? new Date(p.criado).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '-';

        return /* html */`
<tr class="k8s-vol-row" data-idx="${idx}">
  <td class="k8s-vol-chevron-cell"><span class="k8s-vol-chevron">&#9658;</span></td>
  <td class="k8s-vol-name" title="${esc(p.nome)}">${esc(p.nome)}</td>
  <td style="color:var(--muted);font-size:0.82em;font-family:var(--font-mono)">${esc(p.namespace)}</td>
  <td><span class="k8s-vol-status-badge" style="background:${corBg};color:${cor}">${esc(p.status)}</span></td>
  <td><div class="k8s-vol-cap"><span class="k8s-vol-cap-valor">${esc(p.capacidade || '-')}</span></div></td>
  <td style="font-family:var(--font-mono);font-size:0.78em;color:var(--muted)">${esc(accessModeAbrev)}</td>
  <td style="font-size:0.78em;color:var(--muted);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.storageClass)}">${esc(p.storageClass || '-')}</td>
</tr>
<tr class="k8s-vol-detail" id="k8s-vol-detail-${idx}" style="display:none">
  <td></td>
  <td colspan="6">
    <div class="k8s-vol-detail-grid">
      <div class="k8s-vol-detail-item">
        <div class="k8s-vol-detail-label">STATUS</div>
        <div class="k8s-vol-detail-val"><span style="color:${cor}">${esc(p.status)}</span></div>
      </div>
      <div class="k8s-vol-detail-item">
        <div class="k8s-vol-detail-label">ACCESS MODE</div>
        <div class="k8s-vol-detail-val">${esc((p.accessModes ?? []).join(', ') || '-')}</div>
      </div>
      <div class="k8s-vol-detail-item">
        <div class="k8s-vol-detail-label">VOLUME MODE</div>
        <div class="k8s-vol-detail-val">${esc(p.volumeMode || 'Filesystem')}</div>
      </div>
      <div class="k8s-vol-detail-item">
        <div class="k8s-vol-detail-label">STORAGE CLASS</div>
        <div class="k8s-vol-detail-val" style="font-family:var(--font-mono)">${esc(p.storageClass || '-')}</div>
      </div>
      <div class="k8s-vol-detail-item">
        <div class="k8s-vol-detail-label">VOLUME (PV)</div>
        <div class="k8s-vol-detail-val" style="font-family:var(--font-mono)">${p.volumeName ? esc(p.volumeName) : '<span style="opacity:0.4">n&#227;o vinculado</span>'}</div>
      </div>
      <div class="k8s-vol-detail-item">
        <div class="k8s-vol-detail-label">CRIADO EM</div>
        <div class="k8s-vol-detail-val">${criado}</div>
      </div>
    </div>
  </td>
</tr>`;
    }).join('');

    return /* html */`
<div class="k8s-vol-toolbar">
  <span class="k8s-vol-ns-label">&#128452; Namespace: <strong>${esc(namespace)}</strong></span>
  <span class="k8s-vol-count">${pvcs.length} volume(s)</span>
</div>

<div class="k8s-vol-table-wrap">
  <table class="k8s-vol-table">
    <thead>
      <tr>
        <th style="width:28px"></th>
        <th>Nome</th>
        <th style="width:130px">Namespace</th>
        <th style="width:90px">Status</th>
        <th style="width:110px">Capacidade</th>
        <th style="width:70px">Access</th>
        <th style="width:160px">StorageClass</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
}

// ── Gerador de HTML — Namespaces ──────────────────────────────────────────────

export function gerarHtmlNamespaces(namespaces: NamespaceInfo[]): string {
    const rows = namespaces.length === 0
        ? linhaVazia(3, 'Nenhum namespace encontrado.')
        : namespaces.map(ns => {
            const criado = ns.criado ? new Date(ns.criado).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '-';
            return `
<tr>
  <td title="${esc(ns.nome)}" style="font-family:var(--font-mono)">${esc(ns.nome)}</td>
  <td>${badgeStatus(ns.status)}</td>
  <td style="color:var(--muted);font-size:0.82em">${criado}</td>
</tr>`;
        }).join('');

    return /* html */`
<div class="k8s-section-titulo">Namespaces (${namespaces.length})</div>
<div class="k8s-card" style="overflow-x:auto">
  <table class="k8s-table">
    <colgroup><col style="width:55%"><col style="width:20%"><col style="width:25%"></colgroup>
    <thead><tr><th>Nome</th><th>Status</th><th>Criado em</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
}

// ── Gerador de HTML — Nodes (Cluster) ─────────────────────────────────────────

export function gerarHtmlNodes(nodes: NodeInfo[]): string {
    const rows = nodes.length === 0
        ? linhaVazia(7, 'Nenhum nó encontrado.')
        : nodes.map(n => {
            const criado = n.criado ? new Date(n.criado).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '-';
            return `
<tr>
  <td title="${esc(n.nome)}" style="font-family:var(--font-mono)">${esc(n.nome)}</td>
  <td>${badgeStatus(n.status)}</td>
  <td style="color:var(--muted);font-size:0.82em">${esc(n.roles.join(', '))}</td>
  <td style="font-family:var(--font-mono);font-size:0.82em">${esc(n.versao)}</td>
  <td style="text-align:center">${esc(n.cpu.capacidade)}</td>
  <td style="font-size:0.82em">${esc(n.memoria.capacidade)}</td>
  <td style="color:var(--muted);font-size:0.82em">${criado}</td>
</tr>`;
        }).join('');

    return /* html */`
<div class="k8s-section-titulo">N&#243;s do Cluster (${nodes.length})</div>
<div class="k8s-card" style="overflow-x:auto">
  <table class="k8s-table">
    <colgroup>
      <col style="width:28%"><col style="width:10%"><col style="width:16%">
      <col style="width:16%"><col style="width:8%"><col style="width:12%"><col style="width:10%">
    </colgroup>
    <thead><tr>
      <th>Nome</th><th>Status</th><th>Roles</th>
      <th>Vers&#227;o</th><th>CPUs</th><th>Mem&#243;ria</th><th>Criado em</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
}

// ── Gerador de HTML — Configurações K8s ──────────────────────────────────────

export function gerarHtmlConfig(
    namespace: string,
    configmaps: ConfigMapInfo[],
    secrets: SecretInfo[],
): string {
    const cmRows = configmaps.length === 0
        ? linhaVazia(3, 'Nenhum ConfigMap encontrado.')
        : configmaps.map(cm => `
<tr>
  <td title="${esc(cm.nome)}">${esc(cm.nome)}</td>
  <td>${esc(cm.namespace)}</td>
  <td style="color:var(--muted)">${cm.chaves.length} chave(s)</td>
</tr>`).join('');

    const secretRows = secrets.length === 0
        ? linhaVazia(4, 'Nenhum secret encontrado.')
        : secrets.map(s => `
<tr>
  <td title="${esc(s.nome)}">${esc(s.nome)}</td>
  <td>${esc(s.namespace)}</td>
  <td style="color:var(--muted);font-size:0.78em">${esc(s.tipo)}</td>
  <td style="color:var(--muted)">${s.numeroCHaves} chave(s) <span style="color:var(--parado)">[valores ocultos]</span></td>
</tr>`).join('');

    return /* html */`
<div class="k8s-toolbar">
  <span style="color:var(--muted);font-size:0.78em">Namespace:</span>
  <span style="font-family:var(--font-mono);font-size:0.82em;color:var(--cyan)">${esc(namespace)}</span>
</div>

<div class="k8s-section-titulo">ConfigMaps (${configmaps.length})</div>
<div class="k8s-card" style="margin-bottom:16px;overflow-x:auto">
  <table class="k8s-table">
    <colgroup><col style="width:40%"><col style="width:30%"><col style="width:30%"></colgroup>
    <thead><tr><th>Nome</th><th>Namespace</th><th>Chaves</th></tr></thead>
    <tbody>${cmRows}</tbody>
  </table>
</div>

<div class="k8s-section-titulo">Secrets (${secrets.length})</div>
<div style="color:var(--muted);font-size:0.75em;margin-bottom:8px">&#128274; Valores dos secrets nunca s&#227;o exibidos por seguran&#231;a.</div>
<div class="k8s-card" style="overflow-x:auto">
  <table class="k8s-table">
    <colgroup>
      <col style="width:32%"><col style="width:18%"><col style="width:20%"><col style="width:30%">
    </colgroup>
    <thead><tr><th>Nome</th><th>Namespace</th><th>Tipo</th><th>Chaves</th></tr></thead>
    <tbody>${secretRows}</tbody>
  </table>
</div>`;
}

// ── Gerador de HTML — Erro de conexão K8s ────────────────────────────────────

export function gerarHtmlK8sIndisponivel(motivo: string, detalheHtml?: string): string {
    return /* html */`
<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;text-align:center;gap:16px">
  <div style="font-size:3em">&#9096;</div>
  <div style="font-size:1.1em;color:var(--cyan)">Kubernetes n&#227;o dispon&#237;vel</div>
  <div style="color:var(--muted);font-size:0.85em;max-width:480px">${esc(motivo)}</div>
  ${detalheHtml ? `<div style="color:var(--muted);font-size:0.82em;max-width:480px;text-align:left">${detalheHtml}</div>` : ''}
  <button class="k8s-btn" onclick="postK8s('carregarK8s','cluster')">Tentar novamente</button>
</div>`;
}

// ── Utilitário para bytes importável ─────────────────────────────────────────

export { bytes };
