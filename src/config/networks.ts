/**
 * Network configuration for UsdcPayPerRequest.
 * Both Arc Mainnet and Arc Testnet addresses are set; default is mainnet.
 */

import { arcTestnet, type Chain } from 'viem/chains';
import { defineChain } from 'viem';

export const arcMainnet: Chain = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.arc.io'] },
    public:  { http: ['https://rpc.mainnet.arc.io'] },
  },
  blockExplorers: {
    default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' },
  },
});

export type NetworkKey = 'mainnet' | 'testnet';

export interface NetworkConfig {
  chain: Chain;
  address: `0x${string}`;
  deploymentBlock: bigint;
  demoEndpointId: bigint;
  explorer: string;
  rpc: string;
}

export const NETWORKS: Record<NetworkKey, NetworkConfig> = {
  mainnet: {
    chain: arcMainnet,
    address: '0xe741f95adfa3d68bdb8368734b01ca4575a36119',
    deploymentBlock: 27403258n,
    demoEndpointId: 1n,
    explorer: 'https://explorer.arc.io',
    rpc: 'https://rpc.mainnet.arc.io',
  },
  testnet: {
    chain: arcTestnet,
    address: '0x830f1801b91f1de0c228cf37ebfc0c211edff991',
    deploymentBlock: 68638110n,
    demoEndpointId: 1n,
    explorer: 'https://explorer.testnet.arc.io',
    rpc: 'https://rpc.testnet.arc.io',
  },
};

export const DEFAULT_NETWORK: NetworkKey = 'mainnet';

export function getNetwork(key: string): NetworkKey {
  return key === 'testnet' ? 'testnet' : 'mainnet';
}

export function networkLabel(key: NetworkKey): string {
  return key === 'mainnet' ? 'Arc Mainnet' : 'Arc Testnet';
}
