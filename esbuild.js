// Script de build usando esbuild — empacota a extensão com todas as dependências
// em um único arquivo JS, tornando-a auto-contida para instalação.

const esbuild = require('esbuild');
const path = require('path');

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
        'nan',                              // Módulo nativo para extensões C++
        'agent-base',                       // Não necessário para socket local
        'http-proxy-agent',                 // Não necessário para socket local
        'https-proxy-agent',                // Não necessário para socket local
        'socks-proxy-agent',                // Não necessário para socket local
    ],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    tsconfigRaw: {
        compilerOptions: {
            module: 'commonjs',
            moduleResolution: 'node',
            target: 'ES2020',
        },
    },
    sourcemap: !producao,
    minify: false,  // Desabilitar minify para evitar erros de compilação
    logLevel: 'info',
    plugins: [
        {
            name: 'handle-optional-deps',
            setup(build) {
                build.onResolve({ filter: /^(ssh2|agent-base|.*-proxy-agent|nan)$/ }, args => {
                    return { path: args.path, namespace: 'optional' };
                });
                build.onLoad({ filter: /.*/, namespace: 'optional' }, () => {
                    return {
                        contents: 'module.exports = {};',
                        loader: 'js',
                    };
                });
            },
        },
    ],
}).catch(() => process.exit(1));
