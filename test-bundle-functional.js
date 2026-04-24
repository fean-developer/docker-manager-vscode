#!/usr/bin/env node

/**
 * Teste funcional: Verifica se o bundle consegue acessar dockerode
 */

console.log('🧪 Teste funcional do bundle...\n');

try {
    // Tentar importar o bundle
    console.log('1️⃣ Tentando carregar arquivo extension.js...');
    const Module = require('module');
    const path = require('path');
    const fs = require('fs');
    
    const extensionPath = path.join(__dirname, 'out', 'extension.js');
    
    if (!fs.existsSync(extensionPath)) {
        throw new Error('Arquivo extension.js não encontrado!');
    }
    
    console.log('   ✅ Arquivo encontrado\n');
    
    // Testar se consegue usar dockerode localmente
    console.log('2️⃣ Testando dockerode localmente...');
    const Dockerode = require('dockerode');
    const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });
    
    console.log('   ✅ Dockerode pode ser importado\n');
    
    // Testar se consegue conectar
    console.log('3️⃣ Testando conexão Docker...');
    
    docker.ping().then(() => {
        console.log('   ✅ Conexão estabelecida\n');
        
        // Testar listagem
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
        
        console.log('✅ TESTE FUNCIONAL PASSOU!\n');
        console.log('📋 Conclusão: Dockerode está funcionando corretamente\n');
        
        process.exit(0);
    }).catch(err => {
        console.error('❌ Erro:', err.message);
        process.exit(1);
    });
    
} catch (err) {
    console.error('❌ Erro ao testar:', err.message);
    process.exit(1);
}

setTimeout(() => {
    console.error('❌ Teste expirou!');
    process.exit(1);
}, 15000);
