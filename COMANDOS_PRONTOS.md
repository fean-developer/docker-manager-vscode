# 🚀 COMANDOS PRONTOS PARA USAR

## ✅ Instalação Rápida

### Passo 1: Desinstalar versão antiga (se houver)
```bash
code --uninstall-extension docker-manager.vscode-docker-manager
```

### Passo 2: Instalar nova versão
```bash
code --install-extension /home/fnascimento/fean-projects/docker-manager-vscode/vscode-docker-manager-0.1.0.vsix
```

### Passo 3: Reabrir VS Code
- Feche completamente o VS Code
- Reabra normalmente

### Passo 4: Verificar
- Na sidebar esquerda, clique no ícone Docker (Docker Manager)
- Você deve ver:
  - ✅ **Containers** - lista de containers
  - ✅ **Imagens** - lista de imagens
  - ✅ **Volumes** - lista de volumes
  - ✅ **Redes** - lista de networks

---

## 🧪 Testes de Validação

### Teste rápido do bundle
```bash
cd /home/fnascimento/fean-projects/docker-manager-vscode

# Verificar se dockerode está no bundle
grep -c "dockerode" out/extension.js
# Resultado esperado: 42 (ou qualquer número > 0)
```

### Teste completo de integração
```bash
cd /home/fnascimento/fean-projects/docker-manager-vscode

# Testador completo (8 testes)
node test-complete.js

# Resultado esperado:
# ✅ 8/8 testes passando
# 🎉 TODOS OS TESTES PASSARAM COM SUCESSO!
```

---

## 📦 Compilação Manual (se necessário)

### Build completo
```bash
cd /home/fnascimento/fean-projects/docker-manager-vscode

# 1. Compilar bundle
npm run bundle

# 2. Gerar .vsix
vsce package

# 3. Resultado: vscode-docker-manager-0.1.0.vsix (181 KB)
```

### Build para produção
```bash
cd /home/fnascimento/fean-projects/docker-manager-vscode

# Executa: npm run vscode:prepublish
npm run vscode:prepublish

# Gera pacote final
vsce package
```

---

## 🔍 Verificação de Dependências

### Listar dependências instaladas
```bash
cd /home/fnascimento/fean-projects/docker-manager-vscode
npm ls --depth=0
```

### Verificar se dockerode está disponível
```bash
cd /home/fnascimento/fean-projects/docker-manager-vscode
node -e "console.log(require('dockerode'))"
# Resultado esperado: [Function: Docker]
```

### Verificar Docker disponível localmente
```bash
docker ps -a

# Resultado esperado (se tiver containers):
# CONTAINER ID   IMAGE        ...  NAMES
# c1e21755128c   mentoring    ...  mentoring_frontend
# 3489f8114670   mentoring    ...  mentoring_backend
# ... (etc)
```

---

## 📋 Comandos de Limpeza

### Remover arquivos de build
```bash
cd /home/fnascimento/fean-projects/docker-manager-vscode
rm -rf out/
npm run compile
```

### Remover .vsix antigo
```bash
cd /home/fnascimento/fean-projects/docker-manager-vscode
rm -f *.vsix
vsce package
```

### Limpar node_modules (último recurso)
```bash
cd /home/fnascimento/fean-projects/docker-manager-vscode
rm -rf node_modules
npm install
npm run bundle
```

---

## 🐛 Troubleshooting

### Se não conseguir instalar:
```bash
# Remover complementamente
code --uninstall-extension docker-manager.vscode-docker-manager

# Esperar 2 segundos
sleep 2

# Tentar novamente
code --install-extension /home/fnascimento/fean-projects/docker-manager-vscode/vscode-docker-manager-0.1.0.vsix
```

### Se não listar containers:
```bash
# 1. Verificar se Docker está rodando
docker ps -a

# 2. Verificar permissões
groups $USER

# Se não tiver 'docker':
sudo usermod -aG docker $USER
newgrp docker

# 3. Reabrir VS Code
```

### Se tiver erro de "Cannot find module":
```bash
# 1. Limpar e recompilar
cd /home/fnascimento/fean-projects/docker-manager-vscode
rm -rf out/
npm run bundle

# 2. Verificar bundle
grep -c "dockerode" out/extension.js
# Deve ser: 42 (não zero!)

# 3. Recriar .vsix
rm -f *.vsix
vsce package

# 4. Reinstalar
code --uninstall-extension docker-manager.vscode-docker-manager
sleep 2
code --install-extension vscode-docker-manager-0.1.0.vsix
```

---

## 📊 Verificação Pré-Instalação

Antes de instalar, validar que tudo está pronto:

```bash
cd /home/fnascimento/fean-projects/docker-manager-vscode

# ✅ 1. Verificar arquivo .vsix existe
ls -lh vscode-docker-manager-0.1.0.vsix

# ✅ 2. Verificar tamanho (deve estar entre 170-200 KB)
# Esperado: 181 KB

# ✅ 3. Verificar conteúdo do .vsix
unzip -l vscode-docker-manager-0.1.0.vsix | grep extension.js

# ✅ 4. Verificar dockerode no bundle
grep -c "dockerode" out/extension.js
# Esperado: 42

# ✅ 5. Verificar Docker disponível
docker --version

# ✅ 6. Verificar containers
docker ps -a

# Tudo ok? Prossiga com instalação ✅
```

---

## 📞 Suporte

Se precisar de ajuda:

1. **Verificar logs do VS Code:**
   ```
   Help → Show Runtime Status
   Help → Open Developer Tools
   Console → Procurar por "Docker Manager"
   ```

2. **Verificar logs da extensão:**
   ```
   VS Code → Debug Console
   Procurar por mensagens da extensão
   ```

3. **Arquivo de relatório:**
   - Consultar: `CORREÇÃO_RELATÓRIO.md`
   - Consultar: `MUDANÇAS_CÓDIGO.md`
   - Consultar: `CHECKLIST_FINAL.md`

---

**Status:** ✅ Tudo pronto para usar!  
**Versão:** 0.1.0  
**Data:** 23 de Abril de 2026

Qualquer dúvida, consulte os arquivos `.md` de documentação inclusos no projeto.
