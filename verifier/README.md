# verifier: a real HTTP 402 API server for USDC Pay-per-Request

`server.mjs` is a minimal provider API ("current weather for a city", sample data) behind an `arc-paywall/v1` paywall.
Node >= 20, **zero dependencies** (its keccak-256 is in `lib/keccak.mjs`, checked against eth_utils vectors), **no secrets**:
it only reads the chain and never signs anything.

```
PAYWALL_NETWORK=mainnet PAYWALL_CONTRACT=0x... PAYWALL_ENDPOINT_ID=1 node server.mjs      # listens on 127.0.0.1:8402
curl -i "http://127.0.0.1:8402/v1/weather?city=Paris" -H "X-Payer: 0xYourAddress"       # -> 402 + PAYMENT-REQUIRED (X-Payer required)
# pay(endpointId, requestId) on Arc with value = amount (any wallet or the agent client in ops/agent_client.py), then:
curl "http://127.0.0.1:8402/v1/weather?city=Paris" -H "X-Payer: 0xYourAddress" \
     -H "X-Paywall-Token: <token from the 402>" -H "X-Paywall-Tx: <pay tx hash>"          # -> 200 + X-Paywall-Receipt
```
Options: `PORT`, `HOST`, `PAYWALL_MIN_CONFIRMATIONS` (1), `PAYWALL_SERVE_WINDOW` (3600 s), `PAYWALL_MAX_SERVES` (3),
`PAYWALL_TRUST_PROXY=N` behind N reverse proxies of your own (client IP = Nth X-Forwarded-For entry from the right),
`PAYWALL_EXPECT_PAYEE=0x...` (refuse to start or serve if the endpoint pays anyone else), `PAYWALL_ALLOW_UNBOUND=1` (also
quote clients without `X-Payer`; their requestIds can be front-run), `PAYWALL_TOKEN_KEY=<64 hex>` (optional server key:
tokens become nonce + HMAC so clients cannot grind them; recommended for calls priced above a few USDC).
`local` network (an anvil) needs `PAYWALL_RPC=http://127.0.0.1:<port>`.

What it checks before answering: the receipt succeeded; exactly one `Paid` event emitted by the contract for this
endpointId and this requestId; the payer is the one bound in the requestId; enough confirmations; `getPayment(requestId)`
agrees with the event, is not refunded and is recent. The requestId is recomputed from the retry (payer, token, method +
path + query), so the server keeps no challenge table, and a payment for one resource cannot unlock another.
Hardening: Arc RPC hosts only (https), 8 s timeout, 1 MB cap, no redirects, RPC error text only in the log; GET/OPTIONS
only; 8 KB headers; 512 connections; strict input validation before any chain call; `X-Payer` required by default;
per-IP limits (IPv6 per /64, oldest-key eviction) plus a global verification cap; one shared price read per second; the
serve count checked before any chain read; the token is never logged. Put it behind TLS in production.

Tests: `node --test test/verifier.test.mjs` (34 tests, fake chain, no network). Positive control:
`python3 -I test/mutation_check.py` removes one check at a time (22 mutants) and requires the suite to fail.
A paying client: `examples/agent_client.py` in this repo (Python, eth-account).
