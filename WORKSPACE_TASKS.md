# 🧭 WORKSPACE_TASKS.md

## Objetivo
Este arquivo define **tarefas sequenciais e verificáveis** para o GitHub Copilot Workspace executar, garantindo que a extensão Docker para VS Code seja construída **do início ao fim**, com qualidade de produção.

Este arquivo deve ser usado **junto com** `COPILOT_WORKSPACE.md`.

---

## 📌 Como o Copilot Workspace deve usar este arquivo

- Executar as tarefas **na ordem definida**
- Não pular etapas
- Validar cada fase antes de avançar
- Ajustar decisões técnicas quando necessário

---

## 🧩 FASE 1 — Inicialização do Projeto

### Tarefas
1. Inicializar um projeto de extensão VS Code com TypeScript
2. Garantir que `package.json`, `tsconfig.json` e estrutura base existam
3. Configurar scripts de build e watch
4. Validar que a extensão compila sem erros

✅ Critério de aceite:
- `npm run compile` funciona
- Extensão carrega no VS Code (F5)

---

## 🐳 FASE 2 — Integração Docker

### Tarefas
1. Instalar e configurar `dockerode`
2. Implementar `dockerClient.ts`
3. Detectar Docker instalado e em execução
4. Tratar erros de permissão

✅ Critério de aceite:
- Consegue listar containers reais
- Erros são exibidos ao usuário

---

## 📦 FASE 3 — Serviços Docker

### Tarefas
1. Implementar `containerService`
2. Implementar `imageService`
3. Implementar `volumeService`
4. Cobrir operações CRUD necessárias

✅ Critério de aceite:
- Todas as operações retornam dados válidos

---

## 🌲 FASE 4 — Tree View

### Tarefas
1. Criar `DockerTreeView`
2. Implementar grupos (Containers, Images, Volumes, Networks)
3. Criar TreeItems com ícones dinâmicos
4. Implementar refresh manual e automático

✅ Critério de aceite:
- Containers aparecem corretamente na sidebar

---

## 🧩 FASE 5 — Commands

### Tarefas
1. Implementar comandos de container (start/stop/restart/remove)
2. Implementar comando de logs
3. Implementar exec shell com terminal integrado
4. Ligar comandos aos menus de contexto

✅ Critério de aceite:
- Ações funcionam via clique direito

---

## 🌐 FASE 6 — Webviews

### Tarefas
1. Criar Webview de detalhes do container
2. Carregar dados reais via Docker API
3. Implementar abas (Overview, Logs, Env, Ports, Stats)
4. Comunicação segura com `postMessage`

✅ Critério de aceite:
- Webview exibe dados reais do container

---

## 🧪 FASE 7 — Testes

### Tarefas
1. Criar testes unitários para serviços Docker
2. Testar cenários de erro
3. Garantir cobertura dos fluxos principais

✅ Critério de aceite:
- Testes passam localmente

---

## 🔐 FASE 8 — Segurança e Hardening

### Tarefas
1. Revisar acesso ao docker socket
2. Garantir confirmações para ações destrutivas
3. Revisar mensagens de erro

✅ Critério de aceite:
- Nenhuma ação destrutiva sem confirmação

---

## 📘 FASE 9 — Documentação

### Tarefas
1. Criar README.md
2. Documentar riscos de segurança
3. Documentar como usar a extensão

✅ Critério de aceite:
- README claro e completo

---

## 🚀 FASE 10 — Validação Final

### Tarefas
1. Rodar extensão em ambiente local
2. Validar todos os fluxos principais
3. Revisar organização do código

✅ Critério de aceite FINAL:
- Extensão pronta para publicação

---

> Só avance para a próxima fase quando a atual estiver validada.
