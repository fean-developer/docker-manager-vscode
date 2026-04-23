# Docker Manager — Extensão VS Code

Gerencie containers, imagens, volumes e redes Docker diretamente na sua IDE, sem precisar sair do VS Code.

---

## Funcionalidades

- **Dashboard** com resumo do ambiente Docker: versão do Engine, OS, CPUs, memória e contadores de recursos
- **Lista de containers** com checkboxes, ações em lote (Start, Stop, Kill, Restart, Pause, Resume, Remove), busca em tempo real e ordenação por coluna
- **Sidebar interativa** com árvore de Containers, Imagens, Volumes e Redes
- **Botões de ação inline** na árvore: Start/Stop/Restart/Remove para containers; Remove para imagens e volumes
- **Atualização automática** a cada 10 segundos
- **Gerenciamento de containers**: iniciar, parar, reiniciar, matar (SIGKILL), pausar, retomar e remover
- **Logs ao vivo** com **auto-atualização configurável** (2s, 5s, 10s, 30s, 1 min) — igual ao Portainer
- **Terminal integrado** com exec direto no container
- **Webview de detalhes** com 5 abas: Overview, Logs, Variáveis de Ambiente, Portas e Stats
- **Botões de ação no detalhe**: Start, Stop, Restart e Remover com feedback visual
- **Remoção em lote** de imagens e volumes com confirmação obrigatória

---

## Pré-requisitos

- VS Code 1.85 ou superior
- Docker Engine instalado e em execução na máquina local
- Usuário com acesso ao socket Docker (`/var/run/docker.sock` no Linux/macOS)

### Linux — Conceder acesso ao socket Docker sem sudo

```bash
sudo usermod -aG docker $USER
# Faça logout e login novamente para aplicar
```

---

## Instalação

1. Abra o VS Code
2. Vá em Extensions (`Ctrl+Shift+X`)
3. Busque por **Docker Manager**
4. Clique em **Install**

Ou instale manualmente o `.vsix`:

```bash
code --install-extension vscode-docker-manager-0.1.0.vsix
```

---

## Como usar

Após a instalação, o ícone do Docker Manager aparece na barra lateral (Activity Bar).

### Dashboard

Clique no ícone `$(dashboard)` na toolbar da sidebar para abrir o **Dashboard**.

| Informação | Descrição |
|---|---|
| Node Info | Hostname, versão do Docker, OS, arquitetura, CPUs e memória total |
| Containers | Total, em execução e parados |
| Imagens | Quantidade e tamanho total em disco |
| Volumes | Quantidade total |
| Redes | Quantidade total |

### Lista de Containers (visão Portainer)

Clique no ícone `$(list-unordered)` na toolbar da sidebar para abrir a **Lista de Containers**.

| Recurso | Descrição |
|---|---|
| Checkboxes | Selecione um ou vários containers para ação em lote |
| Toolbar de ações | Start, Stop, Kill, Restart, Pause, Resume, Remove aplicados a todos selecionados |
| Busca | Filtra por nome, imagem ou estado em tempo real |
| Ordenação | Clique em qualquer cabeçalho de coluna para ordenar |
| Quick Actions | Ícones por linha: Ver Logs, Inspecionar, Abrir Terminal |
| Portas | Portas publicadas são links clicáveis |

### Containers (sidebar)

| Ação | Como fazer |
|---|---|
| Ver containers | Expanda o grupo **Containers** na sidebar |
| Iniciar | Botão inline ▶ ou clique direito → **Iniciar Container** |
| Parar | Botão inline ■ ou clique direito → **Parar Container** |
| Reiniciar | Botão inline ↻ ou clique direito → **Reiniciar Container** |
| Ver logs | Clique direito → **Ver Logs** |
| Abrir terminal | Clique direito → **Abrir Terminal no Container** |
| Inspecionar / Detalhes | Clique no container |
| Remover | Botão inline 🗑 ou clique direito → **Remover Container** *(confirmação obrigatória)* |

### Webview de Detalhes do Container

Aberto via **Inspecionar Container**, exibe 5 abas:

| Aba | Conteúdo |
|---|---|
| Overview | ID, imagem, estado, rede, política de restart, etc. |
| Logs | Logs do container com **auto-atualização** configurável (Desativado / 2s / 5s / 10s / 30s / 1min) |
| Variáveis de Ambiente | Todas as env vars do container |
| Portas | Mapeamento de portas internas → públicas |
| Stats | CPU %, Memória, Rede RX/TX em tempo real |

**Botões de ação**: Start, Stop, Restart e Remover — estado dos botões atualizado automaticamente conforme o container.

### Imagens

| Ação | Como fazer |
|---|---|
| Ver imagens | Expanda o grupo **Imagens** |
| Remover imagem | Botão inline 🗑 ou clique direito → **Remover Imagem** *(confirmação obrigatória)* |
| Limpar não utilizadas | Clique direito → **Remover Imagens Não Utilizadas** |

### Volumes

| Ação | Como fazer |
|---|---|
| Ver volumes | Expanda o grupo **Volumes** |
| Remover volume | Botão inline 🗑 ou clique direito → **Remover Volume** *(confirmação obrigatória)* |
| Limpar não utilizados | Clique direito → **Remover Volumes Não Utilizados** |

---

## Segurança

> **Atenção:** O acesso ao socket Docker é equivalente a acesso root no host.

Esta extensão adota as seguintes medidas de segurança:

- **Acesso somente local**: conexão exclusiva via Unix socket (`/var/run/docker.sock`) ou named pipe no Windows. Nenhuma conexão de rede é aberta.
- **Sem servidor HTTP**: a extensão não expõe nenhuma porta ou serviço de rede.
- **Sem log de dados sensíveis**: variáveis de ambiente e configurações de container não são logadas.
- **Confirmação obrigatória** para todas as ações destrutivas (remover container, imagem, volume, kill em lote).
- **Content Security Policy (CSP)** rígida nos Webviews: apenas scripts com nonce são permitidos; nenhum recurso externo é carregado.
- **Webview com `localResourceRoots` restrito**: apenas o diretório `resources/` da extensão pode ser acessado.

### Riscos conhecidos

| Risco | Mitigação |
|---|---|
| Acesso ao socket Docker | Apenas via socket local; documentado explicitamente |
| Execução de comandos no container | Requer que o container esteja em execução; usuário inicia a ação |
| Remoção de dados | Confirmação modal obrigatória antes de qualquer remoção |
| XSS no Webview | CSP com nonce; toda saída de dados do Docker é escapada antes de renderizar |

---

## Desenvolvimento

```bash
# Clone o repositório
git clone https://github.com/seu-usuario/vscode-docker-manager.git
cd vscode-docker-manager

# Instale as dependências
npm install

# Compile
npm run compile

# Inicie no modo watch
npm run watch

# Pressione F5 no VS Code para abrir a Extension Development Host
```

### Estrutura do projeto

```
src/
├── extension.ts                   # Entry point
├── docker/
│   └── dockerClient.ts            # Singleton de conexão com o Docker
├── services/
│   ├── containerService.ts        # Operações de containers (start/stop/restart/kill/pause/resume/remove/logs/stats)
│   ├── imageService.ts            # Operações de imagens
│   ├── volumeService.ts           # Operações de volumes
│   └── networkService.ts          # Operações de redes
├── views/
│   ├── dockerTreeProvider.ts      # TreeDataProvider da sidebar com polling automático
│   └── dockerTreeItem.ts          # Itens da árvore com ícones e badges dinâmicos
├── commands/
│   └── dockerCommands.ts          # Todos os comandos registrados
├── webviews/
│   ├── dashboardPanel.ts          # Dashboard — visão geral do ambiente Docker
│   ├── containerListPanel.ts      # Lista de containers com checkboxes e ações em lote
│   └── containerDetailPanel.ts    # Detalhe do container com 5 abas e botões de ação
└── test/
    ├── dockerClient.test.ts
    ├── containerService.test.ts
    └── runTests.ts
```

---

## Pré-requisitos

- VS Code 1.85 ou superior
- Docker Engine instalado e em execução na máquina local
- Usuário com acesso ao socket Docker (`/var/run/docker.sock` no Linux/macOS)

### Linux — Conceder acesso ao socket Docker sem sudo

```bash
sudo usermod -aG docker $USER
# Faça logout e login novamente para aplicar
```

---

## Instalação

1. Abra o VS Code
2. Vá em Extensions (`Ctrl+Shift+X`)
3. Busque por **Docker Manager**
4. Clique em **Install**

Ou instale manualmente o `.vsix`:

```bash
code --install-extension vscode-docker-manager-0.1.0.vsix
```

---

## Como usar

Após a instalação, o ícone do Docker Manager aparece na barra lateral (Activity Bar).

### Containers

| Ação | Como fazer |
|---|---|
| Ver containers | Expanda o grupo **Containers** na sidebar |
| Iniciar | Clique direito → **Iniciar Container** |
| Parar | Clique direito → **Parar Container** |
| Reiniciar | Clique direito → **Reiniciar Container** |
| Ver logs | Clique direito → **Ver Logs** |
| Abrir terminal | Clique direito → **Abrir Terminal no Container** |
| Inspecionar / Detalhes | Clique no container |
| Remover | Clique direito → **Remover Container** *(confirmação obrigatória)* |

### Imagens

| Ação | Como fazer |
|---|---|
| Ver imagens | Expanda o grupo **Imagens** |
| Remover imagem | Clique direito → **Remover Imagem** *(confirmação obrigatória)* |
| Limpar não utilizadas | Comando `Docker Manager: Remover Imagens Não Utilizadas` |

### Volumes

| Ação | Como fazer |
|---|---|
| Ver volumes | Expanda o grupo **Volumes** |
| Remover volume | Clique direito → **Remover Volume** *(confirmação obrigatória)* |
| Limpar não utilizados | Comando `Docker Manager: Remover Volumes Não Utilizados` |

---

## Segurança

> **Atenção:** O acesso ao socket Docker é equivalente a acesso root no host.

Esta extensão adota as seguintes medidas de segurança:

- **Acesso somente local**: conexão exclusiva via Unix socket (`/var/run/docker.sock`) ou named pipe no Windows. Nenhuma conexão de rede é aberta.
- **Sem servidor HTTP**: a extensão não expõe nenhuma porta ou serviço de rede.
- **Sem log de dados sensíveis**: variáveis de ambiente e configurações de container não são logadas.
- **Confirmação obrigatória** para todas as ações destrutivas (remover container, imagem, volume).
- **Content Security Policy (CSP)** rígida nos Webviews: apenas scripts com nonce são permitidos; nenhum recurso externo é carregado.
- **Webview com `localResourceRoots` restrito**: apenas o diretório `resources/` da extensão pode ser acessado.

### Riscos conhecidos

| Risco | Mitigação |
|---|---|
| Acesso ao socket Docker | Apenas via socket local; documentado explicitamente |
| Execução de comandos no container | Requer que o container esteja em execução; usuário inicia a ação |
| Remoção de dados | Confirmação modal obrigatória antes de qualquer remoção |
| XSS no Webview | CSP com nonce; toda saída de dados do Docker é escapada antes de renderizar |

---

## Desenvolvimento

```bash
# Clone o repositório
git clone https://github.com/seu-usuario/vscode-docker-manager.git
cd vscode-docker-manager

# Instale as dependências
npm install

# Compile
npm run compile

# Inicie no modo watch
npm run watch

# Pressione F5 no VS Code para abrir a Extension Development Host
```

### Estrutura do projeto

```
src/
├── extension.ts                 # Entry point
├── docker/
│   └── dockerClient.ts          # Singleton de conexão com o Docker
├── services/
│   ├── containerService.ts      # Operações de containers
│   ├── imageService.ts          # Operações de imagens
│   ├── volumeService.ts         # Operações de volumes
│   └── networkService.ts        # Operações de redes
├── views/
│   ├── dockerTreeProvider.ts    # TreeDataProvider da sidebar
│   └── dockerTreeItem.ts        # Itens da árvore com ícones dinâmicos
├── commands/
│   └── dockerCommands.ts        # Todos os comandos registrados
├── webviews/
│   └── containerDetailPanel.ts  # Webview de detalhes do container
└── test/
    ├── dockerClient.test.ts
    ├── containerService.test.ts
    └── runTests.ts
```

---

## Licença

MIT
