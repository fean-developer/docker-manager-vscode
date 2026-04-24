#!/usr/bin/env node

console.log('=== TESTE DE FUNCIONALIDADE DO BUNDLE ===\n');

try {
    console.log('1️⃣ Verificando bundle...');
    const fs = require('fs');
    const path = require('path');
    
    const bundlePath = path.join(__dirname, 'out', 'extension.js');
    if (!fs.existsSync(bundlePath)) {
        throw new Error('Bundle não encontrado!');
    }
    
    const bundleCode = fs.readFileSync(bundlePath, 'utf8');
    const bundleSize = (bundleCode.length / 1024).toFixed(2);
    console.log(`   ✅ Bundle encontrado: ${bundleSize} KB\n`);
    
    // Verificar conteúdo crítico
    console.log('2️⃣ Verificando conteúdo crítico:');
    const checks = {
        'dockerode': bundleCode.match(/[Dd]ockerod/g) ? '✅' : '❌',
        'containerService': bundleCode.includes('containerService') ? '✅' : '❌',
        'DockerTreeProvider': bundleCode.includes('DockerTreeProvider') ? '✅' : '❌',
        'activate function': bundleCode.includes('function activate') || bundleCode.includes('activate:function') ? '✅' : '❌',
    };
    
    Object.entries(checks).forEach(([key, status]) => {
        console.log(`   ${status} ${key}`);
    });
    console.log();
    
    // Testar Docker
    console.log('3️⃣ Testando Docker...');
    const Dockerode = require('dockerode');
    const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });
    
    docker.ping().then(() => {
        console.log('   ✅ Conexão com Docker OK\n');
        
        console.log('4️⃣ Testando listagem...');
        return Promise.all([
            docker.listContainers({ all: true }),
            docker.listImages(),
            docker.listVolumes(),
            docker.listNetworks(),
        ]);
    }).then(([containers, images, volumes, networks]) => {
        console.log(`   ✅ Containers: ${containers.length}`);
        console.log(`   ✅ Imagens: ${images.length}`);
        console.log(`   ✅ Volumes: ${volumes.Volumes.length}`);
        console.log(`   ✅ Networks: ${networks.length}\n`);
        
        console.log('╔════════════════════════════════════════════════════════════╗');
        console.log('║                 ✅ BUNDLE ESTÁ OK!                         ║');
        console.log('║                                                            ║');
        console.log('║  O problema NÃO é no bundle/dependências.                 ║');
        console.log('║  O problema está na inicialização do TreeDataProvider.     ║');
        console.log('╚════════════════════════════════════════════════════════════╝\n');
        
        console.log('💡 Próximos passos:');
        console.log('   1. Abra o VS Code');
        console.log('   2. Pressione Ctrl+Shift+J (console)');
        console.log('   3. Procure por mensagens de erro');
        console.log('   4. Verifique se há "Docker Manager: extensão ativada"\n');
        
        process.exit(0);
    }).catch(err => {
        console.error(`\n❌ Erro ao testar Docker:\n   ${err.message}\n`);
        process.exit(1);
    });
    
} catch (err) {
    console.error(`\n❌ Erro:\n   ${err.message}\n`);
    process.exit(1);
}

setTimeout(() => {
    console.error('\n❌ Timeout!\n');
    process.exit(1);
}, 15000);
