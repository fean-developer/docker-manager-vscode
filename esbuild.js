// Script de build usando esbuild — empacota a extensão com todas as dependências
// em um único arquivo JS, tornando-a auto-contida para instalação.

const esbuild = require('esbuild');

const producao = process.argv.includes('--production');

esbuild.build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/extension.js',
    external: [
        'vscode',                           // vscode é fornecido pelo host
        '*.node',                           // Módulos nativos (não bundláveis)
        'cpu-features',                     // Depedência nativa (não usada com socket local)
        'ssh2',                             // Depedência nativa (não usada com socket local)
    ],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: !producao,
    minify: producao,
    logLevel: 'info',
}).catch(() => process.exit(1));
