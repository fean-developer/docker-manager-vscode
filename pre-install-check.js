#!/usr/bin/env node

/**
 * Validação Pré-Instalação
 * Verifica se tudo está pronto antes de usar a extensão
 */

const fs = require('fs');
const path = require('path');

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║          🔍 VALIDAÇÃO PRÉ-INSTALAÇÃO                      ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

let temErro = false;

// 1. Verificar arquivo .vsix
console.log('✓ Verificando arquivo .vsix...');
const vsixPath = path.join(__dirname, 'vscode-docker-manager-0.1.0.vsix');
if (fs.existsSync(vsixPath)) {
    const stat = fs.statSync(vsixPath);
    console.log(`  ✅ .vsix encontrado: ${(stat.size / 1024).toFixed(2)} KB\n`);
} else {
    console.log(`  ❌ .vsix NÃO encontrado!\n`);
    temErro = true;
}

// 2. Verificar bundle
console.log('✓ Verificando bundle...');
const bundlePath = path.join(__dirname, 'out', 'extension.js');
if (fs.existsSync(bundlePath)) {
    const content = fs.readFileSync(bundlePath, 'utf8');
    const dockerodeCount = (content.match(/dockerode/g) || []).length;
    console.log(`  ✅ Bundle encontrado: ${dockerodeCount} ocorrências de 'dockerode'\n`);
    if (dockerodeCount === 0) {
        console.log(`  ⚠️  Aviso: dockerode não encontrado no bundle!\n`);
        temErro = true;
    }
} else {
    console.log(`  ❌ Bundle NÃO encontrado!\n`);
    temErro = true;
}

// 3. Verificar Docker
console.log('✓ Verificando Docker...');
try {
    const Docker = require('dockerode');
    const docker = new Docker({ socketPath: '/var/run/docker.sock' });
    
    docker.ping().then(() => {
        console.log(`  ✅ Docker está acessível\n`);
        
        // 4. Testar listagem
        console.log('✓ Testando listagem...');
        Promise.all([
            docker.listContainers({ all: true }),
            docker.listImages(),
            docker.listVolumes(),
            docker.listNetworks(),
        ]).then(([containers, images, volumes, networks]) => {
            console.log(`  ✅ Containers: ${containers.length}`);
            console.log(`  ✅ Imagens: ${images.length}`);
            console.log(`  ✅ Volumes: ${volumes.Volumes.length}`);
            console.log(`  ✅ Networks: ${networks.length}\n`);
            
            // Resultado final
            if (temErro) {
                console.log('⚠️  ⚠️  ⚠️  AVISOS ENCONTRADOS ⚠️  ⚠️  ⚠️\n');
                process.exit(1);
            } else {
                console.log('╔════════════════════════════════════════════════════════════╗');
                console.log('║                ✅ TUDO PRONTO PARA USAR!                  ║');
                console.log('╚════════════════════════════════════════════════════════════╝\n');
                console.log('📋 Próximos passos:\n');
                console.log('1. Feche VS Code COMPLETAMENTE');
                console.log('2. Reabra VS Code');
                console.log('3. Abra a pasta do projeto');
                console.log('4. Clique no ícone Docker na sidebar');
                console.log('5. Você verá os containers, imagens, volumes e redes\n');
                process.exit(0);
            }
        }).catch(err => {
            console.log(`  ❌ Erro ao listar: ${err.message}\n`);
            process.exit(1);
        });
    }).catch(err => {
        console.log(`  ❌ Docker não está acessível: ${err.message}\n`);
        if (err.message.includes('EACCES')) {
            console.log('💡 Solução: Adicione seu usuário ao grupo docker:\n');
            console.log('   sudo usermod -aG docker $USER');
            console.log('   newgrp docker\n');
        }
        process.exit(1);
    });
} catch (err) {
    console.log(`  ❌ Erro ao conectar Docker: ${err.message}\n`);
    process.exit(1);
}

// Timeout
setTimeout(() => {
    console.error('❌ Teste expirou!\n');
    process.exit(1);
}, 30000);
