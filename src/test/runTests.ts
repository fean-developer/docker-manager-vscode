import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const Mocha = require('mocha') as typeof import('mocha');
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const glob = require('glob') as typeof import('glob');

/**
 * Runner dos testes unitários usando Mocha.
 */
export function run(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mocha = new (Mocha as any)({
        ui: 'tdd',
        color: true,
        timeout: 10_000,
    });

    const testsRoot = path.resolve(__dirname, '.');

    return new Promise((resolve, reject) => {
        const files = glob.sync('**/*.test.js', { cwd: testsRoot });

        for (const f of files) {
            mocha.addFile(path.resolve(testsRoot, f));
        }

        try {
            mocha.run((failures: number) => {
                if (failures > 0) {
                    reject(new Error(`${failures} teste(s) falharam.`));
                } else {
                    resolve();
                }
            });
        } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
        }
    });
}
