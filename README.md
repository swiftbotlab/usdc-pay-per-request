# USDC Pay-per-Request

An HTTP 402 paywall settled on Arc: agents pay per request in USDC, APIs verify on-chain.

Built with [Arc Studio](https://studio.arc.io)

## What it does

Providers register API endpoints with a price. Clients (AI agents, backends) pay for one request at a time by calling `pay(endpointId, requestId)` with the exact price as native USDC (`msg.value`, 18 decimals). The API server verifies the on-chain `Paid` event before serving the response — no accounts, no API keys.

## The 402 flow

```
1. Agent: GET /v1/weather?city=Paris  (X-Payer: <agent address>)
2. Server: 402 with endpointId, price, payTo (contract), requestId, token
3. Agent: pay(endpointId, requestId)  with value = price
4. Agent: retry with X-Payer, X-Paywall-Token, X-Paywall-Tx
5. Server: checks receipt, Paid event, getPayment() → 200
```

**Retry headers:**
```
X-Payer:         <your address>
X-Paywall-Token: <token from 402>
X-Paywall-Tx:    <pay() tx hash>
```

## requestId derivation and binding

```
digest    = keccak256(abi.encode(DOMAIN, chainId, contract, endpointId,
                                 payer, keccak256(resource), token))
requestId = payer[0..20] || digest[20..32]
```

The top 20 bytes of the requestId are the bound payer address. Only that address can pay it on-chain — a front-runner cannot pay or burn yours. A zero prefix means anyone may pay (unbound).

**Unit check** (verified in `src/lib/paywall.ts` at module load):
- payer `0x2222…2222`, chainId `5042`, contract `0x1111…1111`, endpointId `1`, resource `GET /v1/weather?city=Paris`, token `0x3333…3333`
- → requestId `0x2222…222291fd801985e2bd8a9a5903dd`

## pay() check order

1. `UnknownEndpoint` — id 0 or > endpointCount
2. `EndpointInactive` — provider paused
3. `ZeroRequestId` — requestId is zero
4. `RequestNotForPayer` — bound to a different address
5. `AlreadyPaid` — ever paid (including refunded)
6. `WrongAmount` — msg.value ≠ endpoint price

## Pull payouts and refunds

- Payments credit the **payee** (not pushed) — `credit[payee] += price`
- Only the **provider** can refund, once, as long as the payee has enough unwithdrawn credit
- Refund returns the original paid amount (not the current price)
- `withdraw(to, amount)` pulls from the caller's own credit to any address

## Deployments

| Network | Address | Explorer |
|---------|---------|----------|
| Arc Mainnet | `0xe741f95adfa3d68bdb8368734b01ca4575a36119` | [explorer.arc.io](https://explorer.arc.io/address/0xe741f95adfa3d68bdb8368734b01ca4575a36119) |
| Arc Testnet | `0x830f1801b91f1de0c228cf37ebfc0c211edff991` | [explorer.testnet.arc.io](https://explorer.testnet.arc.io/address/0x830f1801b91f1de0c228cf37ebfc0c211edff991) |

Both deployments are byte-identical. No constructor args, no owner, no admin.

## Demo

**Replay panel.** Before connecting a wallet (or before step 3), the page fetches the scripted run that was recorded on endpoint #1 at deployment time — `Paid`, `Refunded`, `PriceChanged`, and `ActiveSet` events from blocks `deploymentBlock` to `deploymentBlock + 8999` in a single `getLogs` window per event type. Events are listed in block order with requestId links, payer, amount, and a Refunded badge. Below the table: `getEndpoint` totals and payee credit.

**Interactive steps.**
1. Connect wallet.
2. Generate a throwaway browser agent key (stored in `localStorage`).
3. Fund it (your wallet sends native USDC) and register a demo endpoint.
4. Run the agent for Paris, Tokyo, Lima. Before paying, the agent: checks `payerOf(requestId)` on-chain, calls `canPay(endpointId, requestId, agent, price)`, rejects prices above 0.05 USDC. Live logs show three voices: AGENT, API, CONTRACT, with the real measured 402 latency.
5. **Cheat panel** — four interactive rows:
   - Reuse Paris token for Rome → API returns `no_matching_payment`.
   - `canPay` on the Paris requestId again → `AlreadyPaid`.
   - `canPay` with the connected wallet as payer on a fresh agent-bound requestId → `RequestNotForPayer`.
   - "Send duplicate on-chain" — agent wallet sends `pay(endpointId, ParisRequestId)` with explicit `gas: 120000`, waits for receipt, shows "Failed on-chain: AlreadyPaid" with explorer link.
6. **Step 6:** Refund Tokyo (connected wallet = payee), withdraw accumulated credit, sweep agent key balance back to wallet. Accounting shows endpoint-scoped totals (paid count, total paid, refund count, total refunded, wallet credit, agent native balance).

## Hosting

GitHub Pages: https://swiftbotlab.github.io/usdc-pay-per-request/ . The Arc Studio workspace export does not include
`dist/`, so `.github/workflows/pages.yml` runs the same Vite build in GitHub Actions on every push to `main` (bun,
frozen lockfile, `vite build --base=./`). GitHub Pages cannot send response headers: production builds carry a CSP
meta tag and the app refuses to render inside foreign frames (except the Arc Studio preview).

## Tech stack

- React 18, Vite, TypeScript, Tailwind CSS
- wagmi v2, viem, ConnectKit (injected wallet)
- Chain: Arc Mainnet (default, chain ID 5042) and Arc Testnet (5042002)
- Contract: Solidity 0.8.28, OpenZeppelin ReentrancyGuard, Foundry

## Development

### Prerequisites

- Node.js 18+ or Bun
- Foundry (for contract work)

### Environment variables

None required for the frontend. The app connects directly to Arc's public RPC endpoints.

| Variable | Purpose |
|----------|---------|
| `RPC_PROXY_BASE_URL` | Optional: Arc Studio RPC proxy base URL (Arc Studio only) |
| `RPC_PROXY_TOKEN`   | Optional: Arc Studio RPC proxy token (Arc Studio only) |
| `RPC_PROXY_CHAINS`  | Optional: comma-separated chain keys (Arc Studio only) |

### Install and run

```bash
bun install
bun run dev
```

### Build

```bash
bun run build
# outputs to dist/ with relative asset URLs (base: './')
```

### Test contracts

```bash
bun run contracts:test
```

## Run the verifier

```bash
PAYWALL_NETWORK=mainnet \
PAYWALL_CONTRACT=0xe741f95adfa3d68bdb8368734b01ca4575a36119 \
PAYWALL_ENDPOINT_ID=1 \
node verifier/server.mjs
```

## Limitations

- On-chain receipts cost ~0.002 USDC of gas per request; high-frequency micropayments fit a payment channel better
- The payee address is fixed when the endpoint is registered (to change it, register a new endpoint)
- Refunds require the payee to have sufficient unwithdrawn credit
- The demo agent key lives in localStorage — suitable for demos only
- The in-page API is a browser simulation; run `verifier/server.mjs` for a real server
- Arc's native gas token is USDC (18 decimals via `msg.value`) — distinct from the 6-decimal ERC-20 view

## Live on Arc mainnet (scripted run with fresh keys, endpoint #1)

Every paid request below went through `verifier/server.mjs` (402 -> `pay` -> retry -> 200). Paid 0.04 USDC = refunded
0.01 + withdrawn 0.03; contract balance == `totalCredits` == 0 at the end.

- Deploy (by us, bytecode byte-identical to Arc Studio's testnet deployment): [0x2f228123...](https://explorer.arc.io/tx/0x2f2281237d492131c2fba3e1d78d41c4a608c49c25cabf0f452b88543b1704d4)
- Provider registers "GET /v1/weather (demo)" at 0.01 USDC: [0x35dca76e...](https://explorer.arc.io/tx/0x35dca76efe2319ceb701490d18c44bced3892ca801a5ebdd0316b463d9ee3a20)
- Agent buys Paris (402 -> pay -> verified -> data): [0x1176a091...](https://explorer.arc.io/tx/0x1176a0915afaef55f9cae0d6ff362e11f621b27cf26a8c51803f3b667bb4b6d2)
- Agent buys Tokyo: [0xeb3a0450...](https://explorer.arc.io/tx/0xeb3a0450c2f5b39836a5221f8194f44b589ce7f80d8c74b761b6f9829f3aa898)
- Agent re-sends the Paris payment: FAILED on-chain with `AlreadyPaid` (only gas spent): [0xde92f845...](https://explorer.arc.io/tx/0xde92f84541d53f700e6490071fccdaf4d68a280cdc01ec560fd35ed4ae075e6f)
- Provider raises the price to 0.02 (a stale 0.01 quote is refused with `WrongAmount`): [0x500997b2...](https://explorer.arc.io/tx/0x500997b295069f2aa32e78ec817928e4553c33546573209b73387feabbcd90af)
- Agent buys Lima at 0.02: [0x95fa7685...](https://explorer.arc.io/tx/0x95fa7685e35431d6758b58ee3728d821099f373de3fba00535c607a534afe6f9)
- Provider refunds Tokyo (the verifier then answers `402 payment_refunded`): [0x39497ebc...](https://explorer.arc.io/tx/0x39497ebc2c9083c65dff1391a026c2c11ad2711440fca443009a3e9c8b46c7d4)
- Provider pauses (pay -> `EndpointInactive`, verifier 503) and resumes: [0xf306d84d...](https://explorer.arc.io/tx/0xf306d84d0149bbfaf329b04ed9ba4243983c83c80d131794f90b97803da66d38), [0x0858e9da...](https://explorer.arc.io/tx/0x0858e9da4d0775183661514ae5c66b10c10306478fa7c612fa46db5aa24922d0)
- Provider withdraws 0.03: [0x5aa645a9...](https://explorer.arc.io/tx/0x5aa645a93a977fb875db5488c151531b5472b83e5d44ce30d106ca45afe992a2)
- One more request from a terminal (our paying client, same checks as `examples/agent_client.py`, against `verifier/server.mjs`, Reykjavik at 0.02; pay -> receipt 0.3 s, verified 200 after 546 ms; the same tx + token replayed for Rome -> `402 no_matching_payment`): [0xde6e82a6...](https://explorer.arc.io/tx/0xde6e82a6e600c209400ec24335f048b95341b918947864139af5250cbad396d0)

Measured on mainnet: pay -> receipt 0.34-1.03 s, server-side verification 0.67-0.85 s.

## How this repository was built

- `contracts/`, `src/`, `public/`, `scripts/` and the configs come unchanged from the Arc Studio workspace (session
  "paywall"): Studio's smart-contract pipeline wrote `UsdcPayPerRequest.sol` from our specification, ran its auditors and
  Slither, wrote the Foundry suite (83 tests including an invariant suite: 5 invariants, 256 runs, 128,000 handler calls)
  and deployed to Arc Testnet; Studio's app build wrote the web app.
- We compiled Studio's contract in a sandbox, ran Studio's suite and our independent suite (`spec-tests/`: 38 unit/fuzz
  tests and a model-based invariant suite that predicts the exact revert data of every call) against it, ran the whole
  demo on Arc Testnet, then deployed the byte-identical bytecode to Arc mainnet.
- `verifier/` (the 402 API server: Node >= 20, zero dependencies, no secrets, 34 tests) and `examples/agent_client.py` (a
  standalone paying client) are ours.
- One hand fix (disclosed): the first production build crashed because its CSP (`style-src 'self'`) blocked the styles
  ConnectKit injects; we patched `vite.config.ts` by hand (commit 3e1fdf1) and Studio's next turn made the identical change.
- Hand fix 2 (disclosed, 2 lines in `src/pages/DemoPage.tsx`): the demo replay asked for logs up to `deploymentBlock + 8999`,
  which the Arc RPC rejects while that block is still in the future; the window now ends at the current head.
- Hand fix 3 (disclosed, 4 lines in `src/pages/DemoPage.tsx`): the demo re-read the registered endpoint and the agent's
  balance when the transaction hash came back instead of after the receipt, so step 3 stayed open; it now re-reads after the receipt.
  Studio's next turn kept hand fixes 2 and 3 (we uploaded that file) and fixed the in-page API's Paid-event check and the
  canPay reason labels that our live mainnet run exposed.
- GitHub Pages: `.github/workflows/pages.yml` runs the same Vite build Studio ran (bun, frozen lockfile), because the
  Studio workspace export does not include `dist/`.

By Swift Bot Labs. MIT licensed.
