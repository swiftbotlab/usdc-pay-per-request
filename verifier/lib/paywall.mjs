/* arc-paywall/v1: the protocol pieces a provider's API server needs, dependency-free.
   - requestId derivation (payer-bound, resource-bound, token-bound)
   - the HTTP 402 challenge (x402 v2 envelope, scheme "arc-paywall")
   - a locked-down JSON-RPC client (Arc RPC hosts only, timeout, size cap, no redirects)
   - verifyPayment: receipt + Paid log + getPayment(requestId) + confirmations + refund + age checks
   Everything that comes from the network or the client is data: validated with strict regexes, never evaluated. */
import { keccak256 } from './keccak.mjs';

export const DOMAIN_TAG = 'arc-paywall/v1';
export const NETWORKS = {
  mainnet: { chainId: 5042, rpc: 'https://rpc.mainnet.arc.io', explorer: 'https://explorer.arc.io' },
  testnet: { chainId: 5042002, rpc: 'https://rpc.testnet.arc.io', explorer: 'https://explorer.testnet.arc.io' }
};
const RPC_HOSTS = new Set(['rpc.mainnet.arc.io', 'rpc.testnet.arc.io']);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
export const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
export const B32_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const UINT_RE = /^(0|[1-9][0-9]{0,77})$/;
const ZERO_ADDR = '0x' + '0'.repeat(40);

/* ---------------------------------------------------------------- bytes */
export function utf8(s) { return new TextEncoder().encode(s); }
export function toHex(b) { return '0x' + Buffer.from(b).toString('hex'); }
export function fromHex(h) {
  if (typeof h !== 'string' || !HEX_RE.test(h)) throw new Error('bad hex');
  return Uint8Array.from(Buffer.from(h.slice(2), 'hex'));
}
export function keccakHex(bytes) { return toHex(keccak256(bytes)); }
function concat(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function wordUint(v) {
  let x = BigInt(v);
  if (x < 0n || x >= 1n << 256n) throw new Error('uint out of range');
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}
function wordAddr(a) {
  if (!ADDR_RE.test(a)) throw new Error('bad address');
  const out = new Uint8Array(32);
  out.set(fromHex(a.toLowerCase()), 12);
  return out;
}
function wordB32(h) {
  if (!B32_RE.test(h)) throw new Error('bad bytes32');
  return fromHex(h.toLowerCase());
}

/* ---------------------------------------------------------------- ABI constants (checked against `cast` in the tests) */
export const SELECTORS = {
  getPayment: keccakHex(utf8('getPayment(bytes32)')).slice(0, 10),
  getEndpoint: keccakHex(utf8('getEndpoint(uint256)')).slice(0, 10),
  pay: keccakHex(utf8('pay(uint256,bytes32)')).slice(0, 10)
};
export const PAID_TOPIC = keccakHex(utf8('Paid(uint256,bytes32,address,address,uint256)'));
export const DOMAIN = keccakHex(utf8(DOMAIN_TAG));

/* ---------------------------------------------------------------- request ids */
export function resourceHash(resource) {
  if (typeof resource !== 'string' || resource.length === 0 || resource.length > 2048) throw new Error('bad resource');
  return keccakHex(utf8(resource));
}

/** digest = keccak256(abi.encode(bytes32 DOMAIN, uint256 chainId, address contract, uint256 endpointId, address payer,
 *                                 bytes32 keccak256(resource), bytes32 token)); requestId = payer (20 bytes) || digest[20..32] */
export function computeRequestId({ chainId, contract, endpointId, payer, resource, token }) {
  const p = payer || ZERO_ADDR;
  const digest = keccak256(concat([wordB32(DOMAIN), wordUint(chainId), wordAddr(contract), wordUint(endpointId),
    wordAddr(p), wordB32(resourceHash(resource)), wordB32(token)]));
  const rid = concat([fromHex(p.toLowerCase()), digest.slice(20)]);
  return { digest: toHex(digest), requestId: toHex(rid) };
}

/** The only address allowed to pay a requestId (zero address = anyone). */
export function payerOf(requestId) {
  if (!B32_RE.test(requestId)) throw new Error('bad requestId');
  return '0x' + requestId.slice(2, 42).toLowerCase();
}

/* ---------------------------------------------------------------- decoding */
function words(hex, n) {
  if (typeof hex !== 'string' || !HEX_RE.test(hex) || hex.length !== 2 + 64 * n) throw new Error('bad ABI result length');
  const out = [];
  for (let i = 0; i < n; i++) out.push(hex.slice(2 + 64 * i, 66 + 64 * i));
  return out;
}
function addrOfWord(w) {
  if (!/^0{24}/.test(w)) throw new Error('bad address word');
  return '0x' + w.slice(24).toLowerCase();
}
function boolOfWord(w) {
  if (!/^0{63}[01]$/.test(w)) throw new Error('bad bool word');
  return w.endsWith('1');
}
const big = (w) => BigInt('0x' + w);

/** getEndpoint(uint256) -> (provider, active, createdAt, payee, paidCount, price, totalPaid, totalRefunded, refundCount) */
export function decodeEndpoint(hex) {
  const w = words(hex, 9);
  return { provider: addrOfWord(w[0]), active: boolOfWord(w[1]), createdAt: big(w[2]), payee: addrOfWord(w[3]),
    paidCount: big(w[4]), price: big(w[5]), totalPaid: big(w[6]), totalRefunded: big(w[7]), refundCount: big(w[8]) };
}

/** getPayment(bytes32) -> (payer, endpointId, refunded, amount, paidAt, paidBlock) */
export function decodePayment(hex) {
  const w = words(hex, 6);
  return { payer: addrOfWord(w[0]), endpointId: big(w[1]), refunded: boolOfWord(w[2]), amount: big(w[3]),
    paidAt: big(w[4]), paidBlock: big(w[5]) };
}

/** Paid(uint256 indexed endpointId, bytes32 indexed requestId, address indexed payer, address payee, uint256 amount) */
export function decodePaidLog(log) {
  if (!log || !Array.isArray(log.topics) || log.topics.length !== 4) throw new Error('not a Paid log');
  for (const t of log.topics) if (!B32_RE.test(t)) throw new Error('bad topic');
  const d = words(log.data, 2);
  return { endpointId: BigInt(log.topics[1]), requestId: log.topics[2].toLowerCase(),
    payer: addrOfWord(log.topics[3].slice(2)), payee: addrOfWord(d[0]), amount: big(d[1]) };
}

/* ---------------------------------------------------------------- JSON-RPC client */
/** rpc(method, params) for an Arc RPC URL. Remote: https + rpc.{mainnet,testnet}.arc.io only. allowLocal: also
 *  http://127.0.0.1|localhost (an anvil for tests and rehearsals). Timeout, response size cap, redirects refused. */
export function makeRpc({ url, allowLocal = false, timeoutMs = 8000, maxBytes = 1_000_000, fetchImpl = fetch }) {
  const u = new URL(url);
  const remoteOk = u.protocol === 'https:' && RPC_HOSTS.has(u.hostname) && !u.username && !u.password;
  const localOk = allowLocal && u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname);
  if (!remoteOk && !localOk) throw new Error('RPC URL not allowed: ' + u.protocol + '//' + u.hostname);
  let id = 0;
  return async function rpc(method, params) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(u.href, {
        method: 'POST', redirect: 'error', signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'user-agent': 'swiftbotlab-arc-paywall-verifier/1.0' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })
      });
      if (res.status !== 200) throw new Error('RPC HTTP ' + res.status);
      const reader = res.body.getReader();
      const parts = [];
      let n = 0;
      for (;;) {
        const x = await reader.read();
        if (x.done) break;
        n += x.value.byteLength;
        if (n > maxBytes) { ctl.abort(); throw new Error('RPC response too large'); }
        parts.push(x.value);
      }
      let j;
      try { j = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch (e) { throw new Error('RPC returned invalid JSON'); }
      if (!j || typeof j !== 'object') throw new Error('RPC returned invalid JSON');
      if (j.error) throw new Error('RPC error: ' + String(j.error.message || j.error.code).slice(0, 160));
      return j.result;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('RPC timeout');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
}

/* ---------------------------------------------------------------- chain reads */
export async function readEndpoint(rpc, contract, endpointId) {
  const data = SELECTORS.getEndpoint + toHex(wordUint(endpointId)).slice(2);
  return decodeEndpoint(await rpc('eth_call', [{ to: contract, data }, 'latest']));
}

export async function readPayment(rpc, contract, requestId, block = 'latest') {
  const data = SELECTORS.getPayment + requestId.slice(2).toLowerCase();
  return decodePayment(await rpc('eth_call', [{ to: contract, data }, block]));
}

/* ---------------------------------------------------------------- the 402 challenge */
export function challenge({ cfg, resource, url, payer, token, requestId, price, description }) {
  return {
    x402Version: 2,
    error: 'payment required',
    resource: { url, method: resource.split(' ')[0], description, mimeType: 'application/json' },
    accepts: [{
      scheme: 'arc-paywall',
      network: 'eip155:' + cfg.chainId,
      asset: 'native USDC (18 decimals)',
      amount: price.toString(),
      payTo: cfg.contract,
      maxTimeoutSeconds: cfg.serveWindow,
      extra: {
        protocol: DOMAIN_TAG,
        endpointId: cfg.endpointId.toString(),
        requestId,
        token,
        payer: payer || null,
        resource,
        call: 'pay(uint256 endpointId, bytes32 requestId) with value = amount',
        minConfirmations: cfg.minConfirmations,
        retryWith: { 'X-Payer': payer || '<your address, optional>', 'X-Paywall-Token': token, 'X-Paywall-Tx': '<pay tx hash>' },
        explorer: cfg.explorer || null
      }
    }]
  };
}

/* ---------------------------------------------------------------- verification */
function fail(status, error, detail, retryable = false, retryAfter = 0, internal = '') {
  return { ok: false, status, error, detail, retryable, retryAfter, internal };
}

/** Verify that `txHash` paid `requestId` on cfg.endpointId (and that it still counts). Never throws for chain data;
 *  RPC failures are returned as a 502 (the RPC's own error text only in `internal`, for logs, never to clients).
 *  cfg: {contract, endpointId (BigInt), minConfirmations, serveWindow, expectPayee?}. */
export async function verifyPayment({ rpc, cfg, txHash, requestId, expectedPayer, nowSec }) {
  if (!B32_RE.test(txHash || '') || !B32_RE.test(requestId || '')) return fail(400, 'bad_request', 'tx hash and requestId must be 0x + 64 hex');
  const contract = cfg.contract.toLowerCase();
  const rid = requestId.toLowerCase();
  let receipt, latest, pay;
  try {
    receipt = await rpc('eth_getTransactionReceipt', [txHash]);
  } catch (e) {
    return fail(502, 'rpc_unavailable', 'the chain RPC did not answer; retry', true, 2, String(e.message || e).slice(0, 120));
  }
  if (!receipt) return fail(402, 'payment_not_found', 'no receipt for this tx yet', true, 1);
  if (receipt.status !== '0x1') return fail(402, 'payment_failed', 'the payment transaction reverted');
  const logs = (Array.isArray(receipt.logs) ? receipt.logs : []).filter((l) => l && typeof l.address === 'string'
    && l.address.toLowerCase() === contract && Array.isArray(l.topics) && String(l.topics[0]).toLowerCase() === PAID_TOPIC
    && l.topics.length === 4 && String(l.topics[2]).toLowerCase() === rid);
  if (logs.length !== 1) return fail(402, 'no_matching_payment', 'this tx has no Paid event for this request');
  let ev;
  try { ev = decodePaidLog(logs[0]); } catch (e) { return fail(402, 'no_matching_payment', 'malformed Paid event'); }
  if (ev.endpointId !== cfg.endpointId) return fail(402, 'no_matching_payment', 'paid a different endpoint');
  if (expectedPayer && ev.payer !== expectedPayer.toLowerCase()) return fail(402, 'payer_mismatch', 'paid by another address');
  if (cfg.expectPayee && ev.payee !== cfg.expectPayee.toLowerCase()) return fail(402, 'wrong_payee', 'this payment credited another payee');
  if (ev.amount <= 0n) return fail(402, 'no_matching_payment', 'zero amount');
  let block;
  try {
    block = BigInt(receipt.blockNumber);
    const [latestHex, p] = await Promise.all([rpc('eth_blockNumber', []), readPayment(rpc, contract, rid)]);  /* 2 round trips, not 3 */
    latest = BigInt(latestHex);
    pay = p;
  } catch (e) {
    return fail(502, 'rpc_unavailable', 'the chain RPC did not answer; retry', true, 2, String(e.message || e).slice(0, 120));
  }
  const confirmations = latest - block + 1n;
  if (confirmations < BigInt(cfg.minConfirmations)) {
    return fail(402, 'awaiting_confirmations', `${confirmations} of ${cfg.minConfirmations} confirmations`, true, 1);
  }
  if (pay.payer === '0x' + '0'.repeat(40)) {
    /* the node that answered eth_call may lag behind the one that returned the receipt: wait, don't fail for good */
    return fail(402, 'payment_not_visible_yet', 'the payment is not visible to getPayment() yet', true, 1);
  }
  if (pay.payer !== ev.payer || pay.endpointId !== ev.endpointId || pay.amount !== ev.amount) {
    return fail(402, 'inconsistent_payment', 'getPayment() disagrees with the Paid event');
  }
  if (pay.refunded) return fail(402, 'payment_refunded', 'the provider refunded this request');
  if (Number(pay.paidAt) + cfg.serveWindow < nowSec) return fail(410, 'payment_expired', `paid more than ${cfg.serveWindow} s ago`);
  return { ok: true, requestId: rid, tx: txHash.toLowerCase(), payer: ev.payer, amount: ev.amount, block, paidAt: pay.paidAt, confirmations };
}

export function isUint(s) { return typeof s === 'string' && UINT_RE.test(s); }
