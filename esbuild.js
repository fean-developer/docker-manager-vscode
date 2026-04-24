// Script de build usando esbuild — empacota a extensão com todas as dependências
// em um único arquivo JS, tornando-a auto-contida para instalação.

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const producao = process.argv.includes('--production');

// Plugin para interceptar módulos nativos e marcá-los como externos
const nativeModulePlugin = {
    name: 'native-modules',
    setup(build) {
        build.onResolve({ filter: /\.node$/ }, args => ({
            path: args.path,
            external: true,
        }));

        // Também marca como external módulos que só existem para features opcionais
        build.onResolve({ filter: /^(ssh2|cpu-features)$/ }, args => ({
            path: args.path,
            external: true,
        }));
    },
};

esbuild.build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/extension.js',
    external: [
        'vscode',          // vscode é fornecido pelo host — não empacotar
    ],
    plugins: [nativeModulePlugin],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: !producao,
    minify: producao,
    logLevel: 'info',
}).catch(() => process.exit(1));
