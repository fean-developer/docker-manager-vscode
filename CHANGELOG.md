# Changelog

Todas as mudanças relevantes deste projeto são documentadas neste arquivo.  
Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/).

---

## [1.0.11] — 2026-08-03

### Corrigido — Kubernetes
- Manifestos exibidos na sidebar agora são gerados como YAML válido usando o serializador do client Kubernetes.
- Removido `metadata.managedFields` da visualização para evitar blocos ruidosos `f:...` e melhorar leitura.
- Mantido mascaramento de `data` e `stringData` em Secrets antes de renderizar o YAML.

---

## [1.0.10] — 2026-08-03

### Corrigido — Kubernetes
- Hotfix para erro em runtime `ns is not defined` no painel Kubernetes, que podia exibir "Kubernetes não disponível" mesmo com cluster acessível.
- Corrigido o bloco HTML de detalhe de PVC (Volumes) que estava com referência inválida de variável fora de escopo.

---

## [1.0.9] — 2026-08-03

### Adicionado — Kubernetes
- Tela de detalhe de Pod agora possui botão de **Shell** com a mesma ação já usada na lista de Pods.
- Sidebar de **Manifest YAML** para recursos Kubernetes com abertura por clique no nome do recurso ou por botão de manifest nas ações rápidas.
- Suporte de manifest para recursos exibidos no painel: Namespaces, Nodes, Pods, Deployments, StatefulSets, DaemonSets, Services, PVCs, ConfigMaps e Secrets.

### Alterado — Kubernetes
- Ícones/botões de ações da aba **Aplicações** ampliados para melhorar legibilidade e usabilidade.

### Segurança — Kubernetes
- Manifesto de Secret é exibido com `data` e `stringData` mascarados (`[oculto]`) no painel.

---

## [1.0.8] — 2026-08-03

### Alterado — Kubernetes
- Enquadramento inicial da topologia ajustado para abrir mais afastado, exibindo a visão vertical completa com menos necessidade de pan ou zoom manual.

---

## [1.0.7] — 2026-08-03

### Alterado — Kubernetes
- Ordem vertical da topologia invertida para representar a visão solicitada: Node, Pod, Workload, Service e Ingress.
- Setas do grafo ajustadas para apontar de cima para baixo nessa ordem arquitetural.

---

## [1.0.6] — 2026-08-03

### Alterado — Kubernetes
- Topologia alterada para orientação vertical, exibindo o fluxo arquitetural de cima para baixo: Ingress, Service, Workload, Pod e Node.

---

## [1.0.5] — 2026-08-03

### Alterado — Kubernetes
- Topologia reorganizada para fluxo arquitetural em colunas fixas: Ingress, Service, Workload, Pod e Node.
- Relações alteradas para `Service -> Workload -> Pod -> Node`, evitando a leitura invertida `Service -> Pod -> Workload` e reduzindo sobreposição visual.

---

## [1.0.4] — 2026-08-03

### Corrigido — Kubernetes
- Corrigido erro de JavaScript no webview causado por trecho duplicado do layout antigo da topologia, que podia deixar a tela principal em branco ao carregar o painel.

---

## [1.0.3] — 2026-08-03

### Alterado — Kubernetes
- Botão **Topologia** movido para o cabeçalho principal do painel Kubernetes, ficando disponível junto dos seletores de cluster e namespace.
- Layout inicial da topologia reorganizado em blocos compactos por componente conectado, com camadas fixas por tipo de recurso para reduzir a necessidade de arrastar ou navegar pelo canvas.

---

## [1.0.2] — 2026-08-03

### Adicionado — Kubernetes
- Topologia Kubernetes ampliada para mostrar relacionamentos arquiteturais entre Ingress, Services, Pods, Nodes, Deployments, StatefulSets e DaemonSets no namespace selecionado.
- Arestas do grafo inferidas a partir de backends de Ingress, selectors de Service, `ownerReferences` dos Pods e agendamento dos Pods em Nodes.
- Legenda, badges, tooltips e rótulos de conexões atualizados para diferenciar cada tipo de recurso e expor detalhes úteis como tipo de Service, status, réplicas e Node de execução.

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
