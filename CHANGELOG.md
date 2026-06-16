# Changelog

Todas as mudanças relevantes deste projeto são documentadas neste arquivo.  
Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/).

---

## [1.0.0] — 2026-06-16

### Adicionado — Kubernetes
- Painel Kubernetes completo com suporte a múltiplos clusters e contextos (`~/.kube/config`)
- Seletor de contexto e namespace integrados na toolbar do painel
- Suporte a clusters `kind` com bind em `0.0.0.0` — corrigido automaticamente para `127.0.0.1` com `skipTLSVerify`
- Listagem de: Pods, Deployments, StatefulSets, Services, ConfigMaps, Secrets, Nodes, Namespaces, PersistentVolumeClaims, DaemonSets, Ingresses
- **Monitoramento de Pods em tempo real**: CPU em millicores e RAM (workingSet) em bytes via Kubelet Stats Summary API — sem dependência do `metrics-server`; intervalo de 1 segundo
- **Escalar Deployments e StatefulSets** via Scale subresource (`replaceNamespacedDeploymentScale` / `replaceNamespacedStatefulSetScale`) — apenas `spec.replicas` é alterado
- **Rolling restart seguro** via JSON Patch RFC 6902 — apenas a annotation `kubectl.kubernetes.io/restartedAt` é modificada; nenhuma réplica extra é criada
- **Deleção inteligente de Pods**: detecta `ownerReference` e oferece opção de escalar Deployment para N-1 ou apenas deletar o pod (que será recriado)
- Diálogo de confirmação antes do rolling restart, explicando o comportamento de substituição gradual
- Auto-refresh da seção Kubernetes após ações (+0s, +3s e +7s) para refletir estados transicionais (Pending → Running)
- **Grafo de Topologia** (`📈 Topologia`): diagrama hierárquico esquerda→direita das dependências entre Services, Deployments e StatefulSets
  - Layout BFS com minimização de cruzamentos por ordenação por predecessor médio
  - Nós hexagonais (flat-top) com ícone de switch de rede desenhado em canvas
  - Arestas teal com seta triangular preenchida
  - Grade de pontos no fundo e fundo escuro `#06101b`
  - Interativo: arrastar nós, pan, zoom com scroll, tooltip com detalhes no hover
  - Arestas inferidas por label selectors (Service→Workload) e variáveis de ambiente (Workload→Service)
- Seletores de contexto e namespace com `color-scheme: dark` e cores hex hardcoded para compatibilidade com tema escuro do VS Code

### Corrigido — Kubernetes
- Restart de Deployment escalava +1 réplica inadvertidamente — era causado pelo uso de `replaceNamespacedDeployment` (PUT completo); substituído por JSON Patch
- Modal de escala ficava como "pending" sem auto-atualizar — resolvido com refreshes adicionais em +3s e +7s
- Deletar pod pertencente a Deployment não funcionava efetivamente — o Kubernetes recriava o pod; resolvido com detecção de owner e oferta de escalar para N-1
- Seletores dropdown com texto branco sobre fundo branco no tema escuro — resolvido com `color-scheme: dark` e cores hex hardcoded nos elementos `<select>` e `<option>`
- Botão de logs (📄) removido da lista de pods (ação redundante)

---

## [0.1.20] — 2026-04-24

### Adicionado — Docker
- Dashboard abre automaticamente ao clicar no ícone da Activity Bar; sidebar fecha automaticamente
- Dashboard reabre ao fechar a aba sem necessidade de clicar novamente na Activity Bar
- Monitoramento via streaming contínuo (`stream: true`) — CPU % preciso no Docker Desktop e WSL2 (sem valores zerados por cache)
- Gráficos de CPU, Memória e Rede com rótulos no eixo Y movidos para a aba **Geral**
- Logs inline na aba **Logs** com auto-refresh configurável (Desativado / 2s / 5s / 10s / 30s / 1min) sem flicker
- Terminal (`exec`) compatível com WSL — usa `sendText` em vez de `shellPath`
- Intervalo de monitoramento reduzido para 1 segundo; histórico de 60 pontos
- Aba **Inspect JSON** adicionada na webview de detalhes do container

### Corrigido — Docker
- CPU % zerado no Docker Desktop e WSL2 ao usar polling simples — resolvido com streaming contínuo
- Flicker nos logs ao atualizar — resolvido com atualização incremental do conteúdo
- Terminal não abria em ambientes WSL — resolvido com `sendText` via terminal integrado do VS Code

---

## [0.1.0] — 2026-04-01

### Adicionado
- Versão inicial da extensão
- Sidebar com árvore de Containers, Imagens, Volumes e Redes
- Dashboard com informações do Docker Engine (versão, OS, CPUs, memória, contadores)
- Lista de containers com checkboxes, ações em lote e busca em tempo real
- Webview de detalhes com abas: Geral, Logs, Portas, Variáveis de Ambiente
- Ações inline na sidebar: Start, Stop, Restart, Remove
- Remoção de imagens e volumes com confirmação obrigatória
- Atualização automática a cada 10 segundos
- Content Security Policy (CSP) com nonce nos Webviews
- Acesso exclusivo via socket local — sem conexões de rede
