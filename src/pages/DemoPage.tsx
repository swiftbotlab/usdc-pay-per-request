import { useState, useEffect, useRef, useCallback } from 'react';
import React from 'react';
import {
  useAccount, useReadContract, useWriteContract,
  useWaitForTransactionReceipt, useSwitchChain, usePublicClient, useSendTransaction,
} from 'wagmi';
import { toast } from 'sonner';
import {
  createWalletClient, createPublicClient, http, type Hex, parseEther,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { type NetworkKey, NETWORKS } from '../config/networks';
import { ABI } from '../config/abi';
import { formatUsdc, formatAddr, txUrl } from '../lib/format';
import { decodeContractError, CAN_PAY_REASONS } from '../lib/errors';
import { callWeatherApi, type LogEntry, type DemoApiConfig } from '../lib/demoApi';
import { getGasOverrides } from '../lib/gas';

import { ReplayPanel, CheatStep, Step6, StepCard, primaryBtn, ghostBtn } from './DemoHelpers';

interface Props { net: NetworkKey }

const CITIES = ['Paris', 'Tokyo', 'Lima'];
const LS_PREFIX = 'usdc-ppr:demo-agent:';
const PRICE_CAP = parseEther('0.05');

function lsKey(net: NetworkKey) { return LS_PREFIX + net; }
function readAgentKey(net: NetworkKey): Hex | null {
  try { const v = localStorage.getItem(lsKey(net)); return v?.startsWith('0x') ? v as Hex : null; } catch { return null; }
}
function saveAgentKey(net: NetworkKey, pk: Hex) { try { localStorage.setItem(lsKey(net), pk); } catch { /* ignore */ } }
function removeAgentKey(net: NetworkKey) { try { localStorage.removeItem(lsKey(net)); } catch { /* ignore */ } }

// Generic decoded log row (viem's Log<bigint,number,false,ABI,...> has .args; plain Log does not)
type DecodedLog = { args: Record<string, unknown>; blockNumber: bigint | null; transactionHash: string | null };
const EMPTY_LOGS: DecodedLog[] = [];

// ------- Paid event type -------
const PAID_EVENT = {
  type: 'event' as const,
  name: 'Paid' as const,
  inputs: [
    { name: 'endpointId', type: 'uint256', indexed: true },
    { name: 'requestId', type: 'bytes32', indexed: true },
    { name: 'payer', type: 'address', indexed: true },
    { name: 'payee', type: 'address', indexed: false },
    { name: 'amount', type: 'uint256', indexed: false },
  ],
};
const REFUNDED_EVENT = {
  type: 'event' as const, name: 'Refunded' as const,
  inputs: [
    { name: 'endpointId', type: 'uint256', indexed: true },
    { name: 'requestId', type: 'bytes32', indexed: true },
    { name: 'payer', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
  ],
};

interface ReplayEvent {
  blockNumber: bigint;
  txHash: string;
  type: 'Paid' | 'Refunded' | 'PriceChanged' | 'ActiveSet' | 'Withdrawn';
  requestId?: string;
  payer?: string;
  amount?: bigint;
}

export function DemoPage({ net }: Props) {
  const cfg = NETWORKS[net];
  const { address, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: cfg.chain.id });

  const [agentKey, setAgentKey] = useState<Hex | null>(() => readAgentKey(net));
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<string, { data?: unknown; txHash?: string; requestId?: Hex; price?: bigint }>>({});
  const [step, setStep] = useState(1);
  const [replay, setReplay] = useState<ReplayEvent[] | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);

  const logRef = useRef<HTMLDivElement>(null);
  const logIdRef = useRef(0);
  const addLog = useCallback((e: LogEntry) => {
    setLogs(prev => [...prev, e]);
    setTimeout(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }), 50);
  }, []);
  const nextId = () => { logIdRef.current += 1; return logIdRef.current; };

  const agentAccount = agentKey ? privateKeyToAccount(agentKey) : null;
  const agentAddr = agentAccount?.address ?? null;

  const { data: agentBalance, refetch: refetchAgentBalance } = useReadContract({
    address: cfg.address, abi: ABI, functionName: 'creditOf',
    args: [agentAddr ?? '0x0000000000000000000000000000000000000000'],
    chainId: cfg.chain.id, query: { enabled: !!agentAddr },
  });
  const [agentNativeBal, setAgentNativeBal] = useState<bigint | null>(null);
  useEffect(() => {
    if (!agentAddr || !publicClient) return;
    publicClient.getBalance({ address: agentAddr }).then(setAgentNativeBal).catch(() => {});
  }, [agentAddr, publicClient]);

  const { data: myEndpointIds, refetch: refetchEndpoints } = useReadContract({
    address: cfg.address, abi: ABI, functionName: 'endpointsOf',
    args: [address ?? '0x0000000000000000000000000000000000000000'],
    chainId: cfg.chain.id, query: { enabled: !!address },
  });

  const endpointId = myEndpointIds && myEndpointIds.length > 0
    ? myEndpointIds[myEndpointIds.length - 1] : null;

  const { data: epData, refetch: refetchEpData } = useReadContract({
    address: cfg.address, abi: ABI, functionName: 'getEndpoint',
    args: [endpointId ?? 0n], chainId: cfg.chain.id, query: { enabled: endpointId !== null },
  });
  const { data: epName } = useReadContract({
    address: cfg.address, abi: ABI, functionName: 'nameOf',
    args: [endpointId ?? 0n], chainId: cfg.chain.id, query: { enabled: endpointId !== null },
  });

  const isDemoEndpoint = epName === 'GET /v1/weather (demo)' && !!epData?.active;
  const isCorrectChain = chainId === cfg.chain.id;

  const PRICE_WEI = net === 'mainnet' ? parseEther('0.01') : parseEther('0.05');
  const FUND_WEI = net === 'mainnet' ? parseEther('0.05') : parseEther('0.30');

  // ── Replay: load events for cfg.demoEndpointId from the fixed window ──
  const loadReplay = useCallback(async () => {
    if (replayLoading) return;
    setReplayLoading(true);
    try {
      const rpc = cfg.rpc;
      const pc = createPublicClient({ chain: cfg.chain, transport: http(rpc) });
      const from = cfg.deploymentBlock;
      const head = await pc.getBlockNumber();
      const to = cfg.deploymentBlock + 8999n < head ? cfg.deploymentBlock + 8999n : head; // the RPC rejects a toBlock beyond the head
      const eid = cfg.demoEndpointId;
      const addr = cfg.address;

      // Fetch all event types in parallel — ONE getLogs window per type
      const [paidLogs, refundedLogs, priceChangedLogs, activeSetLogs, withdrawnLogs] = await Promise.all([
        pc.getLogs({ address: addr, event: PAID_EVENT, args: { endpointId: eid }, fromBlock: from, toBlock: to }).then(r => r as unknown as DecodedLog[]).catch(() => EMPTY_LOGS),
        pc.getLogs({ address: addr, event: REFUNDED_EVENT, args: { endpointId: eid }, fromBlock: from, toBlock: to }).then(r => r as unknown as DecodedLog[]).catch(() => EMPTY_LOGS),
        pc.getLogs({ address: addr, event: { type: 'event' as const, name: 'PriceChanged' as const, inputs: [{ name: 'id', type: 'uint256', indexed: true }, { name: 'oldPrice', type: 'uint256', indexed: false }, { name: 'newPrice', type: 'uint256', indexed: false }] }, args: { id: eid }, fromBlock: from, toBlock: to }).then(r => r as unknown as DecodedLog[]).catch(() => EMPTY_LOGS),
        pc.getLogs({ address: addr, event: { type: 'event' as const, name: 'ActiveSet' as const, inputs: [{ name: 'id', type: 'uint256', indexed: true }, { name: 'active', type: 'bool', indexed: false }] }, args: { id: eid }, fromBlock: from, toBlock: to }).then(r => r as unknown as DecodedLog[]).catch(() => EMPTY_LOGS),
        pc.getLogs({ address: addr, event: { type: 'event' as const, name: 'Withdrawn' as const, inputs: [{ name: 'account', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] }, fromBlock: from, toBlock: to }).then(r => r as unknown as DecodedLog[]).catch(() => EMPTY_LOGS),
      ]);

      const events: ReplayEvent[] = [];

      for (const l of paidLogs) {
        const a = l.args as { requestId?: Hex; payer?: string; amount?: bigint };
        events.push({ blockNumber: l.blockNumber ?? 0n, txHash: l.transactionHash ?? '', type: 'Paid', requestId: a.requestId, payer: a.payer, amount: a.amount });
      }
      for (const l of refundedLogs) {
        const a = l.args as { requestId?: Hex; payer?: string; amount?: bigint };
        events.push({ blockNumber: l.blockNumber ?? 0n, txHash: l.transactionHash ?? '', type: 'Refunded', requestId: a.requestId, payer: a.payer, amount: a.amount });
      }
      for (const l of priceChangedLogs) {
        const a = l.args as { oldPrice?: bigint; newPrice?: bigint };
        events.push({ blockNumber: l.blockNumber ?? 0n, txHash: l.transactionHash ?? '', type: 'PriceChanged', amount: a.newPrice });
      }
      for (const l of activeSetLogs) {
        const a = l.args as { active?: boolean };
        events.push({ blockNumber: l.blockNumber ?? 0n, txHash: l.transactionHash ?? '', type: 'ActiveSet', payer: a.active ? 'resumed' : 'paused' });
      }
      for (const l of withdrawnLogs) {
        const a = l.args as { account?: string; to?: string; amount?: bigint };
        events.push({ blockNumber: l.blockNumber ?? 0n, txHash: l.transactionHash ?? '', type: 'Withdrawn', payer: a.account, amount: a.amount });
      }

      events.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));
      setReplay(events);
    } catch {
      setReplay([]);
    }
    setReplayLoading(false);
  }, [cfg, replayLoading]);

  // Auto-load replay when no wallet connected or not past step 3
  // oxlint-disable react/set-state-in-effect
  useEffect(() => {
    if (!!(cfg.demoEndpointId > 0n) && (!address || step < 3) && replay === null && !replayLoading) {
      void loadReplay();
    }
  // oxlint-enable react/set-state-in-effect
  }, [cfg.demoEndpointId, address, step, replay, replayLoading, loadReplay]);

  // Endpoint totals for replay footer
  const { data: demoEpData } = useReadContract({
    address: cfg.address, abi: ABI, functionName: 'getEndpoint',
    args: [cfg.demoEndpointId], chainId: cfg.chain.id,
    query: { enabled: cfg.demoEndpointId > 0n },
  });
  const demoPayee = demoEpData?.payee;
  const { data: payeeCredit } = useReadContract({
    address: cfg.address, abi: ABI, functionName: 'creditOf',
    args: [demoPayee ?? '0x0000000000000000000000000000000000000000'],
    chainId: cfg.chain.id, query: { enabled: !!demoPayee },
  });

  // Register endpoint
  const { writeContract: writeRegister, data: regHash, isPending: regPending } = useWriteContract();
  const { isLoading: regConfirming, isSuccess: regMined } = useWaitForTransactionReceipt({ hash: regHash });

  const { sendTransaction: sendFund, data: fundHash, isPending: fundPending } = useSendTransaction();
  const { isLoading: fundConfirming, isSuccess: fundMined } = useWaitForTransactionReceipt({ hash: fundHash });
  // Hand fix (disclosed): re-read after the receipt, not when the hash is returned (the endpoint and balance were read too early)
  useEffect(() => { if (regMined) { void refetchEndpoints(); void refetchEpData(); } }, [regMined, refetchEndpoints, refetchEpData]);
  useEffect(() => { if (fundMined && agentAddr && publicClient) { publicClient.getBalance({ address: agentAddr }).then(setAgentNativeBal).catch(() => {}); } }, [fundMined, agentAddr, publicClient]);

  const handleGenerateKey = () => {
    const pk = generatePrivateKey();
    saveAgentKey(net, pk);
    setAgentKey(pk);
    setStep(s => Math.max(s, 2));
  };
  const handleForgetKey = () => { removeAgentKey(net); setAgentKey(null); };

  const handleFundAgent = () => {
    if (!agentAddr || !isCorrectChain) return;
    sendFund({ to: agentAddr, value: FUND_WEI }, {
      onSuccess: h => toast.success('Funded agent', { description: <a href={txUrl(cfg.explorer, h)} target="_blank" rel="noopener" style={{ color: 'var(--accent)' }}>View</a> }),
      onError: err => toast.error(decodeContractError(err)),
    });
  };

  const handleRegisterEndpoint = () => {
    if (!address || !isCorrectChain) return;
    writeRegister({ address: cfg.address, abi: ABI, functionName: 'registerEndpoint', args: [PRICE_WEI as unknown as bigint & { __tag: 'uint128' }, address, 'GET /v1/weather (demo)'], chainId: cfg.chain.id }, {
      onSuccess: h => {
        toast.success('Demo endpoint registered', { description: <a href={txUrl(cfg.explorer, h)} target="_blank" rel="noopener" style={{ color: 'var(--accent)' }}>View</a> });
        void refetchEndpoints();
        setStep(3);
      },
      onError: err => toast.error(decodeContractError(err)),
    });
  };

  // ── Run agent for a city ──
  // oxlint-disable react/purity
  const handleRunCity = async (city: string) => {
    if (!agentKey || !agentAddr || !endpointId || !epData || !publicClient) return;
    setRunning(true);
    setLogs([]);
    setResults(prev => ({ ...prev, [city]: {} }));
    const tStart = performance.now();

    const apiCfg: DemoApiConfig = {
      chainId: cfg.chain.id, chain: cfg.chain,
      contractAddress: cfg.address, endpointId, price: epData.price, explorer: cfg.explorer,
    };
    const agentWallet = createWalletClient({ account: agentAccount!, chain: cfg.chain, transport: http(cfg.rpc) });

    try {
      // 402 phase
      addLog({ id: nextId(), voice: 'agent', msg: `Requesting ${city} weather from API…` });
      const t402 = performance.now();
      const resp402 = await callWeatherApi({ cfg: apiCfg, city, payer: agentAddr, publicClient, onLog: addLog });
      const ms402 = Math.round(performance.now() - t402);
      if (resp402.status !== 402 || !('token' in resp402)) {
        addLog({ id: nextId(), voice: 'api', msg: `Unexpected response ${resp402.status}`, error: true });
        setRunning(false); return;
      }
      addLog({ id: nextId(), voice: 'agent', msg: `Got 402 in ${ms402}ms` });

      const { token, requestId } = resp402;
      const accept = resp402.body.accepts[0];
      const price = BigInt(accept.amount);

      // Agent safety checks (F2)
      addLog({ id: nextId(), voice: 'agent', msg: `Validating: payTo, price cap, payerOf, canPay…` });
      if (accept.payTo.toLowerCase() !== cfg.address.toLowerCase()) {
        addLog({ id: nextId(), voice: 'agent', msg: `REJECT: payTo is not our known contract`, error: true });
        setRunning(false); return;
      }
      if (price > PRICE_CAP) {
        addLog({ id: nextId(), voice: 'agent', msg: `REJECT: price ${formatUsdc(price)} USDC > cap 0.05`, error: true });
        setRunning(false); return;
      }
      // payerOf check
      let onChainPayer: string;
      try {
        onChainPayer = await publicClient.readContract({ address: cfg.address, abi: ABI, functionName: 'payerOf', args: [requestId] });
      } catch (e) {
        addLog({ id: nextId(), voice: 'agent', msg: `REJECT: payerOf() failed: ${decodeContractError(e)}`, error: true });
        setRunning(false); return;
      }
      if (onChainPayer.toLowerCase() !== agentAddr.toLowerCase()) {
        addLog({ id: nextId(), voice: 'agent', msg: `REJECT: payerOf=${formatAddr(onChainPayer)} ≠ agent`, error: true });
        setRunning(false); return;
      }
      // canPay check
      let canPayResult: readonly [boolean, number];
      try {
        canPayResult = await publicClient.readContract({ address: cfg.address, abi: ABI, functionName: 'canPay', args: [endpointId, requestId, agentAddr, price] });
      } catch (e) {
        addLog({ id: nextId(), voice: 'agent', msg: `REJECT: canPay() reverted: ${decodeContractError(e)}`, error: true });
        setRunning(false); return;
      }
      if (!canPayResult[0]) {
        addLog({ id: nextId(), voice: 'agent', msg: `REJECT: canPay failed — ${CAN_PAY_REASONS[canPayResult[1]] ?? `reason ${canPayResult[1]}`}`, error: true });
        setRunning(false); return;
      }
      addLog({ id: nextId(), voice: 'agent', msg: `Checks passed — payerOf ✓, canPay ✓ — paying…` });

      // pay()
      const tPay = performance.now();
      let gasOpts = {};
      try { gasOpts = await getGasOverrides(publicClient); } catch { /* ignore */ }
      let payHash: Hex;
      try {
        payHash = await agentWallet.writeContract({
          address: cfg.address, abi: ABI, functionName: 'pay',
          args: [endpointId, requestId], value: price,
          chain: cfg.chain, account: agentAccount!, ...gasOpts,
        });
      } catch (e) {
        addLog({ id: nextId(), voice: 'contract', msg: `pay() failed: ${decodeContractError(e)}`, error: true });
        setRunning(false); return;
      }
      addLog({ id: nextId(), voice: 'agent', msg: `pay() submitted`, link: txUrl(cfg.explorer, payHash), linkLabel: 'View tx' });

      let receipt;
      try {
        receipt = await publicClient.waitForTransactionReceipt({ hash: payHash, timeout: 60_000 });
      } catch {
        addLog({ id: nextId(), voice: 'contract', msg: `Timed out waiting for receipt`, error: true });
        setRunning(false); return;
      }
      const payMs = Math.round(performance.now() - tPay);
      addLog({ id: nextId(), voice: 'contract', msg: `Confirmed in block ${receipt.blockNumber} (${(payMs / 1000).toFixed(1)}s)`, link: txUrl(cfg.explorer, payHash), linkLabel: 'View tx', durationMs: payMs });

      // Verify
      addLog({ id: nextId(), voice: 'agent', msg: `Retrying with X-Paywall-Token + X-Paywall-Tx…` });
      const tVerify = performance.now();
      const resp200 = await callWeatherApi({ cfg: apiCfg, city, payer: agentAddr, token, txHash: payHash, publicClient, onLog: addLog });
      const verifyMs = Math.round(performance.now() - tVerify);

      if (resp200.status === 200 && 'body' in resp200 && 'temperatureC' in resp200.body) {
        const wb = resp200.body as { temperatureC: number; conditions: string };
        addLog({ id: nextId(), voice: 'api', msg: `Served — ${city}: ${String(wb.temperatureC)}°C, ${String(wb.conditions)} (verified in ${verifyMs}ms)`, durationMs: verifyMs });
        setResults(prev => ({ ...prev, [city]: { data: resp200.body, txHash: payHash, requestId, price } }));
        setStep(s => Math.max(s, 5));
        void refetchAgentBalance();
        void refetchEpData();
        void publicClient.getBalance({ address: agentAddr }).then(setAgentNativeBal).catch(() => {});
      } else {
        addLog({ id: nextId(), voice: 'api', msg: `Verification failed: ${JSON.stringify('body' in resp200 ? resp200.body : {})}`, error: true });
      }

      const totalMs = Math.round(performance.now() - tStart);
      addLog({ id: nextId(), voice: 'agent', msg: `Done — 402 in ${ms402}ms, paid in ${(payMs / 1000).toFixed(1)}s, verified in ${verifyMs}ms, total ${(totalMs / 1000).toFixed(1)}s` });
    } catch (e) {
      addLog({ id: nextId(), voice: 'agent', msg: `Error: ${decodeContractError(e)}`, error: true });
    }
    setRunning(false);
  };
  // oxlint-enable react/purity

  const handleSweep = async () => {
    if (!agentKey || !agentAddr || !address || !publicClient) return;
    const balance = await publicClient.getBalance({ address: agentAddr });
    if (balance === 0n) { toast.info('Agent has no balance'); return; }
    const agentWallet = createWalletClient({ account: agentAccount!, chain: cfg.chain, transport: http(cfg.rpc) });
    let gasOpts = { maxFeePerGas: parseEther('0.000000021'), maxPriorityFeePerGas: parseEther('0.000000001') };
    try { gasOpts = await getGasOverrides(publicClient); } catch { /* ignore */ }
    const gas = 21000n;
    const totalFee = BigInt(gasOpts.maxFeePerGas) * gas;
    const value = balance > totalFee ? balance - totalFee : 0n;
    if (value === 0n) { toast.info('Not enough balance to cover gas'); return; }
    try {
      const hash = await agentWallet.sendTransaction({ to: address, value, chain: cfg.chain, account: agentAccount!, ...gasOpts });
      toast.success('Swept agent balance', { description: <a href={txUrl(cfg.explorer, hash)} target="_blank" rel="noopener" style={{ color: 'var(--accent)' }}>View</a> });
      removeAgentKey(net); setAgentKey(null);
    } catch (e) { toast.error(decodeContractError(e)); }
  };

  const firstSuccess = Object.entries(results).find(([, r]) => r.txHash && r.requestId);
  const parisResult = results['Paris'] ?? null;
  const tokyoResult = results['Tokyo'] ?? null;

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', padding: '40px 16px', overflow: 'hidden' }}>
      <h1 className="display" style={{ fontSize: 28, fontWeight: 700, margin: '0 0 6px', color: 'var(--ink)', letterSpacing: '-0.03em' }}>
        An agent buys weather data, one request at a time
      </h1>
      <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 32px', lineHeight: 1.6 }}>
        Walk through the HTTP 402 paywall flow — the in-page API simulates the real server. For production, run{' '}
        <code className="mono" style={{ fontSize: 12 }}>node verifier/server.mjs</code>.
      </p>

      {/* Replay panel: shown when no wallet or before step 3 */}
      {!!(cfg.demoEndpointId > 0n) && (!address || step < 3) && (
        <ReplayPanel
          net={net}
          endpointId={cfg.demoEndpointId}
          events={replay}
          loading={replayLoading}
          epData={demoEpData}
          payeeCredit={payeeCredit}
          onReload={() => { void loadReplay(); }}
        />
      )}

      {/* Step 1 */}
      <StepCard n={1} title="Connect wallet" done={!!address} active={step >= 1}>
        {address ? (
          <p style={{ fontSize: 13, color: 'var(--success)', margin: 0 }}>Connected: <span className="mono" style={{ fontSize: 12 }}>{formatAddr(address)}</span></p>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>Connect your wallet using the button in the header.</p>
        )}
      </StepCard>

      {/* Step 2 */}
      <StepCard n={2} title="Create agent key" done={!!agentAddr} active={!!address}>
        {!agentKey ? (
          <div>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.5 }}>Generate a throwaway key. Stored in localStorage — never use for real funds.</p>
            <button onClick={handleGenerateKey} style={primaryBtn}>Generate agent key</button>
          </div>
        ) : (
          <div>
            <p style={{ fontSize: 13, color: '#92400e', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 12px', margin: '0 0 12px', lineHeight: 1.5 }}>
              Hot key for demo only — stored in browser.
            </p>
            <div style={{ fontSize: 13, marginBottom: 10 }}>Address: <span className="mono" style={{ fontSize: 12 }}>{agentAddr}</span></div>
            <div style={{ fontSize: 13, marginBottom: 12 }}>
              Balance: <span style={{ fontWeight: 600, tabularNums: true } as React.CSSProperties}>
                {agentNativeBal !== null ? formatUsdc(agentNativeBal) : '—'} USDC
              </span>
              {agentBalance !== undefined && agentBalance > 0n && (
                <span style={{ marginLeft: 8, color: 'var(--muted)', fontSize: 12 }}>credit: {formatUsdc(agentBalance)}</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={handleFundAgent} disabled={!address || !isCorrectChain || fundPending || fundConfirming} style={primaryBtn}>
                {fundPending ? 'Confirm…' : fundConfirming ? 'Confirming…' : `Fund agent (${net === 'mainnet' ? '0.05' : '0.30'} USDC)`}
              </button>
              <button onClick={handleForgetKey} style={ghostBtn}>Forget key</button>
            </div>
            {!isCorrectChain && address && (
              <button onClick={() => switchChain({ chainId: cfg.chain.id })} style={{ ...ghostBtn, marginTop: 8 }}>Switch to {cfg.chain.name}</button>
            )}
          </div>
        )}
      </StepCard>

      {/* Step 3: Endpoint */}
      <StepCard n={3} title="Demo endpoint" done={!!isDemoEndpoint} active={!!agentKey && !!address}>
        {isDemoEndpoint ? (
          <p style={{ fontSize: 13, color: 'var(--success)', margin: 0 }}>
            Using endpoint #{String(endpointId)} — {epName} — {formatUsdc(epData?.price)} USDC per request
          </p>
        ) : endpointId && epData && !isDemoEndpoint ? (
          <div>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 10px' }}>
              Your most recent endpoint is "{epName || `#${endpointId}`}". Register a fresh demo endpoint below.
            </p>
            <button onClick={handleRegisterEndpoint} disabled={!address || !isCorrectChain || regPending || regConfirming} style={primaryBtn}>
              {regPending ? 'Confirm…' : regConfirming ? 'Confirming…' : 'Register my demo endpoint'}
            </button>
          </div>
        ) : (
          <div>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 10px' }}>
              Registers a "GET /v1/weather (demo)" endpoint with price {net === 'mainnet' ? '0.01' : '0.05'} USDC.
            </p>
            <button onClick={handleRegisterEndpoint} disabled={!address || !isCorrectChain || regPending || regConfirming} style={{ ...primaryBtn, opacity: (!address || !isCorrectChain) ? 0.5 : 1 }}>
              {regPending ? 'Confirm…' : regConfirming ? 'Confirming…' : 'Register my demo endpoint'}
            </button>
          </div>
        )}
      </StepCard>

      {/* Step 4: Run agent */}
      <StepCard n={4} title="Run agent" done={Object.keys(results).length > 0} active={!!agentKey && !!isDemoEndpoint}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: logs.length > 0 ? 16 : 0 }}>
          {CITIES.map(city => (
            <button key={city} onClick={() => { void handleRunCity(city); }}
              disabled={running || !agentKey || !isDemoEndpoint}
              style={{ ...primaryBtn, opacity: (!agentKey || !isDemoEndpoint || running) ? 0.5 : 1 }}>
              {running ? '…' : `Buy ${city} weather`}
            </button>
          ))}
        </div>
        {logs.length > 0 && (
          <div ref={logRef} style={{ background: '#0d1b2f', borderRadius: 10, padding: '12px 14px', maxHeight: 280, overflowY: 'auto', marginTop: 12, fontSize: 12 }}>
            {logs.map(e => (
              <div key={e.id} style={{ display: 'flex', gap: 8, marginBottom: 5, alignItems: 'flex-start' }}>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, flexShrink: 0, padding: '1px 6px', borderRadius: 4, background: e.voice === 'agent' ? '#1e3a5f' : e.voice === 'api' ? '#1e4d2e' : '#3d1e0f', color: e.voice === 'agent' ? '#93c5fd' : e.voice === 'api' ? '#86efac' : '#fdba74' }}>
                  {e.voice.toUpperCase()}
                </span>
                <span style={{ color: e.error ? '#fca5a5' : '#e2e8f0', lineHeight: 1.5, flex: 1, overflowWrap: 'break-word', minWidth: 0 }}>
                  {e.msg}
                  {e.link ? <> · <a href={e.link} target="_blank" rel="noopener noreferrer" style={{ color: '#93c5fd' }}>{e.linkLabel ?? 'link'}</a></> : null}
                  {e.durationMs !== undefined && <span style={{ color: '#64748b' }}> ({e.durationMs}ms)</span>}
                </span>
              </div>
            ))}
          </div>
        )}
        {Object.entries(results).map(([city, r]) => r.data ? (
          <div key={city} style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', marginTop: 10, fontSize: 13 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{city}</div>
            <pre style={{ margin: 0, fontFamily: "'JetBrains Mono', monospace", fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--ink-2)' }}>
              {JSON.stringify(r.data, null, 2)}
            </pre>
          </div>
        ) : null)}
      </StepCard>

      {/* Step 5: Cheat panel */}
      {step >= 5 && firstSuccess && firstSuccess[1].txHash && firstSuccess[1].requestId && endpointId !== null && (
        <CheatStep
          net={net}
          city={firstSuccess[0]}
          txHash={firstSuccess[1].txHash as Hex}
          requestId={firstSuccess[1].requestId}
          price={firstSuccess[1].price ?? PRICE_WEI}
          endpointId={endpointId}
          agentAddr={agentAddr ?? '0x0000000000000000000000000000000000000000'}
          connectedAddr={address ?? '0x0000000000000000000000000000000000000000'}
          agentKey={agentKey}
        />
      )}

      {/* Step 6: Actions + accounting */}
      {step >= 5 && endpointId !== null && !!address && (
        <Step6
          net={net}
          endpointId={endpointId}
          address={address}
          agentAddr={agentAddr}
          agentKey={agentKey}
          agentAccount={agentAccount}
          parisResult={parisResult}
          tokyoResult={tokyoResult}
          isCorrectChain={isCorrectChain}
          onSweep={handleSweep}
          onDone={() => { void refetchEpData(); void refetchAgentBalance(); }}
        />
      )}
    </div>
  );
}
