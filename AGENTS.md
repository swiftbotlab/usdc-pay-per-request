# [App Name]

> Built with Arc Studio - money-powered apps in minutes

This is the **project memory** - what Arc Studio remembers about building this app. It helps future agents (or humans) understand and extend the project.

---

## What This App Does

HTTP-402 paywall settled on Arc. Providers register priced API endpoints; clients (AI agents, backends) pay per request with `pay(endpointId, requestId)` sending Arc native USDC (18-decimal `msg.value`). API servers verify the `Paid` event or `getPayment(requestId)` before serving the response.

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`. Build with `bun run contracts:build` (`forge build`), test with `bun run contracts:test` (`forge test`).
- Wallet: injected (MetaMask, etc.)
- Chain: Arc Testnet (Chain ID: 5042002, imported from `viem/chains`)
- Token: USDC (6 decimals) (Address: 0x3600000000000000000000000000000000000000, Chain: Arc Testnet)
- Toasts: Sonner

## Deployed Contracts

### UsdcPayPerRequest (Arc Testnet)
- Address: `0x830f1801b91f1de0c228cf37ebfc0c211edff991`
- Deploy tx: `0xbb7bc8e8547f07ec55e1e08e1897ba6d63fdd2481259cea1f1ca2c56929ac28f`
- Explorer: https://explorer.testnet.arc.io/address/0x830f1801b91f1de0c228cf37ebfc0c211edff991
- ABI: `contracts/contract-metadata/UsdcPayPerRequest.json`
- Source: `contracts/UsdcPayPerRequest.sol`
- Constructor args: none
- Note: pays in Arc native USDC (18-decimal `msg.value`), not the 6-decimal ERC-20 view

## Key Files

- `src/App.tsx` - Main application logic
- `src/components/` - UI components
- `src/config.ts` - wagmi config (chains, connectors, transports)
- `contracts/UsdcPayPerRequest.sol` - HTTP-402 paywall contract
- `contracts/test/UsdcPayPerRequest*.t.sol` - Foundry unit + fuzz + invariant tests
- `contracts/test-helpers/PaywallHelpers.sol` - Re-entrant/rejecting test helpers

## To Run

```bash
bun install
bun run dev
```
