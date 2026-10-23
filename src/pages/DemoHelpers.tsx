/**
 * DemoPage sub-components: ReplayPanel, CheatStep, Step6, shared UI.
 * Kept in a separate file to stay under the 400-line-per-message limit.
 */
import { useState, useEffect } from 'react';
import React from 'react';
import {
  useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt,
  usePublicClient,
} from 'wagmi';
import { toast } from 'sonner';
import {
  createPublicClient, createWalletClient, http, parseEther,
  type Hex, type Account,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { type NetworkKey, NETWORKS } from '../config/networks';
import { ABI } from '../config/abi';
import { formatUsdc, formatAddr, formatB32, txUrl } from '../lib/format';
import { decodeContractError } from '../lib/errors';
import { getGasOverrides } from '../lib/gas';
import { computeRequestId } from '../lib/paywall';

// ─────────────────────────────────────────────
// Replay Panel (F1)
// ─────────────────────────────────────────────

interface ReplayEvent {
  blockNumber: bigint;
  txHash: string;
  type: 'Paid' | 'Refunded' | 'PriceChanged' | 'ActiveSet' | 'Withdrawn';
  requestId?: string;
  payer?: string;
  amount?: bigint;
}

interface EpTotals {
  paidCount: bigint;
  totalPaid: bigint;
  totalRefunded: bigint;
  refundCount: bigint;
}

export function ReplayPanel({ net, endpointId, events, loading, epData, payeeCredit, onReload }: {
  net: NetworkKey;
  endpointId: bigint;
  events: ReplayEvent[] | null;
  loading: boolean;
  epData: EpTotals | undefined | null;
  payeeCredit: bigint | undefined;
  onReload: () => void;
}) {
  const cfg = NETWORKS[net];

  // Collect refunded requestIds for badge
  const refundedSet = new Set<string>();
  if (events) {
    for (const e of events) {
      if (e.type === 'Refunded' && e.requestId) refundedSet.add(e.requestId.toLowerCase());
    }
  }

  return (
    <div style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)', borderRadius: 14, padding: 20, marginBottom: 32, backdropFilter: 'blur(8px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 className="display" style={{ fontSize: 16, fontWeight: 600, margin: 0, color: 'var(--ink)', letterSpacing: '-0.02em' }}>
          Replay — endpoint #{String(endpointId)} scripted run
        </h2>
        <button onClick={() => { onReload(); }} disabled={loading}
          style={{ padding: '4px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, background: 'var(--surface-muted)', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", opacity: loading ? 0.5 : 1 }}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 14px', lineHeight: 1.5 }}>
        Blocks {String(cfg.deploymentBlock)} – {String(cfg.deploymentBlock + 8999n)}. Real on-chain events from our scripted demo run.
      </p>

      {loading && (
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>Loading events…</p>
      )}
      {!loading && events !== null && events.length === 0 && (
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>No events found in this block range.</p>
      )}
      {!loading && events && events.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--muted)', textAlign: 'left' }}>
                <th style={{ padding: '4px 8px 8px 0', fontWeight: 500 }}>Event</th>
                <th style={{ padding: '4px 8px 8px', fontWeight: 500 }}>requestId / detail</th>
                <th style={{ padding: '4px 8px 8px', fontWeight: 500 }}>Payer</th>
                <th style={{ padding: '4px 8px 8px', fontWeight: 500 }}>Amount</th>
                <th style={{ padding: '4px 8px 8px', fontWeight: 500 }}>Tx</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => {
                const isRefunded = e.type === 'Paid' && e.requestId && refundedSet.has(e.requestId.toLowerCase());
                return (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 8px 6px 0', verticalAlign: 'middle' }}>
                      <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                        background: e.type === 'Paid' ? '#dcfce7' : e.type === 'Refunded' ? '#fef2f2' : e.type === 'PriceChanged' ? '#eff6ff' : '#fef3c7',
                        color: e.type === 'Paid' ? '#166534' : e.type === 'Refunded' ? '#991b1b' : e.type === 'PriceChanged' ? '#1e40af' : '#92400e' }}>
                        {e.type}
                      </span>
                      {isRefunded && <span style={{ marginLeft: 4, padding: '1px 5px', borderRadius: 8, fontSize: 10, fontWeight: 600, background: '#fef2f2', color: '#991b1b' }}>Refunded</span>}
                    </td>
                    <td style={{ padding: '6px 8px', fontFamily: "'JetBrains Mono', monospace", verticalAlign: 'middle' }}>
                      {e.requestId ? (
                        <a href={`#/${net}/r/${e.requestId}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                          {formatB32(e.requestId)}
                        </a>
                      ) : e.type === 'PriceChanged' && e.amount !== undefined ? (
                        <span style={{ color: 'var(--muted)' }}>→ {formatUsdc(e.amount)} USDC</span>
                      ) : e.type === 'ActiveSet' ? (
                        <span style={{ color: 'var(--muted)' }}>{e.payer}</span>
                      ) : '—'}
                    </td>
                    <td style={{ padding: '6px 8px', fontFamily: "'JetBrains Mono', monospace", verticalAlign: 'middle', color: 'var(--ink-2)' }}>
                      {e.payer && e.type !== 'ActiveSet' && e.type !== 'PriceChanged' ? formatAddr(e.payer) : '—'}
                    </td>
                    <td style={{ padding: '6px 8px', fontFamily: 'inherit', verticalAlign: 'middle', tabularNums: true } as React.CSSProperties}>
                      {e.amount !== undefined && e.type !== 'PriceChanged' ? `${formatUsdc(e.amount)} USDC` : '—'}
                    </td>
                    <td style={{ padding: '6px 8px', verticalAlign: 'middle' }}>
                      {e.txHash ? <a href={txUrl(cfg.explorer, e.txHash)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>{e.txHash.slice(0, 8)}…</a> : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Endpoint totals footer */}
      {epData && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 24px', marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--muted)' }}>
          <span>Paid: <b style={{ color: 'var(--ink)' }}>{String(epData.paidCount)}</b></span>
          <span>Total paid: <b style={{ color: 'var(--ink)' }}>{formatUsdc(epData.totalPaid)} USDC</b></span>
          <span>Refunds: <b style={{ color: 'var(--ink)' }}>{String(epData.refundCount)}</b></span>
          <span>Total refunded: <b style={{ color: 'var(--ink)' }}>{formatUsdc(epData.totalRefunded)} USDC</b></span>
          {payeeCredit !== undefined && <span>Payee credit: <b style={{ color: 'var(--ink)' }}>{formatUsdc(payeeCredit)} USDC</b></span>}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// Cheat Step (F3)
// ─────────────────────────────────────────────

export function CheatStep({ net, city, txHash, requestId, price, endpointId, agentAddr, connectedAddr, agentKey }: {
  net: NetworkKey;
  city: string;
  txHash: Hex;
  requestId: Hex;
  price: bigint;
  endpointId: bigint;
  agentAddr: string;
  connectedAddr: string;
  agentKey: Hex | null;
}) {
  const cfg = NETWORKS[net];
  const publicClient = usePublicClient({ chainId: cfg.chain.id });

  interface CheatResult { ok: boolean; msg: string; link?: string }
  const [results, setResults] = useState<Record<string, CheatResult | 'running'>>({});

  const canPayReasons = ['OK', 'UnknownEndpoint', 'EndpointInactive', 'WrongAmount', 'AlreadyPaid', 'RequestNotForPayer'];

  // (a) Reuse Paris tx for Rome via in-page API
  const runCheatA = async () => {
    if (!publicClient) return;
    setResults(r => ({ ...r, a: 'running' }));
    try {
      const { callWeatherApi: cwa } = await import('../lib/demoApi');
      const { computeRequestId: cri } = await import('../lib/paywall');
      // Build a fresh Rome requestId using the Paris token
      const romeResource = 'GET /v1/weather?city=Rome';
      const parisToken = '0x' + txHash.slice(2, 66) as Hex; // reuse tx hash bytes as a fake token
      const { requestId: romeRid } = cri({ chainId: cfg.chain.id, contract: cfg.address, endpointId, payer: agentAddr as Hex, resource: romeResource, token: parisToken });
      const apiCfg = { chainId: cfg.chain.id, chain: cfg.chain, contractAddress: cfg.address, endpointId, price, explorer: cfg.explorer };
      // Pass Paris's txHash as payment for Rome — server will reject
      const resp = await cwa({ cfg: apiCfg, city: 'Rome', payer: agentAddr as Hex, token: parisToken, txHash, publicClient, onLog: () => {} });
      if (resp.status === 402 || resp.status === 400) {
        const body = resp.body as Record<string, unknown>;
        setResults(r => ({ ...r, a: { ok: false, msg: `API rejected — ${typeof body.error === 'string' ? body.error : String(resp.status)} (no_matching_payment: requestId was bound to ${city}, not Rome)` } }));
      } else {
        setResults(r => ({ ...r, a: { ok: false, msg: `Unexpectedly got ${resp.status}` } }));
      }
    } catch (e) {
      setResults(r => ({ ...r, a: { ok: false, msg: String(e) } }));
    }
  };

  // (b) Pay Paris again — canPay should say AlreadyPaid
  const runCheatB = async () => {
    if (!publicClient) return;
    setResults(r => ({ ...r, b: 'running' }));
    try {
      const [ok, reason] = await publicClient.readContract({ address: cfg.address, abi: ABI, functionName: 'canPay', args: [endpointId, requestId, agentAddr as Hex, price] });
      setResults(r => ({ ...r, b: { ok: !!ok, msg: ok ? 'canPay returned true (unexpected!)' : `canPay = false — ${canPayReasons[reason] ?? `reason ${reason}`}` } }));
    } catch (e) {
      setResults(r => ({ ...r, b: { ok: false, msg: decodeContractError(e) } }));
    }
  };

  // (c) Another address pays the agent's requestId — canPay with connected wallet as payer
  const runCheatC = async () => {
    if (!publicClient) return;
    setResults(r => ({ ...r, c: 'running' }));
    try {
      // Generate a fresh requestId bound to agentAddr, try to pay with connectedAddr
      const token = crypto.getRandomValues(new Uint8Array(32));
      const tok = ('0x' + Array.from(token).map(b => b.toString(16).padStart(2, '0')).join('')) as Hex;
      const { requestId: freshRid } = computeRequestId({ chainId: cfg.chain.id, contract: cfg.address, endpointId, payer: agentAddr as Hex, resource: 'GET /v1/weather?city=Test', token: tok });
      const [ok, reason] = await publicClient.readContract({ address: cfg.address, abi: ABI, functionName: 'canPay', args: [endpointId, freshRid, connectedAddr as Hex, price] });
      setResults(r => ({ ...r, c: { ok: !!ok, msg: ok ? 'canPay returned true (unexpected!)' : `canPay = false — ${canPayReasons[reason] ?? `reason ${reason}`}` } }));
    } catch (e) {
      setResults(r => ({ ...r, c: { ok: false, msg: decodeContractError(e) } }));
    }
  };

  // (d) Send the duplicate on-chain — agent sends pay(Paris requestId) again
  const runCheatD = async () => {
    if (!agentKey || !publicClient) return;
    setResults(r => ({ ...r, d: 'running' }));
    const agentAccount = privateKeyToAccount(agentKey);
    const agentWallet = createWalletClient({ account: agentAccount, chain: cfg.chain, transport: http(cfg.rpc) });
    try {
      const dupHash = await agentWallet.writeContract({
        address: cfg.address, abi: ABI, functionName: 'pay',
        args: [endpointId, requestId], value: price,
        chain: cfg.chain, account: agentAccount,
        gas: 120000n,
      });
      // Wait for receipt — should revert
      const receipt = await publicClient.waitForTransactionReceipt({ hash: dupHash, timeout: 60_000 });
      if (receipt.status === 'reverted') {
        setResults(r => ({ ...r, d: { ok: false, msg: `Failed on-chain: AlreadyPaid (tx reverted)`, link: txUrl(cfg.explorer, dupHash) } }));
      } else {
        setResults(r => ({ ...r, d: { ok: false, msg: `Tx succeeded unexpectedly`, link: txUrl(cfg.explorer, dupHash) } }));
      }
    } catch (e) {
      const msg = decodeContractError(e);
      setResults(r => ({ ...r, d: { ok: false, msg: `Failed on-chain: ${msg}` } }));
    }
  };

  const rows: { key: string; label: string; run: () => Promise<void>; disabled: boolean }[] = [
    { key: 'a', label: `Reuse ${city} token for Rome`, run: runCheatA, disabled: false },
    { key: 'b', label: `Pay ${city} again (read-only)`, run: runCheatB, disabled: false },
    { key: 'c', label: 'Another address pays the agent requestId (read-only)', run: runCheatC, disabled: false },
    { key: 'd', label: `Send duplicate pay() on-chain (costs gas)`, run: runCheatD, disabled: !agentKey },
  ];

  return (
    <StepCard n={5} title="Try to cheat" done={false} active>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 14px', lineHeight: 1.5 }}>
        Click each row to run the real check. Rows a–c are read-only; row d submits an on-chain tx that should revert.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map(({ key, label, run, disabled }) => {
          const res = results[key];
          return (
            <div key={key} style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: res ? 8 : 0 }}>
                <button onClick={() => { void run(); }}
                  disabled={disabled || res === 'running'}
                  style={{ padding: '5px 12px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: (disabled || res === 'running') ? 0.5 : 1, flexShrink: 0, fontFamily: "'DM Sans', sans-serif" }}>
                  {res === 'running' ? '…' : 'Run'}
                </button>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{label}</span>
              </div>
              {res && res !== 'running' && (
                <div style={{ fontSize: 12, color: res.ok ? 'var(--success)' : 'var(--danger)', paddingLeft: 4, lineHeight: 1.5 }}>
                  {res.ok ? '✓' : '✗'} {res.msg}
                  {res.link && <> · <a href={res.link} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>Explorer</a></>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </StepCard>
  );
}

// ─────────────────────────────────────────────
// Step 6 (F4)
// ─────────────────────────────────────────────

export function Step6({ net, endpointId, address, agentAddr, agentKey, agentAccount, parisResult, tokyoResult, isCorrectChain, onSweep, onDone }: {
  net: NetworkKey;
  endpointId: bigint;
  address: Hex;
  agentAddr: string | null;
  agentKey: Hex | null;
  agentAccount: Account | null;
  parisResult: { txHash?: string; requestId?: Hex; price?: bigint } | null;
  tokyoResult: { txHash?: string; requestId?: Hex; price?: bigint } | null;
  isCorrectChain: boolean;
  onSweep: () => Promise<void>;
  onDone: () => void;
}) {
  const cfg = NETWORKS[net];

  // Endpoint-scoped totals
  const { data: ep, refetch: refetchEp } = useReadContract({
    address: cfg.address, abi: ABI, functionName: 'getEndpoint',
    args: [endpointId], chainId: cfg.chain.id,
  });
  const { data: myCredit, refetch: refetchCredit } = useReadContract({
    address: cfg.address, abi: ABI, functionName: 'creditOf',
    args: [address], chainId: cfg.chain.id,
  });

  const { writeContract: writeRefund, data: refundHash, isPending: refundP } = useWriteContract();
  const { isLoading: refundC, isSuccess: refundDone } = useWaitForTransactionReceipt({ hash: refundHash });
  useEffect(() => { if (refundDone) { void refetchEp(); void refetchCredit(); onDone(); } }, [refundDone]); // eslint-disable-line react-hooks/exhaustive-deps

  const { writeContract: writeWithdraw, data: withdrawHash, isPending: withdrawP } = useWriteContract();
  const { isLoading: withdrawC, isSuccess: withdrawDone } = useWaitForTransactionReceipt({ hash: withdrawHash });
  useEffect(() => { if (withdrawDone) { void refetchCredit(); onDone(); } }, [withdrawDone]); // eslint-disable-line react-hooks/exhaustive-deps

  const tokyoPaid = !!tokyoResult?.requestId && !!(tokyoResult.txHash);

  const handleRefundTokyo = () => {
    if (!tokyoResult?.requestId || !isCorrectChain) return;
    writeRefund({ address: cfg.address, abi: ABI, functionName: 'refund', args: [tokyoResult.requestId], chainId: cfg.chain.id }, {
      onSuccess: h => toast.success('Tokyo refunded', { description: <a href={txUrl(cfg.explorer, h)} target="_blank" rel="noopener" style={{ color: 'var(--accent)' }}>View</a> }),
      onError: err => toast.error(decodeContractError(err)),
    });
  };

  const handleWithdraw = () => {
    if (!myCredit || myCredit === 0n || !isCorrectChain) return;
    writeWithdraw({ address: cfg.address, abi: ABI, functionName: 'withdraw', args: [address, myCredit], chainId: cfg.chain.id }, {
      onSuccess: h => toast.success('Withdrawn', { description: <a href={txUrl(cfg.explorer, h)} target="_blank" rel="noopener" style={{ color: 'var(--accent)' }}>View</a> }),
      onError: err => toast.error(decodeContractError(err)),
    });
  };

  return (
    <StepCard n={6} title="Refund, withdraw, sweep" done={false} active>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 10px' }}>
            As the provider, refund Tokyo (you = payee → your credit decreases, payer gets back their money via refund). Only enabled after Tokyo is paid.
          </p>
          <button onClick={handleRefundTokyo}
            disabled={!tokyoPaid || !isCorrectChain || refundP || refundC}
            style={{ ...primaryBtn, opacity: (!tokyoPaid || !isCorrectChain) ? 0.5 : 1 }}>
            {refundP ? 'Confirm…' : refundC ? 'Refunding…' : 'Refund Tokyo'}
          </button>
        </div>
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 10px' }}>
            Withdraw your accumulated credit ({myCredit !== undefined ? formatUsdc(myCredit) : '—'} USDC) to your wallet.
          </p>
          <button onClick={handleWithdraw}
            disabled={!myCredit || myCredit === 0n || !isCorrectChain || withdrawP || withdrawC}
            style={{ ...primaryBtn, opacity: (!myCredit || myCredit === 0n || !isCorrectChain) ? 0.5 : 1 }}>
            {withdrawP ? 'Confirm…' : withdrawC ? 'Withdrawing…' : `Withdraw credit (${myCredit !== undefined ? formatUsdc(myCredit) : '—'} USDC)`}
          </button>
        </div>
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <button onClick={() => { void onSweep(); }} style={ghostBtn}>Sweep agent key back to my wallet</button>
        </div>
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>Endpoint #{String(endpointId)} final accounting:</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Row label={`Paid count`} value={ep ? String(ep.paidCount) : '—'} />
            <Row label="Total paid" value={ep ? `${formatUsdc(ep.totalPaid)} USDC` : '—'} />
            <Row label="Refund count" value={ep ? String(ep.refundCount) : '—'} />
            <Row label="Total refunded" value={ep ? `${formatUsdc(ep.totalRefunded)} USDC` : '—'} />
            <Row label="My credit" value={myCredit !== undefined ? `${formatUsdc(myCredit)} USDC` : '—'} />
            {agentAddr && (
              <AgentBalRow net={net} agentAddr={agentAddr} />
            )}
          </div>
        </div>
      </div>
    </StepCard>
  );
}

function AgentBalRow({ net, agentAddr }: { net: NetworkKey; agentAddr: string }) {
  const cfg = NETWORKS[net];
  const publicClient = usePublicClient({ chainId: cfg.chain.id });
  const [bal, setBal] = useState<bigint | null>(null);
  useEffect(() => {
    if (!publicClient) return;
    publicClient.getBalance({ address: agentAddr as Hex }).then(setBal).catch(() => {});
  }, [publicClient, agentAddr]);
  return <Row label="Agent native balance" value={bal !== null ? `${formatUsdc(bal)} USDC` : '—'} />;
}

// ─────────────────────────────────────────────
// Shared UI primitives (also exported for DemoPage)
// ─────────────────────────────────────────────

export function StepCard({ n, title, done, active, children }: { n: number; title: string; done: boolean; active: boolean; children: React.ReactNode }) {
  return (
    <div style={{ background: active ? 'var(--surface-strong)' : 'var(--surface-muted)', border: `1px solid ${active ? 'var(--border-strong)' : 'var(--border)'}`, borderRadius: 14, padding: 20, marginBottom: 16, backdropFilter: 'blur(8px)', opacity: active ? 1 : 0.6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={{ width: 26, height: 26, borderRadius: '50%', background: done ? 'var(--success)' : active ? '#E3242B' : 'var(--border)', color: '#fff', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontFamily: "'Space Grotesk', sans-serif" }}>
          {done ? '✓' : n}
        </div>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, fontFamily: "'Space Grotesk', sans-serif", color: 'var(--ink)', letterSpacing: '-0.02em' }}>{title}</h2>
      </div>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span style={{ fontWeight: 600, tabularNums: true } as React.CSSProperties}>{value}</span>
    </div>
  );
}

export const primaryBtn: React.CSSProperties = {
  padding: '10px 18px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8,
  fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
};

export const ghostBtn: React.CSSProperties = {
  padding: '9px 16px', background: 'transparent', color: 'var(--ink-2)', border: '1px solid var(--border)', borderRadius: 8,
  fontSize: 14, fontWeight: 500, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
};
