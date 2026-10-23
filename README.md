# USDC Pay-per-Request

An HTTP 402 paywall settled on Arc: agents pay per request in USDC, APIs verify on-chain.

Agents and scripts can't sign up for API plans or manage billing accounts. Here an API answers `402 Payment Required`
with a price and a requestId bound to the caller; the caller pays exactly that price in native USDC on Arc with
`pay(endpointId, requestId)`, retries with the transaction hash, and the API verifies the `Paid` event on-chain before it
answers. One on-chain receipt per request, no accounts and no API keys. The contract, its tests and the web app are being
built with Arc Studio; this repository will carry the Studio workspace, the deployments and the GitHub Pages build.

- `verifier/`: the 402 API server (Node >= 20, zero dependencies, no secrets) with its tests.
- `examples/agent_client.py`: a standalone paying client.
- `spec-tests/`: our independent Foundry suite for the specification (unit, fuzz and a stateful invariant suite).
- [SECURITY.md](SECURITY.md): guarantees and known limitations.

By Swift Bot Labs. MIT licensed.
