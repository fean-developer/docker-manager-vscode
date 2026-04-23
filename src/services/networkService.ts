import Dockerode from 'dockerode';
import { DockerClient, interpretarErrodocker } from '../docker/dockerClient';

/**
 * Representação tipada de uma rede Docker.
 */
export interface NetworkInfo {
    id: string;
    idCurto: string;
    nome: string;
    driver: string;
    escopo: string;
    interno: boolean;
    ipam: IpamInfo;
    criada: Date;
    containersConectados: number;
}

export interface IpamInfo {
    driver: string;
    subnet?: string;
    gateway?: string;
}

/**
 * Serviço responsável por operações de redes Docker.
 */
export class NetworkService {
    private readonly docker: Dockerode;

    constructor() {
        this.docker = DockerClient.getInstance().getDockerode();
    }

    /**
     * Lista todas as redes Docker locais.
     */
    public async listar(): Promise<NetworkInfo[]> {
        try {
            const redes = await this.docker.listNetworks();
            return redes.map(r => this.mapearNetworkInfo(r));
        } catch (err) {
            throw new Error(interpretarErrodocker(err));
        }
    }

    /**
     * Inspeciona uma rede e retorna dados detalhados.
     */
    public async inspecionar(id: string): Promise<Dockerode.NetworkInspectInfo> {
        try {
            const rede = this.docker.getNetwork(id);
            return await rede.inspect();
        } catch (err) {
            throw new Error(`Erro ao inspecionar rede: ${interpretarErrodocker(err)}`);
        }
    }

    private mapearNetworkInfo(r: Dockerode.NetworkInspectInfo): NetworkInfo {
        const config = r.IPAM?.Config?.[0];
        const containers = r.Containers ? Object.keys(r.Containers).length : 0;
        const idCurto = (r.Id ?? '').substring(0, 12);

        return {
            id: r.Id ?? '',
            idCurto,
            nome: r.Name ?? '',
            driver: r.Driver ?? '',
            escopo: r.Scope ?? '',
            interno: r.Internal ?? false,
            ipam: {
                driver: r.IPAM?.Driver ?? '',
                subnet: config?.Subnet,
                gateway: config?.Gateway,
            },
            criada: r.Created ? new Date(r.Created) : new Date(0),
            containersConectados: containers,
        };
    }
}
