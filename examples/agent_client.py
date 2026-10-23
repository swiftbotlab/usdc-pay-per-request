#!/usr/bin/env python3
"""Pay-per-request agent for arc-paywall/v1 APIs on Arc (standalone example for the public repo).

  pip install eth-account==0.13.7 eth-abi==6.0.0   (pinned, from PyPI; the versions we tested with)
  PAYER_KEY_FILE=./agent.env python3 agent_client.py --network mainnet --contract 0x... --max-price 0.02 \
      "https://api.example.com/v1/weather?city=Paris" [--send]
  PAYER_KEY_FILE=./agent.env python3 agent_client.py ... --resume <requestId> URL     (collect a paid, undelivered request)

agent.env holds one line PRIVATE_KEY=0x... (chmod 600; use a throwaway key with a few cents of USDC, never a main wallet).
Without --send it only fetches and checks the 402 quote and preflights canPay(); with --send it pays and retries.

What the agent checks before paying (never trust a 402 blindly): scheme arc-paywall, the network is the one you chose,
payTo is the contract YOU trust (--contract), the price is <= --max-price, and the requestId is bound to your own address
(top 20 bytes), so nobody else can pay or burn it. Then: canPay preflight -> pay(endpointId, requestId) with exactly the
price -> retry with X-Payer / X-Paywall-Token / X-Paywall-Tx until 200 (or a non-retryable answer).
Never lose a purchase: the quote (with its token) is written to PAYWALL_JOURNAL (default ./paywall_journal.jsonl, 0600)
before paying and the tx hash right after signing, before broadcasting; network errors are retried; --resume collects later.
Redirects are refused everywhere (a hostile API could otherwise forward your token or point the agent at local services).
"""
import argparse, base64, email.utils, json, os, sys, time, urllib.error, urllib.parse, urllib.request
from decimal import Decimal

NETWORKS = {"mainnet": ("https://rpc.mainnet.arc.io", 5042, "https://explorer.arc.io"),
            "testnet": ("https://rpc.testnet.arc.io", 5042002, "https://explorer.testnet.arc.io")}
UA = "arc-paywall-agent-example/1.0"
E18 = 10**18
FLOOR = 20 * 10**9                      # Arc mempool maxFeePerGas floor
REASONS = ["OK", "UnknownEndpoint", "EndpointInactive", "ZeroRequestId", "RequestNotForPayer", "AlreadyPaid", "WrongAmount"]


def keccak(b):
    from eth_utils import keccak as k   # installed with eth-account
    return k(b)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


OPENER = urllib.request.build_opener(_NoRedirect)


def http_json(url, method="GET", headers=None, body=None, timeout=20, limit=1_000_000):
    req = urllib.request.Request(url, data=body, method=method, headers=dict({"user-agent": UA, "accept": "application/json"}, **(headers or {})))
    try:
        with OPENER.open(req, timeout=timeout) as r:
            status, hdrs, raw = r.status, r.headers, r.read(limit + 1)
    except urllib.error.HTTPError as e:
        with e:
            status, hdrs, raw = e.code, e.headers, e.read(limit + 1)
    if 300 <= status < 400:
        raise SystemExit(f"redirect ({status}) refused")
    if len(raw) > limit:
        raise SystemExit("response too large")
    try:
        data = json.loads(raw)
    except ValueError:
        data = None
    return status, {k.lower(): v for k, v in hdrs.items()}, data


class Rpc:
    def __init__(self, url):
        self.url = url

    def __call__(self, method, params):
        _, _, j = http_json(self.url, "POST", {"content-type": "application/json"},
                            json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(), timeout=30)
        if not isinstance(j, dict):
            raise RuntimeError(f"{method}: bad RPC answer")
        if "error" in j:
            raise RuntimeError(f"{method}: {str(j['error'].get('message'))[:200]}")
        return j["result"]


def usdc(wei):
    return f"{Decimal(wei) / Decimal(E18):.6f}"


def retry_after(value):
    try:
        return min(5.0, max(0.25, float(value)))
    except (TypeError, ValueError):
        pass
    try:
        return min(5.0, max(0.25, email.utils.parsedate_to_datetime(value).timestamp() - time.time()))
    except (TypeError, ValueError, IndexError, OverflowError):
        return 1.0


JOURNAL = os.environ.get("PAYWALL_JOURNAL", "paywall_journal.jsonl")


def journal(rec):
    fd = os.open(JOURNAL, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, "a") as f:
        f.write(json.dumps(rec) + "\n")


def journal_lookup(rid):
    out = None
    if os.path.exists(JOURNAL):
        for line in open(JOURNAL):
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("requestId") == rid.lower():
                out = dict(out or {}, **r)
    return out


def collect(url, me, token, tx, window=120):
    """Retry with the payment headers until 200 / a final answer / the window; network errors are retried."""
    t0 = time.time()
    status, hdrs, body, n = None, {}, None, 0
    while time.time() - t0 < window:
        n += 1
        try:
            status, hdrs, body = http_json(url, headers={"x-payer": me, "x-paywall-token": token, "x-paywall-tx": tx})
        except (urllib.error.URLError, OSError, ValueError) as e:
            status, hdrs, body = None, {}, {"retryable": True, "error": type(e).__name__}
        if status == 200 or not (isinstance(body, dict) and body.get("retryable")):
            break
        time.sleep(retry_after(hdrs.get("retry-after", "1")))
    return status, hdrs, body, n, int((time.time() - t0) * 1000)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--network", choices=sorted(NETWORKS) + ["local"], default="testnet")
    ap.add_argument("--rpc", help="only with --network local (an anvil at http://127.0.0.1:PORT)")
    ap.add_argument("--contract", required=True)
    ap.add_argument("--max-price", default="0.02")
    ap.add_argument("url")
    ap.add_argument("--send", action="store_true")
    ap.add_argument("--resume", metavar="REQUESTID")
    a = ap.parse_args()
    from eth_abi import decode, encode
    from eth_account import Account
    from eth_utils import to_checksum_address

    if a.network == "local":
        if not (a.rpc or "").startswith("http://127.0.0.1:"):
            raise SystemExit("--network local needs --rpc http://127.0.0.1:PORT")
        rpc_url, chain, explorer = a.rpc, int(os.environ.get("LOCAL_CHAIN_ID", "31337")), None
    else:
        rpc_url, chain, explorer = NETWORKS[a.network]
    rpc = Rpc(rpc_url)
    if a.resume:
        rec = journal_lookup(a.resume)
        if not rec or not rec.get("tx") or rec.get("url") != a.url:
            raise SystemExit("no journaled payment with that requestId for this URL")
        status, hdrs, body, n, ms = collect(a.url, rec["payer"], rec["token"], rec["tx"])
        print(f"resume -> {status} after {ms} ms ({n} attempt(s))")
        print(json.dumps(body, indent=1)[:1200])
        sys.exit(0 if status == 200 else 3)
    if int(rpc("eth_chainId", []), 16) != chain:
        raise SystemExit("RPC chain id mismatch; refusing")
    contract = to_checksum_address(a.contract)
    d = Decimal(a.max_price)
    max_price = int(d * E18)
    if not (0 < max_price <= E18):
        raise SystemExit("--max-price must be > 0 and <= 1 USDC")
    u = urllib.parse.urlsplit(a.url)
    if u.scheme != "https" and not (u.scheme == "http" and u.hostname in ("127.0.0.1", "localhost")):
        raise SystemExit("URL must be https:// (or http://127.0.0.1 for a local server)")

    key_file = os.environ.get("PAYER_KEY_FILE")
    if not key_file:
        raise SystemExit("set PAYER_KEY_FILE to a file with PRIVATE_KEY=0x...")
    env = dict(l.strip().split("=", 1) for l in open(key_file) if "=" in l and not l.startswith("#"))
    acct = Account.from_key(env["PRIVATE_KEY"])
    del env
    me = acct.address
    print(f"agent {me}: {usdc(int(rpc('eth_getBalance', [me, 'latest']), 16))} USDC -> GET {a.url}")

    # 1. the quote
    t0 = time.time()
    status, hdrs, body = http_json(a.url, headers={"x-payer": me})
    if status != 402 or not isinstance(body, dict):
        raise SystemExit(f"expected 402, got {status}: {str(body)[:200]}")
    acc = (body.get("accepts") or [{}])[0]
    x = acc.get("extra") or {}
    if acc.get("scheme") != "arc-paywall" or acc.get("network") != f"eip155:{chain}":
        raise SystemExit("quote is not arc-paywall on this network; refusing")
    if str(acc.get("payTo", "")).lower() != contract.lower():
        raise SystemExit("payTo is not the contract you trust; refusing")
    amount, eid = int(acc.get("amount", "0")), int(x.get("endpointId", "0"))
    rid, token = str(x.get("requestId", "")), str(x.get("token", ""))
    if not (0 < amount <= max_price) or eid <= 0 or len(rid) != 66 or len(token) != 66:
        raise SystemExit(f"quote refused (price {usdc(amount)} > max {usdc(max_price)} or malformed)")
    if rid[2:42].lower() != me[2:].lower():
        raise SystemExit("requestId is not bound to our address; refusing")
    print(f"1) 402 in {int((time.time() - t0) * 1000)} ms: endpoint #{eid}, {usdc(amount)} USDC, requestId {rid[:18]}...")

    # 2. preflight + pay
    rid_b = bytes.fromhex(rid[2:])
    call = keccak(b"canPay(uint256,bytes32,address,uint256)")[:4] + encode(["uint256", "bytes32", "address", "uint256"], [eid, rid_b, me, amount])
    ok, reason = decode(["bool", "uint8"], bytes.fromhex(rpc("eth_call", [{"to": contract, "data": "0x" + call.hex()}, "latest"])[2:]))
    print(f"   canPay: {REASONS[reason] if reason < len(REASONS) else reason}")
    if not ok or not a.send:
        print("stopping here" if ok else "refusing to pay")
        return
    data = keccak(b"pay(uint256,bytes32)")[:4] + encode(["uint256", "bytes32"], [eid, rid_b])
    base = int(rpc("eth_getBlockByNumber", ["latest", False]).get("baseFeePerGas") or "0x0", 16)
    tx = {"chainId": chain, "to": contract, "value": amount, "data": data, "type": 2, "maxPriorityFeePerGas": 10**9,
          "maxFeePerGas": max(2 * base + 10**9, FLOOR), "nonce": int(rpc("eth_getTransactionCount", [me, "pending"]), 16)}
    tx["gas"] = int(int(rpc("eth_estimateGas", [{"from": me, "to": contract, "value": hex(amount), "data": "0x" + data.hex()}]), 16) * 1.25)
    journal({"url": a.url, "payer": me, "endpointId": eid, "requestId": rid.lower(), "token": token, "amount": str(amount)})
    signed = acct.sign_transaction(tx)
    h = "0x" + bytes(signed.hash).hex().removeprefix("0x")
    journal({"requestId": rid.lower(), "tx": h})          # before broadcasting: never lose track of the payment
    print(f"   pay tx {h} (journal: {JOURNAL})")
    t1 = time.time()
    rpc("eth_sendRawTransaction", ["0x" + signed.raw_transaction.hex().removeprefix("0x")])
    rc = None
    while rc is None and time.time() - t1 < 120:
        try:
            rc = rpc("eth_getTransactionReceipt", [h])
        except (RuntimeError, OSError, ValueError):
            rc = None
        if rc is None:
            time.sleep(0.5)
    if not rc or rc["status"] != "0x1":
        raise SystemExit(f"payment failed or not confirmed yet: {h} (if it lands later: --resume {rid})")
    print(f"2) paid in {time.time() - t1:.2f} s: {explorer + '/tx/' + h if explorer else h}")

    # 3. retry with the payment
    status, hdrs, body, n, ms = collect(a.url, me, token, h)
    print(f"3) {status} after {ms} ms ({n} attempt(s))")
    if status != 200:
        print(f"   not delivered yet: collect it later with --resume {rid}")
    if hdrs.get("x-paywall-receipt"):
        print("   receipt:", base64.b64decode(hdrs["x-paywall-receipt"]).decode()[:300])
    print(json.dumps(body, indent=1)[:1200])
    sys.exit(0 if status == 200 else 3)


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as e:          # RPC errors outside the retried sections
        sys.exit(str(e))
