// Script de build usando esbuild — empacota a extensão com todas as dependências
// em um único arquivo JS, tornando-a auto-contida para instalação.

const esbuild = require('esbuild');

const producao = process.argv.includes('--production');

esbuild.build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/extension.js',
    external: [
        'vscode',          // vscode é fornecido pelo host — não empacotar
        '*.node',          // módulos nativos binários — não empacotáveis
        'cpu-features',    // dep nativa do ssh2 (não usada com socket Unix)
        'ssh2',            // dep nativa do dockerode (não usada com socket Unix)
    ],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: !producao,
    minify: producao,
    logLevel: 'info',
}).catch(() => process.exit(1));
