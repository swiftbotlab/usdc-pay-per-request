/* Offline tests for the verifier: node --test verifier/test/   (no network; a fake chain stands in for the RPC) */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { keccak256 } from '../lib/keccak.mjs';
import {
  computeRequestId, payerOf, SELECTORS, PAID_TOPIC, DOMAIN, decodeEndpoint, decodePayment, makeRpc, verifyPayment, toHex
} from '../lib/paywall.mjs';
import { startServer, loadConfig, sampleWeather, rateLimiter, ipKey, clientIp, issueToken, tokenOk } from '../server.mjs';

const V = JSON.parse(fs.readFileSync(new URL('./vectors.json', import.meta.url)));
const CONTRACT = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
const OTHER_CONTRACT = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512';
const PAYER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const PAYER2 = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const PROVIDER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const PRICE = 10n ** 16n;
const NOW = 1_760_000_000;

const w = (v) => BigInt(v).toString(16).padStart(64, '0');
const wa = (a) => a.slice(2).toLowerCase().padStart(64, '0');

/* ---------------------------------------------------------------- fake chain */
function fakeChain() {
  const st = { block: 1000n, receipts: {}, payments: {}, down: false, calls: [],
    endpoint: { provider: PROVIDER, active: true, price: PRICE, payee: PROVIDER } };
  async function rpc(method, params) {
    st.calls.push(method);
    if (st.down) throw new Error('connect ECONNREFUSED');
    if (method === 'eth_blockNumber') return '0x' + st.block.toString(16);
    if (method === 'eth_getTransactionReceipt') return st.receipts[params[0].toLowerCase()] || null;
    if (method === 'eth_call') {
      const { to, data } = params[0];
      assert.equal(to, CONTRACT);
      if (data.startsWith(SELECTORS.getEndpoint)) {
        const e = st.endpoint;
        return '0x' + wa(e.provider) + w(e.active ? 1 : 0) + w(NOW - 500) + wa(e.payee) + w(3) + w(e.price) + w(3n * e.price) + w(0) + w(0);
      }
      if (data.startsWith(SELECTORS.getPayment)) {
        const p = st.payments['0x' + data.slice(10)] || { payer: '0x' + '0'.repeat(40), endpointId: 0n, refunded: false, amount: 0n, paidAt: 0, paidBlock: 0n };
        return '0x' + wa(p.payer) + w(p.endpointId) + w(p.refunded ? 1 : 0) + w(p.amount) + w(p.paidAt) + w(p.paidBlock);
      }
    }
    throw new Error('unexpected ' + method);
  }
  function pay({ tx, requestId, payer = PAYER, amount = PRICE, endpointId = 1n, status = '0x1', emitter = CONTRACT, paidAt = NOW - 5, record = true }) {
    const log = { address: emitter, topics: [PAID_TOPIC, '0x' + w(endpointId), requestId, '0x' + wa(payer)], data: '0x' + wa(PROVIDER) + w(amount) };
    st.receipts[tx] = { status, blockNumber: '0x' + st.block.toString(16), logs: status === '0x1' ? [log] : [] };
    if (record && status === '0x1' && emitter === CONTRACT) {
      st.payments[requestId] = { payer, endpointId, refunded: false, amount, paidAt, paidBlock: st.block };
    }
  }
  return { st, rpc, pay };
}

const cfgFor = (over = {}) => Object.assign(loadConfig({ PAYWALL_NETWORK: 'local', PAYWALL_RPC: 'http://127.0.0.1:18547',
  PAYWALL_CONTRACT: CONTRACT, PAYWALL_ENDPOINT_ID: '1', PAYWALL_CHAIN_ID: '31337' }), over);

const clock = { ms: NOW * 1000 };
async function withServer(chain, fn, over = {}, deps = {}) {
  const logs = [];
  const server = startServer(cfgFor(over), Object.assign({ rpc: chain.rpc, nowSec: () => NOW, nowMs: () => clock.ms, log: (o) => logs.push(o) }, deps));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, logs, server); } finally { clock.ms += 60_000; await new Promise((r) => server.close(r)); }
}

async function quote(base, path = '/v1/weather?city=Paris', payer = PAYER) {
  const r = await fetch(base + path, { headers: payer ? { 'x-payer': payer } : {} });
  const body = await r.json();
  return { r, body, x: body.accepts && body.accepts[0] };
}

/* ---------------------------------------------------------------- keccak + vectors */
test('keccak256 matches eth_utils vectors (incl. 135/136/137-byte rate boundaries)', () => {
  for (const t of V.keccak) {
    assert.equal(Buffer.from(keccak256(Uint8Array.from(Buffer.from(t.hex, 'hex')))).toString('hex'), t.keccak, t.name);
  }
});

test('requestId derivation matches the Python/Solidity vectors (bound, unbound, max endpoint id, UTF-8 city)', () => {
  for (const c of V.requestIds) {
    const got = computeRequestId({ chainId: c.chainId, contract: c.contract, endpointId: c.endpointId, payer: c.payer === '0x' + '0'.repeat(40) ? null : c.payer, resource: c.resource, token: c.token });
    assert.equal(got.digest, c.digest);
    assert.equal(got.requestId, c.requestId);
    assert.equal(payerOf(got.requestId), c.payer.toLowerCase());
  }
  // the Solidity unit test pins the first vector too (test_requestIdFor_offchainVector)
  assert.equal(V.requestIds[0].requestId, '0x222222222222222222222222222222222222222291fd801985e2bd8a9a5903dd');
});

test('selectors and topics equal `cast sig` / `cast sig-event`', () => {
  assert.equal(SELECTORS.pay, '0x8e6bee97');
  assert.equal(SELECTORS.getPayment, '0xe66eefc8');
  assert.equal(SELECTORS.getEndpoint, '0x937bbc4a');
  assert.equal(PAID_TOPIC, '0x0f3c07e40340ee795b942048b66e7145339580e319ff1669f015e659b810063b');
  assert.equal(DOMAIN, '0xa9be0759f3319b8086d2aab6359727ab7c6040ca65e834246e87d5bdfaae3770');
});

test('ABI decoders are strict', () => {
  assert.throws(() => decodePayment('0x' + w(1)), /length/);
  assert.throws(() => decodeEndpoint('0x' + 'ff'.repeat(32) + w(1).repeat(8)), /address/);
  assert.throws(() => decodePayment('0x' + wa(PAYER) + w(1) + w(2) + w(1) + w(1) + w(1)), /bool/);
  const p = decodePayment('0x' + wa(PAYER) + w(7) + w(1) + w(PRICE) + w(NOW) + w(99));
  assert.deepEqual([p.payer, p.endpointId, p.refunded, p.amount, p.paidAt, p.paidBlock], [PAYER, 7n, true, PRICE, BigInt(NOW), 99n]);
});

/* ---------------------------------------------------------------- the 402 */
test('402 challenge: header mirrors body, requestId is bound to X-Payer and reproducible from the token', async () => {
  const chain = fakeChain();
  await withServer(chain, async (base) => {
    const { r, body, x } = await quote(base);
    assert.equal(r.status, 402);
    assert.deepEqual(JSON.parse(Buffer.from(r.headers.get('payment-required'), 'base64').toString()), body);
    assert.equal(body.x402Version, 2);
    assert.equal(x.scheme, 'arc-paywall');
    assert.equal(x.network, 'eip155:31337');
    assert.equal(x.amount, PRICE.toString());
    assert.equal(x.payTo, CONTRACT);
    assert.equal(x.extra.endpointId, '1');
    assert.equal(payerOf(x.extra.requestId), PAYER);
    const again = computeRequestId({ chainId: 31337, contract: CONTRACT, endpointId: 1n, payer: PAYER, resource: x.extra.resource, token: x.extra.token });
    assert.equal(again.requestId, x.extra.requestId);
    assert.equal(x.extra.resource, 'GET /v1/weather?city=Paris');
    const q2 = await quote(base);
    assert.notEqual(q2.x.extra.token, x.extra.token, 'fresh token per challenge');
    assert.notEqual(q2.x.extra.requestId, x.extra.requestId);
  });
});

test('X-Payer is required by default; PAYWALL_ALLOW_UNBOUND=1 gives an unbound requestId', async () => {
  const chain = fakeChain();
  await withServer(chain, async (base) => {
    const { r, body } = await quote(base, '/v1/weather?city=Paris', null);
    assert.equal(r.status, 400);
    assert.equal(body.error, 'payer_required');
    assert.equal(chain.st.calls.length, 0);
  });
  await withServer(chain, async (base) => {
    const { x } = await quote(base, '/v1/weather?city=Paris', null);
    assert.equal(payerOf(x.extra.requestId), '0x' + '0'.repeat(40));
  }, { allowUnbound: true });
});

test('"New+York" and "New%20York" are the same resource', async () => {
  const chain = fakeChain();
  await withServer(chain, async (base) => {
    const a = await quote(base, '/v1/weather?city=New+York');
    const b = await quote(base, '/v1/weather?city=New%20York');
    assert.equal(a.x.extra.resource, 'GET /v1/weather?city=New%20York');
    assert.equal(b.x.extra.resource, a.x.extra.resource);
  });
});

test('bad input is refused BEFORE any quote or chain call', async () => {
  const chain = fakeChain();
  await withServer(chain, async (base) => {
    for (const path of ['/v1/weather', '/v1/weather?city=', '/v1/weather?city=Paris&x=1', '/v1/weather?city=%3Cscript%3E',
      '/v1/weather?city=' + 'a'.repeat(41), '/v1/weather?city=1234', '/v1/weather?city=Paris&city=Rome']) {
      const r = await fetch(base + path);
      assert.equal(r.status, 400, path);
    }
    let r = await fetch(base + '/v1/weather?city=Paris', { headers: { 'x-payer': '0x1234' } });
    assert.equal(r.status, 400);
    r = await fetch(base + '/v1/weather?city=Paris', { headers: { 'x-paywall-token': '0x' + '11'.repeat(32) } });
    assert.equal(r.status, 400, 'token without tx');
    r = await fetch(base + '/v1/weather?city=Paris', { headers: { 'x-paywall-token': 'nope', 'x-paywall-tx': '0x' + '11'.repeat(32) } });
    assert.equal(r.status, 400);
    r = await fetch(base + '/v1/weather?city=Paris', { method: 'POST', body: 'x' });
    assert.equal(r.status, 405);
    r = await fetch(base + '/nope');
    assert.equal(r.status, 404);
    assert.equal(chain.st.calls.length, 0, 'no RPC call for bad input');
  });
});

test('oversized headers are rejected by the HTTP layer (431)', async () => {
  const chain = fakeChain();
  await withServer(chain, async (base) => {
    const r = await fetch(base + '/v1/weather?city=Paris', { headers: { 'x-junk': 'a'.repeat(20_000) } });
    assert.equal(r.status, 431);
  });
});

test('inactive endpoint -> 503, chain down -> 502 (no quote)', async () => {
  const chain = fakeChain();
  chain.st.endpoint.active = false;
  await withServer(chain, async (base) => {
    assert.equal((await quote(base)).r.status, 503);
  });
  const down = fakeChain();
  down.st.down = true;
  await withServer(down, async (base) => {
    assert.equal((await quote(base)).r.status, 502);
  });
});

/* ---------------------------------------------------------------- paid retries */
async function paidRetry(base, x, tx, payer = PAYER, path = '/v1/weather?city=Paris') {
  const h = { 'x-paywall-token': x.extra.token, 'x-paywall-tx': tx };
  if (payer) h['x-payer'] = payer;
  const r = await fetch(base + path, { headers: h });
  return { r, body: await r.json() };
}
const TX = '0x' + 'ab'.repeat(32);

test('happy path: paid -> 200 with data and X-Paywall-Receipt; the token is never logged', async () => {
  const chain = fakeChain();
  await withServer(chain, async (base, logs) => {
    const { x } = await quote(base);
    chain.pay({ tx: TX, requestId: x.extra.requestId });
    const { r, body } = await paidRetry(base, x, TX);
    assert.equal(r.status, 200);
    assert.equal(body.data.city, 'Paris');
    assert.equal(body.data.sample, true);
    assert.equal(body.payment.amount, PRICE.toString());
    assert.equal(body.payment.payer, PAYER);
    const rec = JSON.parse(Buffer.from(r.headers.get('x-paywall-receipt'), 'base64').toString());
    assert.equal(rec.requestId, x.extra.requestId);
    assert.equal(rec.tx, TX);
    const all = JSON.stringify(logs);
    assert.ok(!all.includes(x.extra.token.slice(2)), 'token must not appear in logs');
    assert.ok(logs.some((l) => l.s === 200 && l.paid === PRICE.toString()));
  });
});

test('unbound request (opt-in): anyone may pay, the token holder collects', async () => {
  const chain = fakeChain();
  await withServer(chain, async (base) => {
    const { x } = await quote(base, '/v1/weather?city=Paris', null);
    chain.pay({ tx: TX, requestId: x.extra.requestId, payer: PAYER2 });
    const { r } = await paidRetry(base, x, TX, null);
    assert.equal(r.status, 200);
  }, { allowUnbound: true });
});

test('a payment cannot be reused for another resource, endpoint, contract or payer', async () => {
  const chain = fakeChain();
  await withServer(chain, async (base) => {
    const { x } = await quote(base);
    chain.pay({ tx: TX, requestId: x.extra.requestId });
    let res = await paidRetry(base, x, TX, PAYER, '/v1/weather?city=Rome');   // same token, other city
    assert.equal(res.r.status, 402);
    assert.equal(res.body.error, 'no_matching_payment');
    res = await paidRetry(base, x, TX, PAYER2);                                 // claims to be someone else
    assert.equal(res.body.error, 'no_matching_payment');
    const x2 = (await quote(base, '/v1/weather?city=Lima')).x;
    const tx2 = '0x' + 'cd'.repeat(32);
    chain.pay({ tx: tx2, requestId: x2.extra.requestId, endpointId: 2n, record: false });   // paid endpoint 2
    res = await paidRetry(base, x2, tx2, PAYER, '/v1/weather?city=Lima');
    assert.equal(res.body.error, 'no_matching_payment');
    const x3 = (await quote(base, '/v1/weather?city=Oslo')).x;
    const tx3 = '0x' + 'ce'.repeat(32);
    chain.pay({ tx: tx3, requestId: x3.extra.requestId, emitter: OTHER_CONTRACT });           // look-alike contract
    res = await paidRetry(base, x3, tx3, PAYER, '/v1/weather?city=Oslo');
    assert.equal(res.body.error, 'no_matching_payment');
  });
});

test('payer mismatch in the event is refused even if the requestId matches', async () => {
  const chain = fakeChain();
  await withServer(chain, async (base) => {
    const { x } = await quote(base);
    chain.pay({ tx: TX, requestId: x.extra.requestId, payer: PAYER2 });
    const { body } = await paidRetry(base, x, TX);
    assert.equal(body.error, 'payer_mismatch');
  });
});

test('not mined yet / reverted / waiting for confirmations', async () => {
  const chain = fakeChain();
  await withServer(chain, async (base) => {
    const { x } = await quote(base);
    let res = await paidRetry(base, x, TX);
    assert.equal(res.r.status, 402);
    assert.equal(res.body.error, 'payment_not_found');
    assert.equal(res.body.retryable, true);
    assert.equal(res.r.headers.get('retry-after'), '1');
    chain.pay({ tx: TX, requestId: x.extra.requestId, status: '0x0' });
    res = await paidRetry(base, x, TX);
    assert.equal(res.body.error, 'payment_failed');
  });
  const c2 = fakeChain();
  await withServer(c2, async (base) => {
    const { x } = await quote(base);
    c2.pay({ tx: TX, requestId: x.extra.requestId });
    let res = await paidRetry(base, x, TX);
    assert.equal(res.body.error, 'awaiting_confirmations');
    c2.st.block += 2n;
    res = await paidRetry(base, x, TX);
    assert.equal(res.r.status, 200, '3 confirmations reached');
  }, { minConfirmations: 3 });
});

test('refunded payments are not served; old payments get 410; getPayment must agree with the event', async () => {
  const chain = fakeChain();
  await withServer(chain, async (base) => {
    const { x } = await quote(base);
    chain.pay({ tx: TX, requestId: x.extra.requestId });
    chain.st.payments[x.extra.requestId].refunded = true;
    assert.equal((await paidRetry(base, x, TX)).body.error, 'payment_refunded');
    chain.st.payments[x.extra.requestId].refunded = false;
    chain.st.payments[x.extra.requestId].paidAt = NOW - 3601;
    const old = await paidRetry(base, x, TX);
    assert.equal(old.r.status, 410);
    chain.st.payments[x.extra.requestId].paidAt = NOW - 5;
    chain.st.payments[x.extra.requestId].amount = PRICE - 1n;
    assert.equal((await paidRetry(base, x, TX)).body.error, 'inconsistent_payment');
  });
});

test('idempotent retries: served at most maxServes times, then 429', async () => {
  const chain = fakeChain();
  await withServer(chain, async (base) => {
    const { x } = await quote(base);
    chain.pay({ tx: TX, requestId: x.extra.requestId });
    for (let i = 0; i < 3; i++) assert.equal((await paidRetry(base, x, TX)).r.status, 200);
    const calls = chain.st.calls.length;
    const fourth = await paidRetry(base, x, TX);
    assert.equal(chain.st.calls.length, calls, 'checked before any chain read');
    assert.equal(fourth.r.status, 429);
    assert.equal(fourth.body.error, 'already_served');
  });
});

test('RPC failure during verification -> 502 retryable', async () => {
  const chain = fakeChain();
  await withServer(chain, async (base) => {
    const { x } = await quote(base);
    chain.st.down = true;
    const res = await paidRetry(base, x, TX);
    assert.equal(res.r.status, 502);
    assert.equal(res.body.retryable, true);
    assert.ok(!JSON.stringify(res.body).includes('ECONNREFUSED'), 'RPC error text stays in the logs');
  });
});

test('rate limits: quotes per IP per minute', async () => {
  const chain = fakeChain();
  await withServer(chain, async (base) => {
    for (let i = 0; i < 5; i++) assert.equal((await quote(base)).r.status, 402);
    const r = await fetch(base + '/v1/weather?city=Paris', { headers: { 'x-payer': PAYER } });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
  }, {}, { quoteLimit: 5 });
  let t = 0;
  const lim = rateLimiter(2, 1000, () => t);
  assert.equal(lim('a'), 0); assert.equal(lim('a'), 0); assert.ok(lim('a') > 0); assert.equal(lim('b'), 0);
  t = 1001;
  assert.equal(lim('a'), 0, 'window resets');
});

test('free routes', async () => {
  const chain = fakeChain();
  await withServer(chain, async (base) => {
    const h = await (await fetch(base + '/health')).json();
    assert.equal(h.ok, true);
    assert.equal(h.price, PRICE.toString());
    const wk = await (await fetch(base + '/.well-known/arc-paywall')).json();
    assert.equal(wk.protocol, 'arc-paywall/v1');
    const opt = await fetch(base + '/v1/weather', { method: 'OPTIONS' });
    assert.equal(opt.status, 204);
  });
});

test('sample data is deterministic and labelled', () => {
  assert.deepEqual(sampleWeather('Paris'), sampleWeather('Paris'));
  assert.equal(sampleWeather('Paris').sample, true);
});

/* ---------------------------------------------------------------- config */
test('config validation', () => {
  const ok = { PAYWALL_NETWORK: 'mainnet', PAYWALL_CONTRACT: CONTRACT, PAYWALL_ENDPOINT_ID: '3' };
  const c = loadConfig(ok);
  assert.equal(c.chainId, 5042);
  assert.equal(c.rpcUrl, 'https://rpc.mainnet.arc.io');
  assert.equal(c.minConfirmations, 1);
  assert.equal(c.allowUnbound, false);
  assert.equal(c.trustProxy, 0);
  assert.equal(c.tokenKey, null);
  assert.equal(loadConfig(Object.assign({}, ok, { PAYWALL_TOKEN_KEY: 'ab'.repeat(32), PAYWALL_TRUST_PROXY: '1' })).tokenKey.length, 32);
  for (const bad of [{ PAYWALL_NETWORK: 'base' }, { PAYWALL_CONTRACT: '0x12' }, { PAYWALL_ENDPOINT_ID: '0' }, { PAYWALL_ENDPOINT_ID: '-1' },
    { PAYWALL_MIN_CONFIRMATIONS: '0' }, { PAYWALL_SERVE_WINDOW: '10' }, { PAYWALL_RPC: 'https://evil.example' },
    { PAYWALL_NETWORK: 'local' }, { PAYWALL_NETWORK: 'local', PAYWALL_RPC: 'http://10.0.0.1:8545' },
    { PAYWALL_TOKEN_KEY: 'abc' }, { PAYWALL_EXPECT_PAYEE: '0x1' }, { PAYWALL_TRUST_PROXY: '9' }, { PAYWALL_ALLOW_UNBOUND: 'yes' }]) {
    assert.throws(() => loadConfig(Object.assign({}, ok, bad)), JSON.stringify(bad));
  }
});

/* ---------------------------------------------------------------- the RPC client */
test('makeRpc refuses hosts outside the Arc RPC allowlist', () => {
  assert.throws(() => makeRpc({ url: 'https://evil.example/' }), /not allowed/);
  assert.throws(() => makeRpc({ url: 'http://rpc.mainnet.arc.io/' }), /not allowed/);
  assert.throws(() => makeRpc({ url: 'http://127.0.0.1:8545' }), /not allowed/);
  assert.throws(() => makeRpc({ url: 'https://user:pw@rpc.mainnet.arc.io/' }), /not allowed/);
  makeRpc({ url: 'https://rpc.testnet.arc.io' });
  makeRpc({ url: 'http://127.0.0.1:8545', allowLocal: true });
});

test('makeRpc: timeout, size cap, redirect refusal, JSON-RPC errors', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/slow') return; /* never answers */
    if (req.url === '/big') { res.writeHead(200); res.end('{"result":"' + 'a'.repeat(2_000_000) + '"}'); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); res.end(); return; }
    if (req.url === '/err') { res.writeHead(200); res.end('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"execution reverted"}}'); return; }
    if (req.url === '/garbage') { res.writeHead(200); res.end('<html>'); return; }
    res.writeHead(200); res.end('{"jsonrpc":"2.0","id":1,"result":"0x2a"}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const p = srv.address().port;
  const mk = (path, extra = {}) => makeRpc(Object.assign({ url: `http://127.0.0.1:${p}${path}`, allowLocal: true }, extra));
  try {
    assert.equal(await mk('/ok')('eth_blockNumber', []), '0x2a');
    const t0 = Date.now();
    await assert.rejects(mk('/slow', { timeoutMs: 300 })('eth_blockNumber', []), /timeout/);
    assert.ok(Date.now() - t0 < 2000);
    await assert.rejects(mk('/big')('eth_blockNumber', []), /too large/);
    await assert.rejects(mk('/redirect')('eth_blockNumber', []));
    await assert.rejects(mk('/err')('eth_call', []), /execution reverted/);
    await assert.rejects(mk('/garbage')('eth_call', []), /invalid JSON/);
  } finally {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
});

test('verifyPayment input validation', async () => {
  const chain = fakeChain();
  const v = await verifyPayment({ rpc: chain.rpc, cfg: cfgFor(), txHash: 'nope', requestId: '0x' + '00'.repeat(32), nowSec: NOW });
  assert.equal(v.status, 400);
  assert.equal(chain.st.calls.length, 0);
  assert.equal(toHex(new Uint8Array([1, 255])), '0x01ff');
});

test('quotes follow a price change within 1 s; concurrent quotes share one chain read', async () => {
  const chain = fakeChain();
  await withServer(chain, async (base) => {
    assert.equal((await quote(base)).x.amount, PRICE.toString());
    chain.st.endpoint.price = 2n * PRICE;
    clock.ms += 1001;
    assert.equal((await quote(base)).x.amount, (2n * PRICE).toString());
    chain.st.endpoint.active = false;
    clock.ms += 1001;
    assert.equal((await quote(base)).r.status, 503);
    chain.st.endpoint.active = true;
    clock.ms += 1001;
    const before = chain.st.calls.filter((c) => c === 'eth_call').length;
    const rs = await Promise.all(Array.from({ length: 8 }, () => quote(base)));
    assert.ok(rs.every((q) => q.r.status === 402));
    assert.equal(chain.st.calls.filter((c) => c === 'eth_call').length - before, 1, 'one eth_call for 8 concurrent quotes');
  });
});

test('proxy: the client IP is taken from the RIGHT of X-Forwarded-For, so rotating fake entries does not bypass limits', async () => {
  const chain = fakeChain();
  await withServer(chain, async (base) => {
    let limited = 0;
    for (let i = 0; i < 8; i++) {
      const r = await fetch(base + '/v1/weather?city=Paris', { headers: { 'x-payer': PAYER, 'x-forwarded-for': `10.0.0.${i}, 9.9.9.9` } });
      if (r.status === 429) limited++;
    }
    assert.equal(limited, 3, '5 allowed, the rest limited, whatever the client puts on the left');
  }, { trustProxy: 1 }, { quoteLimit: 5 });
  const req = (xff, ra = '127.0.0.1') => ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: ra } });
  assert.equal(clientIp(req('1.1.1.1, 2.2.2.2'), 1), '2.2.2.2');
  assert.equal(clientIp(req('1.1.1.1, 2.2.2.2, 3.3.3.3'), 2), '2.2.2.2');
  assert.equal(clientIp(req('1.1.1.1'), 0), '127.0.0.1', 'not trusted without PAYWALL_TRUST_PROXY');
  assert.equal(clientIp(req(''), 1), '127.0.0.1');
});

test('rate-limit keys: IPv6 grouped by /64, IPv4-mapped unwrapped; full limiter evicts the oldest key only', () => {
  assert.equal(ipKey('2001:db8:1:2:3:4:5:6'), ipKey('2001:db8:1:2:aaaa::1'));
  assert.notEqual(ipKey('2001:db8:1:2::1'), ipKey('2001:db8:1:3::1'));
  assert.equal(ipKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(ipKey('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(ipKey('1.2.3.4'), '1.2.3.4');
  const lim = rateLimiter(1, 60_000, () => 0, 3);
  for (const k of ['a', 'b', 'c']) assert.equal(lim(k), 0);
  assert.ok(lim('c') > 0);
  assert.equal(lim('d'), 0);           /* evicts 'a' only */
  assert.ok(lim('b') > 0, 'b is still limited (no global reset)');
  assert.equal(lim('a'), 0, 'a was the oldest and was evicted');
});

test('global verification cap: 503 busy (retryable) instead of flooding the RPC', async () => {
  const chain = fakeChain();
  await withServer(chain, async (base) => {
    const { x } = await quote(base);
    chain.pay({ tx: TX, requestId: x.extra.requestId });
    const res = await Promise.all([1, 2, 3].map(() => paidRetry(base, x, TX)));
    const codes = res.map((r) => r.r.status).sort();
    assert.deepEqual(codes, [200, 200, 503]);
    assert.equal(res.find((r) => r.r.status === 503).body.retryable, true);
  }, {}, { globalVerifyPerSec: 2 });
});

test('optional server-issued tokens (PAYWALL_TOKEN_KEY): client-made or re-targeted tokens are refused', async () => {
  const chain = fakeChain();
  const key = Buffer.from('11'.repeat(32), 'hex');
  await withServer(chain, async (base) => {
    const { x } = await quote(base);
    chain.pay({ tx: TX, requestId: x.extra.requestId });
    assert.equal((await paidRetry(base, x, TX)).r.status, 200, 'server token accepted');
    const forged = { extra: Object.assign({}, x.extra, { token: '0x' + '42'.repeat(32) }) };
    let res = await paidRetry(base, forged, TX);
    assert.equal(res.body.error, 'unknown_token');
    res = await paidRetry(base, x, TX, PAYER, '/v1/weather?city=Rome');   // Paris token for Rome
    assert.equal(res.body.error, 'unknown_token');
    assert.equal(chain.st.calls.filter((c) => c === 'eth_getTransactionReceipt').length, 1, 'refused before any chain read');
  }, { tokenKey: key });
  const ctx = 'ctx';
  const t = issueToken(key, ctx, Buffer.alloc(16, 7));
  assert.ok(tokenOk(key, ctx, t));
  assert.ok(!tokenOk(key, 'other', t));
  assert.ok(!tokenOk(Buffer.alloc(32, 1), ctx, t));
});

test('expected payee pin: a payment that credited someone else is refused', async () => {
  const chain = fakeChain();
  await withServer(chain, async (base) => {
    const { x } = await quote(base);
    chain.pay({ tx: TX, requestId: x.extra.requestId });
    assert.equal((await paidRetry(base, x, TX)).body.error, 'wrong_payee');
  }, { expectPayee: PAYER2 });
});

test('a lagging node (getPayment not visible yet) is a retryable wait, not a final refusal', async () => {
  const chain = fakeChain();
  await withServer(chain, async (base) => {
    const { x } = await quote(base);
    chain.pay({ tx: TX, requestId: x.extra.requestId, record: false });
    const res = await paidRetry(base, x, TX);
    assert.equal(res.body.error, 'payment_not_visible_yet');
    assert.equal(res.body.retryable, true);
  });
});

test('/health is rate-limited and an RPC outage is not amplified (failure cached 2 s)', async () => {
  const chain = fakeChain();
  chain.st.down = true;
  await withServer(chain, async (base) => {
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await fetch(base + '/health')).status);
    assert.deepEqual(codes, [502, 502, 502, 429]);
    assert.equal(chain.st.calls.length, 1, 'one RPC call for three health checks during an outage');
  }, {}, { quoteLimit: 3 });
});

test('server limits: connection cap and fast timeout checks', async () => {
  const chain = fakeChain();
  await withServer(chain, async (base, logs, server) => {
    assert.equal(server.maxConnections, 512);
    assert.equal(server.headersTimeout, 10_000);
  });
});
