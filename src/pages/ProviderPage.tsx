import { useState } from 'react';
import React from 'react';
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt, useSwitchChain } from 'wagmi';
import { toast } from 'sonner';
import { parseEther, type Hex, isAddress, createPublicClient, http } from 'viem';
import { type NetworkKey, NETWORKS } from '../config/networks';
import { ABI } from '../config/abi';
import { formatUsdc, formatAddr, formatB32, txUrl } from '../lib/format';
import { decodeContractError } from '../lib/errors';

interface Props { net: NetworkKey }

export function ProviderPage({ net }: Props) {
  const cfg = NETWORKS[net];
  const { address, chainId } = useAccount();
  const { switchChain } = useSwitchChain();

  if (!cfg.address) return <Center>Not deployed on this network yet.</Center>;
  if (!address) return <Center>Connect your wallet to manage endpoints.</Center>;

  return (
    <ProviderPageInner net={net} address={address} chainId={chainId} switchChain={switchChain} />
  );
}

function ProviderPageInner({ net, address, chainId, switchChain }: {
  net: NetworkKey;
  address: `0x${string}`;
  chainId: number | undefined;
  switchChain: ReturnType<typeof useSwitchChain>['switchChain'];
}) {
  const cfg = NETWORKS[net];
  const isCorrectChain = chainId === cfg.chain.id;

  // My credit
  const { data: myCredit, refetch: refetchCredit } = useReadContract({
    address: cfg.address, abi: ABI, functionName: 'creditOf', args: [address], chainId: cfg.chain.id,
  });

  // My endpoints
  const { data: myEndpointIds, refetch: refetchEndpoints } = useReadContract({
    address: cfg.address, abi: ABI, functionName: 'endpointsOf', args: [address], chainId: cfg.chain.id,
  });

  const refetchAll = () => { void refetchCredit(); void refetchEndpoints(); };

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', padding: '40px 16px' }}>
      <h1 className="display" style={{ fontSize: 26, fontWeight: 700, margin: '0 0 6px', color: 'var(--ink)', letterSpacing: '-0.03em' }}>Provider Dashboard</h1>
      <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 32px' }}>
        Connected as <span className="mono" style={{ fontSize: 12 }}>{formatAddr(address)}</span>
        {!isCorrectChain && (
          <button onClick={() => switchChain({ chainId: cfg.chain.id })} style={{ marginLeft: 10, padding: '3px 10px', borderRadius: 6, background: '#fef3c7', border: '1px solid #fde68a', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#92400e' }}>
            Switch to {cfg.chain.name}
          </button>
        )}
      </p>

      {/* Credit card */}
      <CreditCard net={net} address={address} myCredit={myCredit} isCorrectChain={isCorrectChain} onDone={refetchAll} />

      {/* Register endpoint */}
      <RegisterCard net={net} address={address} isCorrectChain={isCorrectChain} onDone={refetchAll} />

      {/* Approve provider */}
      <ApproveCard net={net} address={address} isCorrectChain={isCorrectChain} />

      {/* My endpoints */}
      <div style={{ marginTop: 32 }}>
        <h2 className="display" style={{ fontSize: 18, fontWeight: 600, margin: '0 0 16px', color: 'var(--ink)', letterSpacing: '-0.02em' }}>My Endpoints</h2>
        {!myEndpointIds || myEndpointIds.length === 0 ? (
          <p style={{ fontSize: 14, color: 'var(--muted)' }}>No endpoints yet. Register one above.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {myEndpointIds.map(id => (
              <EndpointCard key={String(id)} net={net} id={id} providerAddr={address} isCorrectChain={isCorrectChain} onDone={refetchAll} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CreditCard({ net, address, myCredit, isCorrectChain, onDone }: { net: NetworkKey; address: Hex; myCredit: bigint | undefined; isCorrectChain: boolean; onDone: () => void }) {
  const cfg = NETWORKS[net];
  const [withdrawTo, setWithdrawTo] = useState(address);
  const [withdrawAmt, setWithdrawAmt] = useState('');

  const { writeContract, data: hash, isPending } = useWriteContract();
  const { isLoading: confirming } = useWaitForTransactionReceipt({ hash });

  const handleWithdraw = () => {
    if (!isCorrectChain) return;
    const amt = withdrawAmt ? parseEther(withdrawAmt) : myCredit ?? 0n;
    if (amt === 0n) return;
    writeContract({ address: cfg.address, abi: ABI, functionName: 'withdraw', args: [withdrawTo, amt], chainId: cfg.chain.id }, {
      onSuccess: h => { toast.success('Withdrawn', { description: <a href={txUrl(cfg.explorer, h)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>View on explorer</a> }); onDone(); },
      onError: err => toast.error(decodeContractError(err)),
    });
  };

  return (
    <Card title="My Credit">
      <div className="display" style={{ fontSize: 28, fontWeight: 700, color: 'var(--ink)', marginBottom: 16, tabularNums: true } as React.CSSProperties}>
        {myCredit !== undefined ? formatUsdc(myCredit) : '—'} <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--muted)' }}>USDC</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
        <input value={withdrawTo} onChange={e => setWithdrawTo(e.target.value as Hex)} placeholder="To address" className="mono" style={{ flex: 2, minWidth: 200, border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px', fontSize: 12, outline: 'none', background: '#fff' }} />
        <input value={withdrawAmt} onChange={e => setWithdrawAmt(e.target.value)} placeholder={`All (${formatUsdc(myCredit)} USDC)`} style={{ flex: 1, minWidth: 120, border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px', fontSize: 13, outline: 'none', background: '#fff', fontFamily: "'DM Sans', sans-serif" }} />
        <button onClick={handleWithdraw} disabled={!isCorrectChain || isPending || confirming || !myCredit || myCredit === 0n}
          style={{ padding: '10px 18px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", opacity: (!isCorrectChain || !myCredit || myCredit === 0n) ? 0.5 : 1 }}>
          {isPending ? 'Confirm…' : confirming ? 'Confirming…' : 'Withdraw'}
        </button>
      </div>
    </Card>
  );
}

function RegisterCard({ net, address, isCorrectChain, onDone }: { net: NetworkKey; address: Hex; isCorrectChain: boolean; onDone: () => void }) {
  const cfg = NETWORKS[net];
  const [name, setName] = useState('');
  const [price, setPrice] = useState('0.01');
  const [payee, setPayee] = useState<string>(address);

  const { data: preflightApproved } = useReadContract({
    address: cfg.address, abi: ABI, functionName: 'isProviderApproved',
    args: [payee as Hex, address],
    chainId: cfg.chain.id,
    query: { enabled: isAddress(payee) },
  });

  const { writeContract, data: hash, isPending } = useWriteContract();
  const { isLoading: confirming } = useWaitForTransactionReceipt({ hash });

  const nameBytes = new TextEncoder().encode(name).length;
  const nameOk = nameBytes >= 1 && nameBytes <= 64;
  const payeeOk = isAddress(payee) && payee.toLowerCase() !== cfg.address.toLowerCase();
  const priceOk = !!price && !isNaN(Number(price)) && Number(price) > 0;
  const approvalOk = preflightApproved !== false;

  const handleRegister = () => {
    if (!isCorrectChain || !nameOk || !payeeOk || !priceOk) return;
    const priceWei = parseEther(price);
    writeContract({ address: cfg.address, abi: ABI, functionName: 'registerEndpoint', args: [priceWei as unknown as bigint & { __tag: 'uint128' }, payee, name], chainId: cfg.chain.id }, {
      onSuccess: h => { toast.success('Endpoint registered', { description: <a href={txUrl(cfg.explorer, h)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>View on explorer</a> }); onDone(); },
      onError: err => toast.error(decodeContractError(err)),
    });
  };

  return (
    <Card title="Register Endpoint">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <Label>Name (1–64 bytes)</Label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="GET /v1/weather (demo)" style={inputStyle} />
          {name && !nameOk && <Hint error>Name must be 1–64 bytes.</Hint>}
        </div>
        <div>
          <Label>Price (native USDC, 18 decimals)</Label>
          <input value={price} onChange={e => setPrice(e.target.value)} placeholder="0.01" style={inputStyle} />
        </div>
        <div>
          <Label>Payee address (receives credit; fixed for endpoint life)</Label>
          <input value={payee} onChange={e => setPayee(e.target.value)} className="mono" style={{ ...inputStyle, fontSize: 12 }} />
          {payee !== address && isAddress(payee) && preflightApproved === false && (
            <Hint error>This payee has not approved you. Ask them to call approveProvider first.</Hint>
          )}
          <Hint>The payee is fixed at registration. To change it, register a new endpoint.</Hint>
        </div>
        <button onClick={handleRegister}
          disabled={!isCorrectChain || !nameOk || !payeeOk || !priceOk || !approvalOk || isPending || confirming}
          style={{ alignSelf: 'flex-start', padding: '10px 20px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", opacity: (!isCorrectChain || !nameOk || !payeeOk || !priceOk || !approvalOk) ? 0.5 : 1 }}>
          {isPending ? 'Confirm…' : confirming ? 'Confirming…' : 'Register endpoint'}
        </button>
      </div>
    </Card>
  );
}

function ApproveCard({ net, address, isCorrectChain }: { net: NetworkKey; address: Hex; isCorrectChain: boolean }) {
  const cfg = NETWORKS[net];
  const [provider, setProvider] = useState('');
  const [approve, setApprove] = useState(true);

  const { writeContract, data: hash, isPending } = useWriteContract();
  const { isLoading: confirming } = useWaitForTransactionReceipt({ hash });

  const handleApprove = () => {
    if (!isAddress(provider) || !isCorrectChain) return;
    writeContract({ address: cfg.address, abi: ABI, functionName: 'approveProvider', args: [provider, approve], chainId: cfg.chain.id }, {
      onSuccess: h => toast.success(approve ? 'Provider approved' : 'Provider revoked', { description: <a href={txUrl(cfg.explorer, h)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>View</a> }),
      onError: err => toast.error(decodeContractError(err)),
    });
  };

  return (
    <Card title="Approve a Provider (Payee controls)">
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.5 }}>
        As a payee, allow or revoke a provider from registering future endpoints that credit you. Existing endpoints are unaffected.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
        <input value={provider} onChange={e => setProvider(e.target.value)} placeholder="Provider address" className="mono" style={{ flex: 2, minWidth: 200, border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px', fontSize: 12, outline: 'none', background: '#fff' }} />
        <select value={approve ? 'approve' : 'revoke'} onChange={e => setApprove(e.target.value === 'approve')} style={{ padding: '9px 12px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, fontFamily: "'DM Sans', sans-serif", background: '#fff' }}>
          <option value="approve">Approve</option>
          <option value="revoke">Revoke</option>
        </select>
        <button onClick={handleApprove} disabled={!isAddress(provider) || !isCorrectChain || isPending || confirming}
          style={{ padding: '10px 18px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", opacity: !isAddress(provider) ? 0.5 : 1 }}>
          {isPending ? 'Confirm…' : confirming ? 'Confirming…' : 'Submit'}
        </button>
      </div>
    </Card>
  );
}

function EndpointCard({ net, id, providerAddr, isCorrectChain, onDone }: { net: NetworkKey; id: bigint; providerAddr: Hex; isCorrectChain: boolean; onDone: () => void }) {
  const cfg = NETWORKS[net];
  const [newPrice, setNewPrice] = useState('');

  const { data: ep } = useReadContract({ address: cfg.address, abi: ABI, functionName: 'getEndpoint', args: [id], chainId: cfg.chain.id });
  const { data: name } = useReadContract({ address: cfg.address, abi: ABI, functionName: 'nameOf', args: [id], chainId: cfg.chain.id });

  const { writeContract, data: setPriceHash, isPending: priceP } = useWriteContract();
  const { isLoading: priceC } = useWaitForTransactionReceipt({ hash: setPriceHash });
  const { writeContract: writeActive, data: activeHash, isPending: activeP } = useWriteContract();
  const { isLoading: activeC } = useWaitForTransactionReceipt({ hash: activeHash });

  if (!ep || ep.provider.toLowerCase() !== providerAddr.toLowerCase()) return null;

  const handleSetPrice = () => {
    if (!newPrice || isNaN(Number(newPrice)) || !isCorrectChain) return;
    const priceWei = parseEther(newPrice);
    writeContract({ address: cfg.address, abi: ABI, functionName: 'setPrice', args: [id, priceWei as unknown as bigint & { __tag: 'uint128' }], chainId: cfg.chain.id }, {
      onSuccess: h => { toast.success('Price updated', { description: <a href={txUrl(cfg.explorer, h)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>View</a> }); onDone(); setNewPrice(''); },
      onError: err => toast.error(decodeContractError(err)),
    });
  };

  const handleToggleActive = () => {
    if (!isCorrectChain) return;
    writeActive({ address: cfg.address, abi: ABI, functionName: 'setActive', args: [id, !ep.active], chainId: cfg.chain.id }, {
      onSuccess: h => { toast.success(ep.active ? 'Endpoint paused' : 'Endpoint resumed', { description: <a href={txUrl(cfg.explorer, h)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>View</a> }); onDone(); },
      onError: err => toast.error(decodeContractError(err)),
    });
  };

  return (
    <div style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px', backdropFilter: 'blur(8px)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)' }}>{name || `Endpoint #${id}`}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            ID {String(id)} · Paid {String(ep.paidCount)} · {formatUsdc(ep.totalPaid)} USDC collected
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ padding: '3px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, background: ep.active ? '#dcfce7' : '#fef2f2', color: ep.active ? '#166534' : '#991b1b' }}>{ep.active ? 'Active' : 'Paused'}</span>
          <button onClick={handleToggleActive} disabled={!isCorrectChain || activeP || activeC} style={{ padding: '4px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, background: 'var(--surface-muted)', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
            {activeP || activeC ? '…' : ep.active ? 'Pause' : 'Resume'}
          </button>
          <a href={`#/${net}/e/${id}`} style={{ padding: '4px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, color: 'var(--ink-2)', textDecoration: 'none', background: 'var(--surface-muted)' }}>View</a>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>Price: {formatUsdc(ep.price)} USDC</span>
        <input value={newPrice} onChange={e => setNewPrice(e.target.value)} placeholder="New price" style={{ width: 100, border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', fontSize: 12, fontFamily: "'DM Sans', sans-serif", outline: 'none', background: '#fff' }} />
        <button onClick={handleSetPrice} disabled={!newPrice || !isCorrectChain || priceP || priceC} style={{ padding: '5px 12px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", opacity: !newPrice ? 0.5 : 1 }}>
          {priceP || priceC ? '…' : 'Set price'}
        </button>
      </div>
      <p style={{ fontSize: 11, color: 'var(--muted)', margin: '6px 0 0' }}>Price change applies to new payments only.</p>
      <EndpointLogTable net={net} id={id} payeeCredit={ep ? undefined : undefined} epPayee={ep?.payee} isCorrectChain={isCorrectChain} myCredit={undefined} onRefundDone={onDone} />
    </div>
  );
}

// ── Paid-request log table for an endpoint (F5) ──
interface PaidRow {
  blockNumber: bigint;
  txHash: string;
  requestId: Hex;
  payer: string;
  amount: bigint;
  paidAt: number; // timestamp from block (may be 0 if unavailable)
  refunded: boolean;
}

function EndpointLogTable({ net, id, epPayee, isCorrectChain, onRefundDone }: {
  net: NetworkKey;
  id: bigint;
  epPayee: string | undefined;
  payeeCredit: bigint | undefined;
  isCorrectChain: boolean;
  myCredit: bigint | undefined;
  onRefundDone: () => void;
}) {
  const cfg = NETWORKS[net];
  const { address } = useAccount();
  const [rows, setRows] = useState<PaidRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const scanStateRef = React.useRef<{ nextHead: bigint } | null>(null);

  const { data: myCredit, refetch: refetchCredit } = useReadContract({
    address: cfg.address, abi: ABI, functionName: 'creditOf',
    args: [address ?? '0x0000000000000000000000000000000000000000'],
    chainId: cfg.chain.id, query: { enabled: !!address },
  });

  const CHUNK = 9000n;
  const MAX_CHUNKS = 40;

  const PAID_EVENT = {
    type: 'event' as const, name: 'Paid' as const,
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

  const loadLogs = async (loadMore: boolean) => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const pc = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpc) });
      const head = await pc.getBlockNumber();
      // Backwards: start from head (or previous scan head - 1) down to deploymentBlock
      const start = loadMore && scanStateRef.current ? scanStateRef.current.nextHead : head;
      const floor = cfg.deploymentBlock;

      const newRows: PaidRow[] = [];
      let refundedSet = new Set<string>();

      // Collect refunds in parallel chunks (same window) — first pass: scan and collect
      const chunksToScan: Array<{ from: bigint; to: bigint }> = [];
      let cur = start;
      let chunksScanned = 0;
      while (cur >= floor && chunksScanned < MAX_CHUNKS) {
        const from = cur - CHUNK + 1n < floor ? floor : cur - CHUNK + 1n;
        chunksToScan.push({ from, to: cur });
        cur = from - 1n;
        chunksScanned++;
      }

      // Scan 4 chunks in parallel
      const incomplete_ = cur >= floor;
      const batches: Array<Array<{ from: bigint; to: bigint }>> = [];
      for (let i = 0; i < chunksToScan.length; i += 4) batches.push(chunksToScan.slice(i, i + 4));

      for (const batch of batches) {
        const results = await Promise.all(batch.map(async ({ from, to }) => {
          const [paid, refunded] = await Promise.all([
            pc.getLogs({ address: cfg.address, event: PAID_EVENT, args: { endpointId: id }, fromBlock: from, toBlock: to }).catch(() => []),
            pc.getLogs({ address: cfg.address, event: REFUNDED_EVENT, args: { endpointId: id }, fromBlock: from, toBlock: to }).catch(() => []),
          ]);
          return { paid, refunded };
        }));
        for (const { refunded } of results) {
          for (const l of refunded) {
            const a = l.args as { requestId?: Hex };
            if (a.requestId) refundedSet.add(a.requestId.toLowerCase());
          }
        }
        for (const { paid } of results) {
          for (const l of paid) {
            const a = l.args as { requestId?: Hex; payer?: string; amount?: bigint };
            if (!a.requestId) continue;
            newRows.push({
              blockNumber: l.blockNumber ?? 0n,
              txHash: l.transactionHash ?? '',
              requestId: a.requestId,
              payer: a.payer ?? '',
              amount: a.amount ?? 0n,
              paidAt: 0,
              refunded: refundedSet.has(a.requestId.toLowerCase()),
            });
          }
        }
      }

      // Sort descending by block
      newRows.sort((a, b) => (a.blockNumber > b.blockNumber ? -1 : a.blockNumber < b.blockNumber ? 1 : 0));

      scanStateRef.current = { nextHead: cur };
      setHasMore(incomplete_);
      setIncomplete(incomplete_);
      setRows(prev => loadMore ? [...prev, ...newRows] : newRows);
    } catch (e) {
      setError(String(e));
    }
    setLoading(false);
  };

  const { writeContract: writeRefund, data: refundHash, isPending: refundP } = useWriteContract();
  const { isLoading: refundC, isSuccess: refundDone } = useWaitForTransactionReceipt({ hash: refundHash });
  React.useEffect(() => { if (refundDone) { void refetchCredit(); onRefundDone(); } }, [refundDone]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefund = (requestId: Hex, amount: bigint) => {
    if (!isCorrectChain) return;
    if (!window.confirm(`Refund ${formatUsdc(amount)} USDC for this request?`)) return;
    writeRefund({ address: cfg.address, abi: ABI, functionName: 'refund', args: [requestId], chainId: cfg.chain.id }, {
      onSuccess: h => toast.success('Refunded', { description: <a href={txUrl(cfg.explorer, h)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>View</a> }),
      onError: err => toast.error(decodeContractError(err)),
    });
  };

  const isPayee = address && epPayee && address.toLowerCase() === epPayee.toLowerCase();

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>Paid requests</span>
        <button onClick={() => { void loadLogs(false); }}
          disabled={loading}
          style={{ padding: '4px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, background: 'var(--surface-muted)', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", opacity: loading ? 0.5 : 1 }}>
          {loading ? 'Loading…' : rows.length === 0 ? 'Load history' : 'Reload'}
        </button>
      </div>
      {error && (
        <p style={{ fontSize: 12, color: 'var(--danger)', margin: '0 0 8px' }}>
          Error loading logs. <button onClick={() => { void loadLogs(false); }} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 12, padding: 0 }}>Retry</button>
          {incomplete && <span style={{ marginLeft: 6, color: 'var(--muted)' }}>History may be incomplete.</span>}
        </p>
      )}
      {rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--muted)', textAlign: 'left' }}>
                <th style={{ padding: '4px 6px 6px 0', fontWeight: 500 }}>requestId</th>
                <th style={{ padding: '4px 6px', fontWeight: 500 }}>Payer</th>
                <th style={{ padding: '4px 6px', fontWeight: 500 }}>Amount</th>
                <th style={{ padding: '4px 6px', fontWeight: 500 }}>Block</th>
                {isPayee && <th style={{ padding: '4px 6px', fontWeight: 500 }}>Action</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '5px 6px 5px 0', fontFamily: "'JetBrains Mono', monospace" }}>
                    <a href={`#/${net}/r/${r.requestId}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{formatB32(r.requestId)}</a>
                    {r.refunded && <span style={{ marginLeft: 6, padding: '1px 5px', borderRadius: 8, fontSize: 10, fontWeight: 600, background: '#fef2f2', color: '#991b1b' }}>Refunded</span>}
                  </td>
                  <td style={{ padding: '5px 6px', fontFamily: "'JetBrains Mono', monospace', color: 'var(--ink-2)'" }}>{formatAddr(r.payer)}</td>
                  <td style={{ padding: '5px 6px', tabularNums: true } as React.CSSProperties}>{formatUsdc(r.amount)} USDC</td>
                  <td style={{ padding: '5px 6px', color: 'var(--muted)' }}>{String(r.blockNumber)}</td>
                  {isPayee && (
                    <td style={{ padding: '5px 6px' }}>
                      <button onClick={() => handleRefund(r.requestId, r.amount)}
                        disabled={r.refunded || !isCorrectChain || refundP || refundC || (myCredit !== undefined && myCredit < r.amount)}
                        style={{ padding: '2px 8px', border: '1px solid var(--border)', borderRadius: 5, fontSize: 11, background: r.refunded ? 'var(--surface-muted)' : 'var(--surface-strong)', cursor: r.refunded ? 'default' : 'pointer', color: 'var(--ink-2)', fontFamily: "'DM Sans', sans-serif", opacity: (r.refunded || (myCredit !== undefined && myCredit < r.amount)) ? 0.4 : 1 }}>
                        {r.refunded ? 'Refunded' : refundP || refundC ? '…' : 'Refund'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hasMore && !loading && (
        <button onClick={() => { void loadLogs(true); }}
          style={{ marginTop: 8, padding: '5px 14px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, background: 'var(--surface-muted)', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
          Load older
        </button>
      )}
      {incomplete && !loading && (
        <p style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 0' }}>History may be incomplete — scan limit reached.</p>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)', borderRadius: 14, padding: '20px', marginBottom: 20, backdropFilter: 'blur(8px)' }}>
      <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 16, fontWeight: 600, margin: '0 0 14px', color: 'var(--ink)', letterSpacing: '-0.02em' }}>{title}</h2>
      {children}
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div style={{ maxWidth: 480, margin: '80px auto', textAlign: 'center', color: 'var(--muted)', padding: '0 16px', fontSize: 15 }}>{children}</div>;
}

function Label({ children }: { children: React.ReactNode }) {
  return <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginBottom: 4 }}>{children}</label>;
}

function Hint({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return <p style={{ fontSize: 11, color: error ? 'var(--danger)' : 'var(--muted)', margin: '4px 0 0', lineHeight: 1.4 }}>{children}</p>;
}

const inputStyle: React.CSSProperties = {
  width: '100%', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px',
  fontSize: 13, fontFamily: "'DM Sans', sans-serif", outline: 'none', background: '#fff',
};
