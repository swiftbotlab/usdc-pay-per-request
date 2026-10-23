/**
 * arc-paywall/v1 — browser-side protocol helpers (viem implementation).
 *
 * Mirrors the logic in verifier/lib/paywall.mjs exactly so the in-page demo
 * and any client code produce the same requestIds and 402 challenge shapes
 * as the real Node server.
 *
 * Unit check (from the spec):
 *   payer   = 0x2222222222222222222222222222222222222222
 *   chainId = 5042
 *   contract= 0x1111111111111111111111111111111111111111
 *   endpointId = 1
 *   resource   = "GET /v1/weather?city=Paris"
 *   token      = 0x33 repeated 32 times
 *   → requestId = 0x222222222222222222222222222222222222222291fd801985e2bd8a9a5903dd
 */

import { keccak256, encodeAbiParameters, parseAbiParameters, type Hex } from 'viem';

export const DOMAIN_TAG = 'arc-paywall/v1';

// Pre-compute the domain separator (keccak256 of the domain tag UTF-8 bytes)
const DOMAIN_HASH: Hex = keccak256(new TextEncoder().encode(DOMAIN_TAG) as Uint8Array);

/**
 * Compute the digest and requestId for a pay-per-request call.
 *
 * digest = keccak256(abi.encode(
 *   bytes32 DOMAIN,
 *   uint256 chainId,
 *   address contract,
 *   uint256 endpointId,
 *   address payer,
 *   bytes32 keccak256(utf8(resource)),
 *   bytes32 token
 * ))
 * requestId = payer[0..20] || digest[20..32]
 */
export function computeRequestId(params: {
  chainId: number;
  contract: Hex;
  endpointId: bigint;
  payer: Hex | null;
  resource: string;
  token: Hex;
}): { digest: Hex; requestId: Hex } {
  const { chainId, contract, endpointId, payer, resource, token } = params;
  const zeroAddr = ('0x' + '0'.repeat(40)) as Hex;
  const p: Hex = payer ? (payer.toLowerCase() as Hex) : zeroAddr;

  const resourceHash: Hex = keccak256(new TextEncoder().encode(resource) as Uint8Array);

  const encoded = encodeAbiParameters(
    parseAbiParameters('bytes32, uint256, address, uint256, address, bytes32, bytes32'),
    [DOMAIN_HASH, BigInt(chainId), contract, endpointId, p, resourceHash, token],
  );
  const digest = keccak256(encoded);

  // requestId = payer (20 bytes) || digest[20..32] (12 bytes)
  const payerHex = p.slice(2).toLowerCase(); // 40 hex chars = 20 bytes
  const digestSuffix = digest.slice(2 + 40);  // skip 0x + 40 chars = last 12 bytes
  const requestId = ('0x' + payerHex + digestSuffix) as Hex;

  return { digest, requestId };
}

/**
 * Extract the payer binding from a requestId.
 * Top 20 bytes = bound payer address. Zero address = anyone may pay.
 */
export function payerOf(requestId: Hex): Hex {
  return ('0x' + requestId.slice(2, 42).toLowerCase()) as Hex;
}

/** True when the requestId is payer-bound (top 20 bytes non-zero). */
export function isBound(requestId: Hex): boolean {
  return requestId.slice(2, 42) !== '0'.repeat(40);
}

/** Shape of a 402 challenge returned by the server. */
export interface PaywallChallenge {
  x402Version: number;
  error: string;
  resource: { url: string; method: string; description: string; mimeType: string };
  accepts: Array<{
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra: {
      protocol: string;
      endpointId: string;
      requestId: Hex;
      token: Hex;
      payer: string | null;
      resource: string;
      call: string;
      minConfirmations: number;
      retryWith: Record<string, string>;
      explorer: string | null;
    };
  }>;
}

/** Build the 402 challenge JSON (identical shape to server.mjs). */
export function buildChallenge(params: {
  chainId: number;
  contract: Hex;
  endpointId: bigint;
  price: bigint;
  resource: string;
  url: string;
  payer: Hex | null;
  token: Hex;
  requestId: Hex;
  explorer: string | null;
  serveWindow?: number;
  minConfirmations?: number;
}): PaywallChallenge {
  const {
    chainId, contract, endpointId, price, resource, url,
    payer, token, requestId, explorer,
    serveWindow = 3600, minConfirmations = 1,
  } = params;
  const method = resource.split(' ')[0];
  return {
    x402Version: 2,
    error: 'payment required',
    resource: { url, method, description: 'Current weather for a city (sample data), paid per request in USDC on Arc.', mimeType: 'application/json' },
    accepts: [{
      scheme: 'arc-paywall',
      network: `eip155:${chainId}`,
      asset: 'native USDC (18 decimals)',
      amount: price.toString(),
      payTo: contract.toLowerCase(),
      maxTimeoutSeconds: serveWindow,
      extra: {
        protocol: DOMAIN_TAG,
        endpointId: endpointId.toString(),
        requestId,
        token,
        payer: payer ? payer.toLowerCase() : null,
        resource,
        call: 'pay(uint256 endpointId, bytes32 requestId) with value = amount',
        minConfirmations,
        retryWith: {
          'X-Payer': payer ? payer.toLowerCase() : '<your address, optional>',
          'X-Paywall-Token': token,
          'X-Paywall-Tx': '<pay tx hash>',
        },
        explorer,
      },
    }],
  };
}

/** Sample weather data derived deterministically from city name (mirrors server.mjs). */
export function sampleWeather(city: string): {
  city: string; sample: boolean; temperatureC: number; conditions: string;
  humidityPct: number; windKmh: number; note: string;
} {
  const encoder = new TextEncoder();
  const bytes = encoder.encode('weather:' + city.toLowerCase());
  const h = keccak256(bytes as Uint8Array);
  const b = (i: number) => parseInt(h.slice(2 + 2 * i, 4 + 2 * i), 16);
  const conditions = ['clear', 'partly cloudy', 'cloudy', 'light rain', 'windy', 'fog'];
  return {
    city,
    sample: true,
    temperatureC: (b(0) % 40) - 5,
    conditions: conditions[b(1) % conditions.length],
    humidityPct: 30 + (b(2) % 60),
    windKmh: b(3) % 35,
    note: 'Sample data derived from the city name: this demo API sells the payment flow, not forecasts.',
  };
}

// ── Unit check (assert at module load in dev) ──────────────────────────────
const _CHECK_PAYER  = '0x2222222222222222222222222222222222222222' as Hex;
const _CHECK_DIGEST = ('0x' + '33'.repeat(32)) as Hex;
const _EXPECTED_RID = '0x222222222222222222222222222222222222222291fd801985e2bd8a9a5903dd' as Hex;
const { requestId: _got } = computeRequestId({
  chainId: 5042,
  contract: '0x1111111111111111111111111111111111111111',
  endpointId: 1n,
  payer: _CHECK_PAYER,
  resource: 'GET /v1/weather?city=Paris',
  token: _CHECK_DIGEST,
});
if (_got !== _EXPECTED_RID) {
  throw new Error(`paywall.ts unit check FAILED: got ${_got}, expected ${_EXPECTED_RID}`);
}
