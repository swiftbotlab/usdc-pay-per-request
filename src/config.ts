/**
 * wagmi configuration for UsdcPayPerRequest
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi';
import { mainnet } from 'wagmi/chains';
import { arcTestnet } from 'viem/chains';
import { injected } from 'wagmi/connectors';
import { arcMainnet } from './config/networks';

export const config = createConfig({
  chains: [arcMainnet, arcTestnet, mainnet],
  connectors: [injected()],
  transports: {
    [arcMainnet.id]: http('https://rpc.mainnet.arc.io'),
    [arcTestnet.id]: http('https://rpc.testnet.arc.io'),
    [mainnet.id]: http(),
  },
});
