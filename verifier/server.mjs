#!/usr/bin/env node
/* USDC Pay-per-Request: a minimal provider API behind an HTTP 402 paywall settled on Arc (Swift Bot Labs).
   No dependencies, no secrets required: the server only READS the chain (it never signs or sends a transaction).

     PAYWALL_NETWORK=mainnet|testnet|local  PAYWALL_CONTRACT=0x...  PAYWALL_ENDPOINT_ID=1  node server.mjs
     optional: PORT (8402)  HOST (127.0.0.1)  PAYWALL_RPC (default per network; local REQUIRES it, http://127.0.0.1:...)
               PAYWALL_CHAIN_ID (local only, default 31337)  PAYWALL_MIN_CONFIRMATIONS (1)  PAYWALL_SERVE_WINDOW (3600 s)
               PAYWALL_MAX_SERVES (3)  PAYWALL_EXPECT_PAYEE=0x... (refuse to start / to serve if the endpoint pays anyone else)
               PAYWALL_ALLOW_UNBOUND=1 (also quote clients that send no X-Payer; their requestIds can be front-run)
               PAYWALL_TOKEN_KEY=<64 hex> (optional server key: tokens become nonce + HMAC, so clients cannot choose them;
                                           recommended for prices above a few USDC)
               PAYWALL_TRUST_PROXY=N (behind N reverse proxies of your own: client IP = Nth X-Forwarded-For entry from the right)

   Free:  GET /   GET /health   GET /.well-known/arc-paywall
   Paid:  GET /v1/weather?city=<name>      (sample data; the point is the payment flow)
   Flow:  1. request with X-Payer: <your address> (the requestId is bound to it: only you can pay it)
          2. 402 + PAYMENT-REQUIRED (base64 JSON, mirrored in the body): endpointId, price, payTo (the contract),
             requestId, token
          3. pay(endpointId, requestId) on Arc with value = price
          4. retry the same URL with X-Payer, X-Paywall-Token (from step 2) and X-Paywall-Tx (the pay tx hash)
          5. the server checks the receipt (status, the Paid event: endpointId, requestId, payer, amount), confirmations,
             getPayment(requestId) (not refunded, same payer/amount) and the payment's age, then answers 200 with
             X-Paywall-Receipt.
   The token is a bearer secret for retrieval: it never goes on-chain, so someone who sees your payment on the explorer
   cannot collect your response. Run behind TLS in production. */
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  NETWORKS, ADDR_RE, B32_RE, computeRequestId, makeRpc, readEndpoint, challenge, verifyPayment, isUint, keccakHex, utf8
} from './lib/paywall.mjs';

export const VERSION = '1.1.0';
const CITY_RE = /^[\p{L}][\p{L} .'-]{0,39}$/u;
const MAX_HEADER = 8192;
const ZERO = '0x' + '0'.repeat(40);

/* ---------------------------------------------------------------- config */
export function loadConfig(env) {
  const network = env.PAYWALL_NETWORK || 'testnet';
  if (!['mainnet', 'testnet', 'local'].includes(network)) throw new Error('PAYWALL_NETWORK must be mainnet|testnet|local');
  const contract = String(env.PAYWALL_CONTRACT || '');
  if (!ADDR_RE.test(contract)) throw new Error('PAYWALL_CONTRACT must be 0x + 40 hex');
  const eid = String(env.PAYWALL_ENDPOINT_ID || '');
  if (!isUint(eid) || eid === '0') throw new Error('PAYWALL_ENDPOINT_ID must be a positive integer');
  const int = (name, def, lo, hi) => {
    const v = env[name] === undefined ? String(def) : String(env[name]);
    if (!/^[0-9]{1,9}$/.test(v) || Number(v) < lo || Number(v) > hi) throw new Error(`${name} must be ${lo}..${hi}`);
    return Number(v);
  };
  const payee = env.PAYWALL_EXPECT_PAYEE;
  if (payee !== undefined && !ADDR_RE.test(payee)) throw new Error('PAYWALL_EXPECT_PAYEE must be 0x + 40 hex');
  const key = env.PAYWALL_TOKEN_KEY;
  if (key !== undefined && !/^[0-9a-fA-F]{64}$/.test(key)) throw new Error('PAYWALL_TOKEN_KEY must be 64 hex characters (32 bytes)');
  if (env.PAYWALL_ALLOW_UNBOUND !== undefined && !['0', '1'].includes(env.PAYWALL_ALLOW_UNBOUND)) throw new Error('PAYWALL_ALLOW_UNBOUND must be 0 or 1');
  const net = NETWORKS[network];
  const cfg = {
    network,
    contract: contract.toLowerCase(),
    endpointId: BigInt(eid),
    chainId: network === 'local' ? int('PAYWALL_CHAIN_ID', 31337, 1, 999_999_999) : net.chainId,
    rpcUrl: env.PAYWALL_RPC || (net ? net.rpc : ''),
    explorer: net ? net.explorer : null,
    port: int('PORT', 8402, 1, 65535),
    host: env.HOST || '127.0.0.1',
    minConfirmations: int('PAYWALL_MIN_CONFIRMATIONS', 1, 1, 64),
    serveWindow: int('PAYWALL_SERVE_WINDOW', 3600, 60, 7 * 86400),
    maxServes: int('PAYWALL_MAX_SERVES', 3, 1, 100),
    trustProxy: int('PAYWALL_TRUST_PROXY', 0, 0, 5),
    allowUnbound: env.PAYWALL_ALLOW_UNBOUND === '1',
    expectPayee: payee ? payee.toLowerCase() : null,
    tokenKey: key ? Buffer.from(key, 'hex') : null
  };
  if (network === 'local' && !/^http:\/\/(127\.0\.0\.1|localhost):[0-9]{2,5}\/?$/.test(cfg.rpcUrl)) {
    throw new Error('local needs PAYWALL_RPC=http://127.0.0.1:<port>');
  }
  if (network !== 'local' && env.PAYWALL_RPC && env.PAYWALL_RPC !== net.rpc) throw new Error('mainnet/testnet use the official Arc RPC');
  return cfg;
}

/* ---------------------------------------------------------------- the sample API */
export function sampleWeather(city) {
  const h = keccakHex(utf8('weather:' + city.toLowerCase()));
  const b = (i) => parseInt(h.slice(2 + 2 * i, 4 + 2 * i), 16);
  const conditions = ['clear', 'partly cloudy', 'cloudy', 'light rain', 'windy', 'fog'];
  return { city, sample: true, temperatureC: (b(0) % 40) - 5, conditions: conditions[b(1) % conditions.length],
    humidityPct: 30 + (b(2) % 60), windKmh: b(3) % 35,
    note: 'Sample data derived from the city name: this demo API sells the payment flow, not forecasts.' };
}

/* ---------------------------------------------------------------- small helpers */
function send(res, status, body, headers = {}) {
  const text = JSON.stringify(body, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', 'access-control-allow-origin': '*',
    'access-control-allow-headers': 'x-payer, x-paywall-token, x-paywall-tx',
    'access-control-expose-headers': 'PAYMENT-REQUIRED, X-Paywall-Receipt, Retry-After'
  }, headers));
  res.end(text);
}
const b64 = (obj) => Buffer.from(JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? v.toString() : v))).toString('base64');

/** Fixed-window limiter per key; when full, the oldest key is evicted (never a global reset). */
export function rateLimiter(limit, windowMs, now = () => Date.now(), maxKeys = 5000) {
  const buckets = new Map();
  return function limited(key) {
    const t = now();
    let b = buckets.get(key);
    if (!b || t - b.start > windowMs) b = { start: t, n: 0 };
    buckets.delete(key);
    buckets.set(key, b);                         /* most recently used last */
    while (buckets.size > maxKeys) buckets.delete(buckets.keys().next().value);
    b.n++;
    return b.n > limit ? Math.max(1, Math.ceil((b.start + windowMs - t) / 1000)) : 0;
  };
}

/** Rate-limit key for an IP: IPv4 as is (also when IPv4-mapped), IPv6 grouped by its /64 (one host owns a whole /64). */
export function ipKey(ip) {
  const s = String(ip || '?').trim().toLowerCase();
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  if (!s.includes(':')) return s;
  const [head, tail = ''] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = s.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/** Client IP: the socket address, or (behind N proxies of your own) the Nth X-Forwarded-For entry from the RIGHT;
 *  the left part of that header is client-controlled and never trusted. */
export function clientIp(req, trustProxy) {
  if (trustProxy > 0) {
    const parts = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (parts.length >= trustProxy) return parts[parts.length - trustProxy];
  }
  return req.socket.remoteAddress || '?';
}

/** token = 16-byte nonce || first 16 bytes of HMAC-SHA256(key, context || nonce): the server can recognise its own tokens
 *  statelessly, so a client cannot grind tokens (birthday search on the 96-bit requestId digest). */
export function issueToken(key, ctx, nonce16) {
  const mac = crypto.createHmac('sha256', key).update(ctx).update(nonce16).digest().subarray(0, 16);
  return '0x' + Buffer.concat([nonce16, mac]).toString('hex');
}
export function tokenOk(key, ctx, token) {
  const raw = Buffer.from(token.slice(2), 'hex');
  const want = Buffer.from(issueToken(key, ctx, raw.subarray(0, 16)).slice(2), 'hex');
  return crypto.timingSafeEqual(raw, want);
}

/* ---------------------------------------------------------------- the handler (injectable for tests) */
export function createHandler(cfg, deps = {}) {
  const rpc = deps.rpc || makeRpc({ url: cfg.rpcUrl, allowLocal: cfg.network === 'local' });
  const nowSec = deps.nowSec || (() => Math.floor(Date.now() / 1000));
  const nowMs = deps.nowMs || (() => Date.now());
  const randomBytes = deps.randomBytes || ((n) => crypto.randomBytes(n));
  const log = deps.log || ((o) => console.log(JSON.stringify(o)));
  const quoteLimit = rateLimiter(deps.quoteLimit || 60, 60_000, nowMs);
  const verifyLimit = rateLimiter(deps.verifyLimit || 30, 60_000, nowMs);
  const globalVerify = rateLimiter(deps.globalVerifyPerSec || 20, 1000, nowMs, 1);   /* caps RPC load from verifications */
  const served = new Map(); /* requestId -> times served (insertion-ordered, capped; per process) */
  let cache = null;          /* {e, at, err} */
  let inflight = null;

  /* The endpoint (price, active) is read once per `maxAgeMs` and shared by concurrent requests (one eth_call). Quotes use
     1 s: right after setPrice a quote can be at most ~1 s stale, and the contract refuses a stale price (WrongAmount)
     instead of charging it. /health uses 10 s. A failed read is cached for 2 s so an RPC outage is not amplified. */
  async function endpoint(maxAgeMs) {
    const t = nowMs();
    if (cache && t - cache.at < (cache.err ? 2000 : maxAgeMs)) {
      if (cache.err) throw cache.err;
      return cache.e;
    }
    if (!inflight) {
      inflight = (async () => {
        try {
          const e = await readEndpoint(rpc, cfg.contract, cfg.endpointId);
          if (e.provider === ZERO) throw new Error('endpoint not registered on this contract');
          cache = { e, at: nowMs() };
          return e;
        } catch (err) {
          cache = { err, at: nowMs() };
          throw err;
        } finally {
          inflight = null;
        }
      })();
    }
    return inflight;
  }

  function tokenContext(payer, resource) {
    return `${DOMAIN_CTX}|${cfg.chainId}|${cfg.contract}|${cfg.endpointId}|${payer || ZERO}|${resource}`;
  }

  async function weather(req, res, url, ip, entry) {
    const params = [...url.searchParams.keys()];
    const city = url.searchParams.get('city');
    if (params.length !== 1 || params[0] !== 'city' || !city || !CITY_RE.test(city)) {
      return send(res, 400, { ok: false, error: 'bad_request', message: 'GET /v1/weather?city=<letters, spaces, . \' -; max 40>' });
    }
    const resource = 'GET /v1/weather?city=' + encodeURIComponent(city);
    const payerH = req.headers['x-payer'];
    const tokenH = req.headers['x-paywall-token'];
    const txH = req.headers['x-paywall-tx'];
    if (payerH !== undefined && !ADDR_RE.test(String(payerH))) return send(res, 400, { ok: false, error: 'bad_payer', message: 'X-Payer must be 0x + 40 hex' });
    if (payerH === undefined && !cfg.allowUnbound) {
      return send(res, 400, { ok: false, error: 'payer_required', message: 'Send X-Payer: <the address that will pay>; the requestId is bound to it so nobody else can pay or burn it.' });
    }
    const payer = payerH ? String(payerH).toLowerCase() : null;
    entry.payer = payer;

    if (tokenH === undefined) {                                   /* ---- 1. no token: quote */
      const wait = quoteLimit(ip);
      if (wait) return send(res, 429, { ok: false, error: 'rate_limited' }, { 'retry-after': String(wait) });
      let e;
      try { e = await endpoint(1000); } catch (err) {
        entry.err = String(err.message || err).slice(0, 120);
        return send(res, 502, { ok: false, error: 'chain_unavailable', message: 'Could not read the endpoint price from Arc.' }, { 'retry-after': '2' });
      }
      if (!e.active) return send(res, 503, { ok: false, error: 'endpoint_inactive', message: 'The provider paused this endpoint.' }, { 'retry-after': '60' });
      const token = cfg.tokenKey ? issueToken(cfg.tokenKey, tokenContext(payer, resource), randomBytes(16)) : '0x' + randomBytes(32).toString('hex');
      const { requestId } = computeRequestId({ chainId: cfg.chainId, contract: cfg.contract, endpointId: cfg.endpointId, payer, resource, token });
      entry.requestId = requestId.slice(0, 18);
      const body = challenge({ cfg, resource, url: url.pathname + url.search, payer, token, requestId, price: e.price,
        description: 'Current weather for a city (sample data), paid per request in USDC on Arc.' });
      return send(res, 402, body, { 'PAYMENT-REQUIRED': b64(body) });
    }

    /* ---- 2. token presented: verify the payment */
    const wait = verifyLimit(ip);
    if (wait) return send(res, 429, { ok: false, error: 'rate_limited' }, { 'retry-after': String(wait) });
    if (!B32_RE.test(String(tokenH)) || !B32_RE.test(String(txH || ''))) {
      return send(res, 400, { ok: false, error: 'bad_payment_headers', message: 'X-Paywall-Token and X-Paywall-Tx must be 0x + 64 hex' });
    }
    const token = String(tokenH).toLowerCase();
    if (cfg.tokenKey && !tokenOk(cfg.tokenKey, tokenContext(payer, resource), token)) {
      return send(res, 402, { ok: false, error: 'unknown_token', message: 'This token was not issued by this server for this payer and resource.', retryable: false });
    }
    const { requestId } = computeRequestId({ chainId: cfg.chainId, contract: cfg.contract, endpointId: cfg.endpointId, payer, resource, token });
    entry.requestId = requestId.slice(0, 18);
    entry.tx = String(txH).toLowerCase();
    if ((served.get(requestId) || 0) >= cfg.maxServes) {         /* checked BEFORE any chain read */
      return send(res, 429, { ok: false, error: 'already_served', message: `served ${cfg.maxServes} times already` });
    }
    if (globalVerify('all')) return send(res, 503, { ok: false, error: 'busy', message: 'Too many verifications right now.', retryable: true }, { 'retry-after': '1' });
    const v = await verifyPayment({ rpc, cfg, txHash: String(txH), requestId, expectedPayer: payer, nowSec: nowSec() });
    if (!v.ok) {
      entry.verify = v.error;
      if (v.internal) entry.err = v.internal;
      const h = v.retryAfter ? { 'retry-after': String(v.retryAfter) } : {};
      return send(res, v.status, { ok: false, error: v.error, message: v.detail, retryable: v.retryable, requestId }, h);
    }
    const n = (served.get(requestId) || 0) + 1;
    if (n > cfg.maxServes) return send(res, 429, { ok: false, error: 'already_served', message: `served ${cfg.maxServes} times already` });
    served.delete(requestId);
    served.set(requestId, n);
    if (served.size > 10_000) served.delete(served.keys().next().value);
    const receipt = { requestId, tx: v.tx, payer: v.payer, amount: v.amount.toString(), block: v.block.toString(),
      confirmations: v.confirmations.toString(), contract: cfg.contract, endpointId: cfg.endpointId.toString(),
      explorer: cfg.explorer ? cfg.explorer + '/tx/' + v.tx : null };
    entry.paid = v.amount.toString();
    return send(res, 200, { ok: true, data: sampleWeather(city), payment: receipt }, { 'X-Paywall-Receipt': b64(receipt) });
  }

  return async function handle(req, res) {
    const t0 = Date.now();
    const ip = ipKey(clientIp(req, cfg.trustProxy));
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { return send(res, 400, { ok: false, error: 'bad_url' }); }
    const entry = { t: new Date().toISOString(), m: req.method, p: url.pathname };
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'x-payer, x-paywall-token, x-paywall-tx', 'access-control-allow-methods': 'GET, OPTIONS' }); return res.end(); }
      if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method_not_allowed' }, { allow: 'GET, OPTIONS' });
      if (url.pathname === '/v1/weather') return await weather(req, res, url, ip, entry);
      if (url.pathname === '/health') {
        const wait = quoteLimit('health|' + ip);
        if (wait) return send(res, 429, { ok: false, error: 'rate_limited' }, { 'retry-after': String(wait) });
        let e = null;
        try { e = await endpoint(10_000); } catch (err) { /* reported below */ }
        return send(res, e ? 200 : 502, { ok: !!e, service: 'arc-paywall-verifier', version: VERSION, network: cfg.network,
          chainId: cfg.chainId, contract: cfg.contract, endpointId: cfg.endpointId.toString(),
          price: e ? e.price.toString() : null, active: e ? e.active : null, minConfirmations: cfg.minConfirmations,
          payerRequired: !cfg.allowUnbound, serverTokens: !!cfg.tokenKey });
      }
      if (url.pathname === '/.well-known/arc-paywall') {
        return send(res, 200, { protocol: 'arc-paywall/v1', network: 'eip155:' + cfg.chainId, contract: cfg.contract,
          resources: [{ path: '/v1/weather?city=<name>', endpointId: cfg.endpointId.toString() }],
          retryHeaders: ['X-Payer', 'X-Paywall-Token', 'X-Paywall-Tx'] });
      }
      if (url.pathname === '/') {
        return send(res, 200, { service: 'USDC Pay-per-Request demo API (Swift Bot Labs)', paid: 'GET /v1/weather?city=Paris',
          how: 'Call it with X-Payer, get 402 with a requestId and a token, pay(endpointId, requestId) on Arc with the exact price, retry with X-Payer, X-Paywall-Token and X-Paywall-Tx.',
          free: ['/health', '/.well-known/arc-paywall'] });
      }
      return send(res, 404, { ok: false, error: 'not_found' });
    } catch (err) {
      entry.err = String(err && err.message || err).slice(0, 120);
      return send(res, 500, { ok: false, error: 'internal' });
    } finally {
      entry.s = res.statusCode;
      entry.ms = Date.now() - t0;
      if (url && url.pathname === '/v1/weather') log(entry); /* never the token: requestId prefix, payer, tx only */
    }
  };
}
const DOMAIN_CTX = 'arc-paywall/v1';

export function startServer(cfg, deps = {}) {
  const handler = createHandler(cfg, deps);
  const server = http.createServer({ maxHeaderSize: MAX_HEADER, connectionsCheckingInterval: 2000 }, (req, res) => { handler(req, res); });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = deps.maxConnections || 512;
  return server;
}

async function main() {
  let cfg;
  try { cfg = loadConfig(process.env); } catch (e) { console.error('config error:', e.message); process.exit(2); }
  const rpc = makeRpc({ url: cfg.rpcUrl, allowLocal: cfg.network === 'local' });
  const chain = Number(BigInt(await rpc('eth_chainId', [])));
  if (chain !== cfg.chainId) { console.error(`chain id ${chain} != expected ${cfg.chainId}; refusing`); process.exit(2); }
  const code = await rpc('eth_getCode', [cfg.contract, 'latest']);
  if (typeof code !== 'string' || code.length <= 2) { console.error('no contract code at PAYWALL_CONTRACT; refusing'); process.exit(2); }
  const e = await readEndpoint(rpc, cfg.contract, cfg.endpointId);
  if (e.provider === ZERO) { console.error('endpoint not registered on this contract; refusing'); process.exit(2); }
  if (cfg.expectPayee && e.payee !== cfg.expectPayee) { console.error('the endpoint pays another payee than PAYWALL_EXPECT_PAYEE; refusing'); process.exit(2); }
  const server = startServer(cfg, { rpc });
  server.listen(cfg.port, cfg.host, () => {
    console.log(JSON.stringify({ listening: `http://${cfg.host}:${server.address().port}`, network: cfg.network, chainId: cfg.chainId,
      contract: cfg.contract, endpointId: cfg.endpointId.toString(), price: e.price.toString(), active: e.active,
      payee: e.payee, payerRequired: !cfg.allowUnbound, serverTokens: !!cfg.tokenKey }));
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error('fatal:', String(e && e.message || e).slice(0, 200)); process.exit(1); });
}
