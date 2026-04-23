import * as assert from 'assert';
import * as sinon from 'sinon';
import { DockerClient, DockerConnectionError, interpretarErrodocker } from '../docker/dockerClient';

/**
 * Testes unitários para o DockerClient.
 * Usa stubs para não depender de um Docker real.
 */
suite('DockerClient', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        // Reset singleton para cada teste
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (DockerClient as any).instance = null;
    });

    teardown(() => {
        sandbox.restore();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (DockerClient as any).instance = null;
    });

    test('retorna a mesma instância (singleton)', () => {
        const a = DockerClient.getInstance();
        const b = DockerClient.getInstance();
        assert.strictEqual(a, b);
    });

    test('verificarConexao: lança DockerConnectionError quando ping falha', async () => {
        const client = DockerClient.getInstance();
        const dockerode = client.getDockerode();
        sandbox.stub(dockerode, 'ping').rejects(new Error('connect ECONNREFUSED'));

        await assert.rejects(
            () => client.verificarConexao(),
            (err: Error) => {
                assert.ok(err instanceof DockerConnectionError);
                assert.ok(err.message.includes('Conexão recusada'));
                return true;
            },
        );
    });

    test('verificarConexao: não lança erro quando ping tem sucesso', async () => {
        const client = DockerClient.getInstance();
        const dockerode = client.getDockerode();
        sandbox.stub(dockerode, 'ping').resolves(Buffer.from('OK'));

        await assert.doesNotReject(() => client.verificarConexao());
    });
});

/**
 * Testes unitários para interpretarErrodocker.
 */
suite('interpretarErrodocker', () => {
    test('detecta ENOENT como socket não encontrado', () => {
        const err = new Error('ENOENT: no such file or directory /var/run/docker.sock');
        const msg = interpretarErrodocker(err);
        assert.ok(msg.includes('Socket do Docker não encontrado'));
    });

    test('detecta EACCES como erro de permissão', () => {
        const err = new Error('EACCES: permission denied');
        const msg = interpretarErrodocker(err);
        assert.ok(msg.includes('Sem permissão'));
    });

    test('detecta ECONNREFUSED como daemon não em execução', () => {
        const err = new Error('connect ECONNREFUSED /var/run/docker.sock');
        const msg = interpretarErrodocker(err);
        assert.ok(msg.includes('Conexão recusada'));
    });

    test('retorna mensagem genérica para erros desconhecidos', () => {
        const msg = interpretarErrodocker('erro qualquer');
        assert.ok(msg.includes('Erro desconhecido'));
    });
});
