# Security

USDC Pay-per-Request is a single Solidity contract (`contracts/UsdcPayPerRequest.sol`), a static web app and a small
verifier server (`verifier/`). Report problems through a GitHub issue on this repository (for anything that could put funds
at risk, open an issue that only says "security contact please" and we will reach out).

## What the contract guarantees
- No admin, no owner, no fees, no upgrades, no `receive()`/`fallback()`: USDC only enters through `pay` and only leaves
  through `withdraw` (a payee's own credit, to an address it chooses) and `refund` (back to the payer, by the endpoint's provider).
- `pay` checks, in order: the endpoint exists, is active, the requestId is non-zero, the requestId is bound to the caller
  (or unbound), it was never paid before (globally, forever), and `msg.value` equals the price exactly. `canPay` runs the
  same checks for free.
- A requestId whose top 20 bytes are an address can only be paid by that address, so a front-runner cannot pay or burn it.
  (Unbound requestIds, with a zero prefix, can be burnt by a front-runner for the cost of gas; the verifier therefore
  requires `X-Payer` unless its operator opts in.)
- Payee consent: an endpoint can only name a payee that is its provider or has approved that provider
  (`approveProvider`), so nobody can attach a stranger's address and later refund out of the stranger's credit.
- Pull payouts: a payment only credits the payee; no external call happens in `pay`, so a payee cannot block or re-enter it.
- Price changes apply to new payments only; each payment records the amount paid, and a refund returns exactly that.
- Accounting: `totalCredits` == the sum of all credits <= the contract balance (equal unless someone force-sends
  USDC to the contract, which then stays there), and `totalCredits + totalWithdrawn == totalPaid - totalRefunded`.
- Every state-changing function is `nonReentrant`; transfers happen after all effects and the event. A recipient that
  cannot receive native USDC makes that one refund or withdrawal revert and changes nothing.

## The verifier server
Read-only (no keys, never signs). It only talks to the official Arc RPC hosts over https (timeout, size cap, no redirects),
validates every input before touching the chain, rate-limits per IP (IPv6 per /64; behind your own proxies set
`PAYWALL_TRUST_PROXY=N` and the IP is read from the right of X-Forwarded-For) and globally, shares one price read per
second between quotes, and never logs the retrieval token. The token is a bearer secret: serve the API over TLS. For
expensive calls set `PAYWALL_TOKEN_KEY` (server-issued HMAC tokens) so clients cannot grind tokens; pin
`PAYWALL_EXPECT_PAYEE` to refuse payments that credited anyone else. The example client refuses redirects, checks every
quote before paying and journals what it paid so a dropped connection never loses a purchase.

## Known limitations
- One on-chain receipt per request costs ~0.002 USDC of gas on Arc; sub-cent, high-frequency calls fit a payment channel better.
- The payee is fixed per endpoint; refunds need unwithdrawn credit; a payer that cannot receive cannot be refunded.
- Endpoint names are public, untrusted text; the app renders them as plain text only.
- The Demo page stores a throwaway agent key in the browser's localStorage and runs a demo API in the page. Tiny amounts only.
- GitHub Pages cannot send `X-Frame-Options` / `frame-ancestors`; the app refuses to run inside frames other than Arc Studio's preview.

## Testing
Foundry unit, fuzz and stateful invariant tests (`contracts/test/`) including a model-based handler that predicts the exact
revert data of every call; verifier tests with a fake chain (`verifier/test/`). The deployed mainnet bytecode is
byte-identical to the Arc Testnet deployment made by Arc Studio (checked by our deploy script), and the source is verified
on explorer.arc.io.
