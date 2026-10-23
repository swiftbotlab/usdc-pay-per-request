/**
 * In-page "Weather API" that mimics server.mjs behaviour for the demo.
 * This runs entirely in the browser — it is a demo. For production use
 * verifier/server.mjs.
 */

import {
  createPublicClient, http, type Hex, type PublicClient,
  parseEther, parseEventLogs,
} from 'viem';
import type { Chain } from 'viem';
import { ABI } from '../config/abi';
import { computeRequestId, buildChallenge, sampleWeather, payerOf, type PaywallChallenge } from './paywall';

/** Log entry for the demo live log. */
export interface LogEntry {
  id: number;
  voice: 'agent' | 'api' | 'contract';
  msg: string;
  link?: string;
  linkLabel?: string;
  durationMs?: number;
  error?: boolean;
}

export interface DemoApiConfig {
  chainId: number;
  chain: Chain;
  contractAddress: Hex;
  endpointId: bigint;
  price: bigint;
  explorer: string;
}

export type ApiResponse =
  | { status: 402; body: PaywallChallenge; token: Hex; requestId: Hex }
  | { status: 200; body: ReturnType<typeof sampleWeather>; paymentInfo: { payer: string; amount: bigint; tx: string } }
  | { status: number; body: Record<string, unknown> };

let _logId = 0;

function makeLog(
  voice: LogEntry['voice'],
  msg: string,
  extra?: Partial<LogEntry>
): LogEntry {
  return { id: ++_logId, voice, msg, ...extra };
}

/**
 * Simulates the server-side weather API.
 * Returns a 402 on first call (no token), then verifies payment on retry.
 */
export async function callWeatherApi(params: {
  cfg: DemoApiConfig;
  city: string;
  payer: Hex;
  token?: Hex;
  txHash?: Hex;
  publicClient: PublicClient;
  onLog: (e: LogEntry) => void;
}): Promise<ApiResponse> {
  const { cfg, city, payer, token, txHash, publicClient, onLog } = params;
  const resource = `GET /v1/weather?city=${encodeURIComponent(city)}`;
  const t0 = Date.now();

  if (!token) {
    // Phase 1: no token → issue 402
    onLog(makeLog('api', `Received ${resource} from agent`, { voice: 'api' }));
    const randomToken = crypto.getRandomValues(new Uint8Array(32));
    const tok = ('0x' + Array.from(randomToken).map(b => b.toString(16).padStart(2, '0')).join('')) as Hex;

    const { requestId } = computeRequestId({
      chainId: cfg.chainId,
      contract: cfg.contractAddress,
      endpointId: cfg.endpointId,
      payer,
      resource,
      token: tok,
    });

    onLog(makeLog('api', `Generated requestId bound to ${payer.slice(0, 8)}… (payerOf check: ${payerOf(requestId).slice(0, 8)}… = payer ✓)`, { voice: 'api' }));
    onLog(makeLog('api', `Returning 402 — price ${formatE(cfg.price)} USDC, payTo contract`, { durationMs: Date.now() - t0 }));

    const body = buildChallenge({
      chainId: cfg.chainId,
      contract: cfg.contractAddress,
      endpointId: cfg.endpointId,
      price: cfg.price,
      resource,
      url: `/v1/weather?city=${encodeURIComponent(city)}`,
      payer,
      token: tok,
      requestId,
      explorer: cfg.explorer,
    });

    return { status: 402, body, token: tok, requestId };
  }

  // Phase 2: token + tx → verify (mirrors server.mjs verifyPayment exactly)
  onLog(makeLog('api', `Received retry with X-Paywall-Token + X-Paywall-Tx`, { voice: 'api' }));
  const { requestId } = computeRequestId({ chainId: cfg.chainId, contract: cfg.contractAddress, endpointId: cfg.endpointId, payer, resource, token });

  if (!txHash) {
    return { status: 400, body: { error: 'missing_tx', message: 'X-Paywall-Tx required' } };
  }

  // 1. Fetch receipt
  onLog(makeLog('api', `Checking tx receipt on-chain…`, { voice: 'api' }));
  const t1 = Date.now();
  let receipt;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  } catch {
    onLog(makeLog('api', `RPC error checking receipt`, { error: true }));
    return { status: 502, body: { error: 'rpc_unavailable' } };
  }

  if (!receipt) return { status: 402, body: { error: 'payment_not_found', message: 'No receipt yet' } };
  if (receipt.status !== 'success') return { status: 402, body: { error: 'payment_failed', message: 'Tx reverted' } };

  onLog(makeLog('contract', `Receipt found — block ${receipt.blockNumber}, status success`, { durationMs: Date.now() - t1, link: `${cfg.explorer}/tx/${txHash}`, linkLabel: 'View tx' }));

  // 2. Decode Paid events with parseEventLogs (handles ABI topic layout correctly)
  //    Paid: topics[0]=sig, topics[1]=endpointId, topics[2]=requestId, topics[3]=payer
  const allPaid = parseEventLogs({ abi: ABI, eventName: 'Paid', logs: receipt.logs });
  const contractPaid = allPaid.filter(l => l.address.toLowerCase() === cfg.contractAddress.toLowerCase());

  const matchingLogs = contractPaid.filter(l => {
    const a = l.args as { endpointId?: bigint; requestId?: Hex; payer?: string; amount?: bigint };
    return (
      a.endpointId === cfg.endpointId &&
      a.requestId?.toLowerCase() === requestId.toLowerCase() &&
      a.payer?.toLowerCase() === payer.toLowerCase()
    );
  });

  if (matchingLogs.length !== 1) {
    onLog(makeLog('api', `No matching Paid event (endpointId=${cfg.endpointId}, requestId=${requestId.slice(0,10)}…, payer=${payer.slice(0,8)}…) — found ${matchingLogs.length}`, { error: true }));
    return { status: 402, body: { error: 'no_matching_payment', message: 'No Paid event matching this endpoint + requestId + payer' } };
  }

  const paidLog = matchingLogs[0];
  const logArgs = paidLog.args as { endpointId?: bigint; requestId?: Hex; payer?: string; amount?: bigint };
  onLog(makeLog('contract', `Paid event: endpointId=${cfg.endpointId}, requestId matches, payer confirmed`, { voice: 'contract' }));

  // 3. Require >= 1 confirmation
  let latestBlock: bigint;
  try {
    latestBlock = await publicClient.getBlockNumber();
  } catch {
    return { status: 502, body: { error: 'rpc_unavailable' } };
  }
  const confirmations = latestBlock - receipt.blockNumber + 1n;
  if (confirmations < 1n) {
    onLog(makeLog('contract', `Only ${confirmations} confirmations — waiting`, { error: true }));
    return { status: 402, body: { error: 'insufficient_confirmations', message: `${confirmations} confirmation(s), need >= 1` } };
  }
  onLog(makeLog('contract', `${confirmations} confirmation(s)`, { voice: 'contract' }));

  // 4. getPayment(requestId) — final ground truth
  const t2 = Date.now();
  let payment;
  try {
    payment = await publicClient.readContract({
      address: cfg.contractAddress, abi: ABI, functionName: 'getPayment', args: [requestId],
    });
  } catch {
    return { status: 502, body: { error: 'rpc_unavailable' } };
  }

  onLog(makeLog('contract', `getPayment: payer=${payment.payer.slice(0, 8)}…, endpointId=${payment.endpointId}, refunded=${payment.refunded}, amount=${formatE(payment.amount)} USDC`, { durationMs: Date.now() - t2 }));

  const ZERO_ADDR = '0x' + '0'.repeat(40);
  if (payment.payer === ZERO_ADDR) return { status: 402, body: { error: 'payment_not_visible_yet' } };
  if (payment.payer.toLowerCase() !== payer.toLowerCase()) return { status: 402, body: { error: 'payer_mismatch' } };
  if (payment.endpointId !== cfg.endpointId) return { status: 402, body: { error: 'endpoint_mismatch' } };
  if (payment.refunded) return { status: 402, body: { error: 'payment_refunded', message: 'Provider refunded this request' } };
  if (logArgs.amount !== undefined && payment.amount !== logArgs.amount) return { status: 402, body: { error: 'amount_mismatch' } };

  onLog(makeLog('api', `Payment verified — serving response`, { durationMs: Date.now() - t0 }));

  return {
    status: 200,
    body: sampleWeather(city),
    paymentInfo: { payer, amount: payment.amount, tx: txHash },
  };
}

function formatE(v: bigint): string {
  const s = (Number(v) / 1e18).toFixed(4).replace(/\.?0+$/, '');
  return s || '0';
}
