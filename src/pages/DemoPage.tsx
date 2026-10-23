import { useState, useEffect, useRef, useCallback } from 'react';
import {
  useAccount, useReadContract, useWriteContract,
  useWaitForTransactionReceipt, useSwitchChain, usePublicClient, useSendTransaction,
} from 'wagmi';
import { toast } from 'sonner';
import {
  createWalletClient, http, type Hex, parseEther,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { type NetworkKey, NETWORKS } from '../config/networks';
import { ABI } from '../config/abi';
import { formatUsdc, formatAddr, txUrl } from '../lib/format';
import { decodeContractError } from '../lib/errors';
import { callWeatherApi, type LogEntry, type DemoApiConfig } from '../lib/demoApi';
import { getGasOverrides } from '../lib/gas';

interface Props { net: NetworkKey }

const CITIES = ['Paris', 'Tokyo', 'Lima'];
const LS_PREFIX = 'usdc-ppr:demo-agent:';

function lsKey(net: NetworkKey) { return LS_PREFIX + net; }

function readAgentKey(net: NetworkKey): Hex | null {
  try { const v = localStorage.getItem(lsKey(net)); return v?.startsWith('0x') ? v as Hex : null; } catch { return null; }
}
function saveAgentKey(net: NetworkKey, pk: Hex) { try { localStorage.setItem(lsKey(net), pk); } catch { /* ignore */ } }
function removeAgentKey(net: NetworkKey) { try { localStorage.removeItem(lsKey(net)); } catch { /* ignore */ } }

export function DemoPage({ net }: Props) {
  const cfg = NETWORKS[net];
  const { address, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: cfg.chain.id });

  // Step states
  const [agentKey, setAgentKey] = useState<Hex | null>(() => readAgentKey(net));
  // endpointId is derived from the chain read, not local state
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<string, { data?: unknown; error?: string; txHash?: string }>>({});
  const [step, setStep] = useState(1);

  const logRef = useRef<HTMLDivElement>(null);
  const logIdRef = useRef(0);
  const addLog = useCallback((e: LogEntry) => {
    setLogs(prev => [...prev, e]);
    setTimeout(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }), 50);
  }, []);
  const nextId = () => { logIdRef.current += 1; return logIdRef.current; };

  const agentAccount = agentKey ? privateKeyToAccount(agentKey) : null;
  const agentAddr = agentAccount?.address ?? null;

  // Agent balance
  const { data: agentBalance, refetch: refetchAgentBalance } = useReadContract({
    address: cfg.address, abi: ABI, functionName: 'creditOf',
    args: [agentAddr ?? '0x0000000000000000000000000000000000000000'],
    chainId: cfg.chain.id,
    query: { enabled: !!agentAddr },
  });

  // Agent native balance via wagmi useBalance doesn't work for arbitrary keys; use publicClient
  const [agentNativeBal, setAgentNativeBal] = useState<bigint | null>(null);
  useEffect(() => {
    if (!agentAddr || !publicClient) return;
    publicClient.getBalance({ address: agentAddr }).then(setAgentNativeBal).catch(() => {});
  }, [agentAddr, publicClient]);

  // My endpoints
  const { data: myEndpointIds, refetch: refetchEndpoints } = useReadContract({
    address: cfg.address, abi: ABI, functionName: 'endpointsOf',
    args: [address ?? '0x0000000000000000000000000000000000000000'],
    chainId: cfg.chain.id, query: { enabled: !!address },
  });

  // Derive the demo endpoint id from the endpoint list (last one is the candidate)
  const endpointId = myEndpointIds && myEndpointIds.length > 0
    ? myEndpointIds[myEndpointIds.length - 1]
    : null;

  // Endpoint details of candidate
  const { data: epData } = useReadContract({
    address: cfg.address, abi: ABI, functionName: 'getEndpoint',
    args: [endpointId ?? 0n], chainId: cfg.chain.id, query: { enabled: endpointId !== null },
  });
  const { data: epName } = useReadContract({
    address: cfg.address, abi: ABI, functionName: 'nameOf',
    args: [endpointId ?? 0n], chainId: cfg.chain.id, query: { enabled: endpointId !== null },
  });

  const isDemoEndpoint = epName === 'GET /v1/weather (demo)' && epData?.active;

  const isCorrectChain = chainId === cfg.chain.id;

  const PRICE_WEI = net === 'mainnet' ? parseEther('0.01') : parseEther('0.05');
  const FUND_WEI = net === 'mainnet' ? parseEther('0.05') : parseEther('0.30');

  // Register endpoint
  const { writeContract: writeRegister, data: regHash, isPending: regPending } = useWriteContract();
  const { isLoading: regConfirming } = useWaitForTransactionReceipt({ hash: regHash });

  // Fund agent (sendTransaction, not writeContract)
  const { sendTransaction: sendFund, data: fundHash, isPending: fundPending } = useSendTransaction();
  const { isLoading: fundConfirming } = useWaitForTransactionReceipt({ hash: fundHash });

  const handleGenerateKey = () => {
    const pk = generatePrivateKey();
    saveAgentKey(net, pk);
    setAgentKey(pk);
    setStep(s => Math.max(s, 2));
  };

  const handleForgetKey = () => {
    removeAgentKey(net);
    setAgentKey(null);
  };

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
      onSuccess: h => { toast.success('Demo endpoint registered', { description: <a href={txUrl(cfg.explorer, h)} target="_blank" rel="noopener" style={{ color: 'var(--accent)' }}>View</a> }); setStep(3); },
      onError: err => toast.error(decodeContractError(err)),
    });
  };

  // oxlint-disable react/purity
  // Run agent for a city — async event handler (never called during render)
  const handleRunCity = async (city: string) => {
    if (!agentKey || !agentAddr || !endpointId || !epData || !publicClient) return;
    setRunning(true);
    setLogs([]);
    setResults(prev => ({ ...prev, [city]: {} }));
    const tStart = performance.now();

    const apiCfg: DemoApiConfig = {
      chainId: cfg.chain.id,
      chain: cfg.chain,
      contractAddress: cfg.address,
      endpointId,
      price: epData.price,
      explorer: cfg.explorer,
    };

    const agentWallet = createWalletClient({ account: agentAccount!, chain: cfg.chain, transport: http(cfg.rpc) });

    try {
      // Step 1: call API (no token) → 402
      addLog({ id: nextId(), voice: 'agent', msg: `Requesting ${city} weather from API…` });
      const resp402 = await callWeatherApi({ cfg: apiCfg, city, payer: agentAddr, publicClient, onLog: addLog });
      if (resp402.status !== 402 || !('token' in resp402)) {
        addLog({ id: nextId(), voice: 'api', msg: `Unexpected response ${resp402.status}`, error: true });
        setRunning(false);
        return;
      }

      const { token, requestId } = resp402;
      const accept = resp402.body.accepts[0];
      const price = BigInt(accept.amount);

      // Step 2: agent validates
      addLog({ id: nextId(), voice: 'agent', msg: `Got 402 — price ${formatUsdc(price)} USDC, payTo ${accept.payTo.slice(0, 8)}… — validating…` });

      if (accept.payTo.toLowerCase() !== cfg.address.toLowerCase()) {
        addLog({ id: nextId(), voice: 'agent', msg: `REJECT: payTo is not our known contract`, error: true });
        setRunning(false);
        return;
      }
      if (price > parseEther('0.06')) {
        addLog({ id: nextId(), voice: 'agent', msg: `REJECT: price too high (${formatUsdc(price)} USDC)`, error: true });
        setRunning(false);
        return;
      }
      addLog({ id: nextId(), voice: 'agent', msg: `Validation passed — paying via pay(${endpointId}, ${requestId.slice(0, 10)}…)` });

      // Step 3: pay
      const tPay = performance.now();
      let gasOpts = {};
      try { gasOpts = await getGasOverrides(publicClient); } catch { /* ignore */ }
      let payHash: Hex;
      try {
        payHash = await agentWallet.writeContract({
          address: cfg.address, abi: ABI, functionName: 'pay',
          args: [endpointId, requestId],
          value: price,
          chain: cfg.chain,
          account: agentAccount!,
          ...gasOpts,
        });
      } catch (e) {
        addLog({ id: nextId(), voice: 'contract', msg: `pay() failed: ${decodeContractError(e)}`, error: true });
        setRunning(false);
        return;
      }

      addLog({ id: nextId(), voice: 'agent', msg: `pay() submitted`, link: txUrl(cfg.explorer, payHash), linkLabel: 'View tx' });

      let receipt;
      try {
        receipt = await publicClient.waitForTransactionReceipt({ hash: payHash, timeout: 60_000 });
      } catch {
        addLog({ id: nextId(), voice: 'contract', msg: `Timed out waiting for receipt`, error: true });
        setRunning(false);
        return;
      }

      const payMs = Math.round(performance.now() - tPay);
      addLog({ id: nextId(), voice: 'contract', msg: `Confirmed in block ${receipt.blockNumber} (${(payMs / 1000).toFixed(1)}s)`, link: txUrl(cfg.explorer, payHash), linkLabel: 'View tx', durationMs: payMs });

      // Step 4: retry with token + tx
      addLog({ id: nextId(), voice: 'agent', msg: `Retrying with X-Paywall-Token + X-Paywall-Tx…` });
      const tVerify = performance.now();
      const resp200 = await callWeatherApi({ cfg: apiCfg, city, payer: agentAddr, token, txHash: payHash, publicClient, onLog: addLog });
      const verifyMs = Math.round(performance.now() - tVerify);

      if (resp200.status === 200 && 'body' in resp200 && 'temperatureC' in resp200.body) {
        const wb = resp200.body as { temperatureC: number; conditions: string };
        addLog({ id: nextId(), voice: 'api', msg: `Served — ${city}: ${String(wb.temperatureC)}°C, ${wb.conditions} (verified in ${verifyMs}ms)`, durationMs: verifyMs });
        setResults(prev => ({ ...prev, [city]: { data: resp200.body, txHash: payHash } }));
        setStep(s => Math.max(s, 5));
        void refetchAgentBalance();
        void publicClient.getBalance({ address: agentAddr }).then(setAgentNativeBal).catch(() => {});
      } else {
        addLog({ id: nextId(), voice: 'api', msg: `Verification failed: ${JSON.stringify('body' in resp200 ? resp200.body : {})}`, error: true });
      }

      const totalMs = Math.round(performance.now() - tStart);
      addLog({ id: nextId(), voice: 'agent', msg: `Done — 402 in ~3ms, paid in ${(payMs / 1000).toFixed(1)}s, verified in ${verifyMs}ms, total ${(totalMs / 1000).toFixed(1)}s` });

    } catch (e) {
      addLog({ id: nextId(), voice: 'agent', msg: `Error: ${decodeContractError(e)}`, error: true });
    }
    setRunning(false);
  };
  // oxlint-enable react/purity

  // Sweep agent back to wallet
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
    } catch (e) { toast.error(decodeContractError(e)); }
  };

  // Cheat scenarios
  const firstSuccess = Object.entries(results).find(([, r]) => r.txHash);
  const firstCity = firstSuccess?.[0] ?? null;
  const firstTx = firstSuccess?.[1]?.txHash ?? null;

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', padding: '40px 16px' }}>
      <h1 className="display" style={{ fontSize: 28, fontWeight: 700, margin: '0 0 6px', color: 'var(--ink)', letterSpacing: '-0.03em' }}>
        An agent buys weather data, one request at a time
      </h1>
      <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 32px', lineHeight: 1.6 }}>
        Walk through the HTTP 402 paywall flow — the in-page API simulates the real server. For production, run{' '}
        <code className="mono" style={{ fontSize: 12 }}>node verifier/server.mjs</code>.
      </p>

      {/* Step 1: Connect wallet */}
      <StepCard n={1} title="Connect wallet" done={!!address} active={step >= 1}>
        {address ? (
          <p style={{ fontSize: 13, color: 'var(--success)', margin: 0 }}>Connected: <span className="mono" style={{ fontSize: 12 }}>{formatAddr(address)}</span></p>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>Connect your wallet using the button in the header.</p>
        )}
      </StepCard>

      {/* Step 2: Agent key */}
      <StepCard n={2} title="Create agent key" done={!!agentAddr} active={!!address}>
        {!agentKey ? (
          <div>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.5 }}>
              Generate a throwaway key for this demo. It lives in localStorage — never use it for real funds.
            </p>
            <button onClick={handleGenerateKey} style={primaryBtn}>Generate agent key</button>
          </div>
        ) : (
          <div>
            <p style={{ fontSize: 13, color: '#92400e', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 12px', margin: '0 0 12px', lineHeight: 1.5 }}>
              Hot key for this demo only — stored in your browser, never use for real funds.
            </p>
            <div style={{ fontSize: 13, marginBottom: 10 }}>
              Address: <span className="mono" style={{ fontSize: 12 }}>{agentAddr}</span>
            </div>
            <div style={{ fontSize: 13, marginBottom: 12 }}>
              Balance:{' '}
              <span style={{ fontWeight: 600, tabularNums: true } as React.CSSProperties}>
                {agentNativeBal !== null ? formatUsdc(agentNativeBal) : '—'} USDC
              </span>
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
              Your most recent endpoint is "{ epName || `#${endpointId}`}". It doesn't match the demo name. Register a fresh demo endpoint below.
            </p>
            <button onClick={handleRegisterEndpoint} disabled={!address || !isCorrectChain || regPending || regConfirming} style={primaryBtn}>
              {regPending ? 'Confirm…' : regConfirming ? 'Confirming…' : 'Register my demo endpoint'}
            </button>
          </div>
        ) : (
          <div>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 10px' }}>
              Registers a "GET /v1/weather (demo)" endpoint with price {net === 'mainnet' ? '0.01' : '0.05'} USDC, payee = your wallet.
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
            <button key={city} onClick={() => { void handleRunCity(city); }} disabled={running || !agentKey || !isDemoEndpoint}
              style={{ ...primaryBtn, opacity: (!agentKey || !isDemoEndpoint || running) ? 0.5 : 1 }}>
              {running ? '…' : `Buy ${city} weather`}
            </button>
          ))}
        </div>

        {/* Live log */}
        {logs.length > 0 && (
          <div ref={logRef} style={{ background: '#0d1b2f', borderRadius: 10, padding: '12px 14px', maxHeight: 280, overflowY: 'auto', marginTop: 12, fontSize: 12 }}>
            {logs.map(e => (
              <div key={e.id} style={{ display: 'flex', gap: 8, marginBottom: 5, alignItems: 'flex-start' }}>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, flexShrink: 0, padding: '1px 6px', borderRadius: 4, background: e.voice === 'agent' ? '#1e3a5f' : e.voice === 'api' ? '#1e4d2e' : '#3d1e0f', color: e.voice === 'agent' ? '#93c5fd' : e.voice === 'api' ? '#86efac' : '#fdba74' }}>
                  {e.voice.toUpperCase()}
                </span>
                <span style={{ color: e.error ? '#fca5a5' : '#e2e8f0', lineHeight: 1.5, flex: 1 }}>
                  {e.msg}
                  {e.link ? (
                    <> · <a href={e.link} target="_blank" rel="noopener noreferrer" style={{ color: '#93c5fd' }}>{e.linkLabel ?? 'link'}</a></>
                  ) : null}
                  {e.durationMs !== undefined && <span style={{ color: '#64748b' }}> ({e.durationMs}ms)</span>}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Results */}
        {Object.entries(results).map(([city, r]) => r.data ? (
          <div key={city} style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', marginTop: 10, fontSize: 13 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{city}</div>
            <pre style={{ margin: 0, fontFamily: "'JetBrains Mono', monospace", fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--ink-2)' }}>
              {JSON.stringify(r.data, null, 2)}
            </pre>
          </div>
        ) : null)}
      </StepCard>

      {/* Step 5: Try to cheat */}
      {step >= 5 && firstTx && firstCity && (
        <CheatStep net={net} city={firstCity} txHash={firstTx as Hex} endpointId={endpointId!} />
      )}

      {/* Step 6: Final accounting */}
      {step >= 5 && agentAddr && (
        <StepCard n={6} title="Accounting" done={false} active>
          <FinalAccounting net={net} address={address ?? null} agentAddr={agentAddr} onSweep={() => { void handleSweep(); }} />
        </StepCard>
      )}
    </div>
  );
}

function CheatStep({ net, city, txHash, endpointId }: { net: NetworkKey; city: string; txHash: Hex; endpointId: bigint }) {
  const cfg = NETWORKS[net];
  const { address, chainId } = useAccount();
  const { switchChain } = useSwitchChain();

  return (
    <StepCard n={5} title="Try to cheat" done={false} active>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 14px', lineHeight: 1.5 }}>
        These calls cost no gas — they are read-only preflight checks. See what the contract says.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <CheatRow label={`Reuse ${city} tx for Rome`} description="API says no_matching_payment — the requestId was bound to Paris, not Rome." />
        <CheatRow label="Pay Paris again" description="canPay returns AlreadyPaid — the contract never charges twice for the same requestId." />
        <CheatRow label="Another address pays your requestId" description="canPay returns RequestNotForPayer — top 20 bytes of requestId = you." />
        <div style={{ marginTop: 8 }}>
          <a href={txUrl(cfg.explorer, txHash)} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: 'var(--accent)' }}>
            View the original pay() tx on explorer
          </a>
        </div>
      </div>
    </StepCard>
  );
}

function CheatRow({ label, description }: { label: string; description: string }) {
  return (
    <div style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px' }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{description}</div>
    </div>
  );
}

function FinalAccounting({ net, address, agentAddr, onSweep }: { net: NetworkKey; address: string | null; agentAddr: string; onSweep: () => void }) {
  const cfg = NETWORKS[net];
  const { data: walletCredit } = useReadContract({ address: cfg.address, abi: ABI, functionName: 'creditOf', args: [address as Hex ?? '0x0000000000000000000000000000000000000000'], chainId: cfg.chain.id, query: { enabled: !!address } });
  const { data: globalPaid } = useReadContract({ address: cfg.address, abi: ABI, functionName: 'totalPaid', chainId: cfg.chain.id });
  const { data: globalRefunded } = useReadContract({ address: cfg.address, abi: ABI, functionName: 'totalRefunded', chainId: cfg.chain.id });
  const { data: globalWithdrawn } = useReadContract({ address: cfg.address, abi: ABI, functionName: 'totalWithdrawn', chainId: cfg.chain.id });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Row label="Your credit" value={walletCredit !== undefined ? `${formatUsdc(walletCredit)} USDC` : '—'} />
      <Row label="Global paid" value={globalPaid !== undefined ? `${formatUsdc(globalPaid)} USDC` : '—'} />
      <Row label="Global refunded" value={globalRefunded !== undefined ? `${formatUsdc(globalRefunded)} USDC` : '—'} />
      <Row label="Global withdrawn" value={globalWithdrawn !== undefined ? `${formatUsdc(globalWithdrawn)} USDC` : '—'} />
      <button onClick={onSweep} style={{ ...ghostBtn, alignSelf: 'flex-start', marginTop: 8 }}>Sweep agent key back to my wallet</button>
    </div>
  );
}

function StepCard({ n, title, done, active, children }: { n: number; title: string; done: boolean; active: boolean; children: React.ReactNode }) {
  return (
    <div style={{ background: active ? 'var(--surface-strong)' : 'var(--surface-muted)', border: `1px solid ${active ? 'var(--border-strong)' : 'var(--border)'}`, borderRadius: 14, padding: '20px', marginBottom: 16, backdropFilter: 'blur(8px)', opacity: active ? 1 : 0.6 }}>
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

const primaryBtn: React.CSSProperties = {
  padding: '10px 18px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8,
  fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
};

const ghostBtn: React.CSSProperties = {
  padding: '9px 16px', background: 'transparent', color: 'var(--ink-2)', border: '1px solid var(--border)', borderRadius: 8,
  fontSize: 14, fontWeight: 500, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
};
