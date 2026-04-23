import * as assert from 'assert';
import * as sinon from 'sinon';
import Dockerode from 'dockerode';
import { ContainerService } from '../services/containerService';
import { DockerClient } from '../docker/dockerClient';

/**
 * Testes unitários para o ContainerService.
 */
suite('ContainerService', () => {
    let sandbox: sinon.SinonSandbox;
    let dockerode: Dockerode;
    let svc: ContainerService;

    setup(() => {
        sandbox = sinon.createSandbox();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (DockerClient as any).instance = null;
        dockerode = DockerClient.getInstance().getDockerode();
        svc = new ContainerService();
    });

    teardown(() => {
        sandbox.restore();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (DockerClient as any).instance = null;
    });

    test('listar: retorna lista formatada de containers', async () => {
        const containerFake: Partial<Dockerode.ContainerInfo> = {
            Id: 'abc123def456789',
            Names: ['/meu-container'],
            Image: 'nginx:latest',
            Status: 'Up 2 hours',
            State: 'running',
            Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: 'tcp', IP: '0.0.0.0' }],
            Created: Math.floor(Date.now() / 1000),
            Mounts: [],
        };

        sandbox.stub(dockerode, 'listContainers').resolves([containerFake as Dockerode.ContainerInfo]);

        const resultado = await svc.listar();

        assert.strictEqual(resultado.length, 1);
        assert.strictEqual(resultado[0].nome, 'meu-container');
        assert.strictEqual(resultado[0].imagem, 'nginx:latest');
        assert.strictEqual(resultado[0].estado, 'running');
        assert.strictEqual(resultado[0].portas[0].portaPublica, 8080);
    });

    test('listar: lança erro com mensagem legível quando dockerode falha', async () => {
        sandbox.stub(dockerode, 'listContainers').rejects(new Error('ECONNREFUSED'));

        await assert.rejects(
            () => svc.listar(),
            (err: Error) => {
                assert.ok(err.message.includes('Conexão recusada'));
                return true;
            },
        );
    });

    test('iniciar: chama container.start com o ID correto', async () => {
        const startStub = sandbox.stub().resolves();
        sandbox.stub(dockerode, 'getContainer').returns({
            start: startStub,
        } as unknown as Dockerode.Container);

        await svc.iniciar('abc123');
        assert.ok(startStub.calledOnce);
    });

    test('parar: chama container.stop com o ID correto', async () => {
        const stopStub = sandbox.stub().resolves();
        sandbox.stub(dockerode, 'getContainer').returns({
            stop: stopStub,
        } as unknown as Dockerode.Container);

        await svc.parar('abc123');
        assert.ok(stopStub.calledOnce);
    });

    test('remover: lança erro descritivo quando container não existe', async () => {
        sandbox.stub(dockerode, 'getContainer').returns({
            remove: sandbox.stub().rejects(new Error('no such container')),
        } as unknown as Dockerode.Container);

        await assert.rejects(
            () => svc.remover('invalido'),
            (err: Error) => {
                assert.ok(err.message.includes('Erro ao remover container'));
                return true;
            },
        );
    });
});
