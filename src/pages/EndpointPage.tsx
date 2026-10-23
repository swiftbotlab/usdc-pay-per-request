import { useState } from 'react';
import { useReadContract, useWriteContract, useWaitForTransactionReceipt, useAccount, useSwitchChain } from 'wagmi';
import { toast } from 'sonner';
import { parseEther, isAddress, type Hex } from 'viem';
import { type NetworkKey, NETWORKS } from '../config/networks';
import { ABI } from '../config/abi';
import { formatUsdc, formatAddr, txUrl } from '../lib/format';
import { decodeContractError } from '../lib/errors';
import { computeRequestId } from '../lib/paywall';

interface Props { net: NetworkKey; id: string }

export function EndpointPage({ net, id }: Props) {
  const cfg = NETWORKS[net];
  const { address, chainId } = useAccount();
  const { switchChain } = useSwitchChain();

  const isValidId = /^[1-9]\d*$/.test(id);

  const { data: epCount } = useReadContract({ address: cfg.address, abi: ABI, functionName: 'endpointCount', chainId: cfg.chain.id });
  const { data: ep } = useReadContract({ address: cfg.address, abi: ABI, functionName: 'getEndpoint', args: [isValidId ? BigInt(id) : 0n], chainId: cfg.chain.id, query: { enabled: isValidId } });
  const { data: epName } = useReadContract({ address: cfg.address, abi: ABI, functionName: 'nameOf', args: [isValidId ? BigInt(id) : 0n], chainId: cfg.chain.id, query: { enabled: isValidId } });

  const [customRid, setCustomRid] = useState('');
  const [useMyAddr, setUseMyAddr] = useState(true);

  // Build requestId for "Pay a requestId" form
  const boundRid: Hex | null = (() => {
    if (useMyAddr && address && ep && ep.provider !== '0x0000000000000000000000000000000000000000') {
      const tok = ('0x' + 'ab'.repeat(32)) as Hex;
      return computeRequestId({ chainId: cfg.chain.id, contract: cfg.address, endpointId: BigInt(id), payer: address, resource: `PAY /endpoint/${id}`, token: tok }).requestId;
    }
    return null;
  })();

  const ridInput: Hex | null = (() => {
    if (!useMyAddr) return customRid.startsWith('0x') && customRid.length === 66 ? customRid as Hex : null;
    return boundRid;
  })();

  const { data: canPayResult } = useReadContract({
    address: cfg.address, abi: ABI, functionName: 'canPay',
    args: [isValidId ? BigInt(id) : 0n, ridInput ?? '0x0000000000000000000000000000000000000000000000000000000000000001', address ?? '0x0000000000000000000000000000000000000000', ep?.price ?? 0n],
    chainId: cfg.chain.id,
    query: { enabled: isValidId && !!ridInput && !!address && !!ep },
  });

  const REASON_LABELS = ['OK', 'Unknown endpoint', 'Endpoint paused', 'Zero requestId', 'requestId belongs to another address', 'Already paid', 'Wrong amount'];

  const { writeContract, data: payHash, isPending: payPending } = useWriteContract();
  const { isLoading: payConfirming, isSuccess: paySuccess } = useWaitForTransactionReceipt({ hash: payHash });

  const handlePay = () => {
    if (!ep || !ridInput) return;
    if (chainId !== cfg.chain.id) { switchChain({ chainId: cfg.chain.id }); return; }
    writeContract({
      address: cfg.address, abi: ABI, functionName: 'pay',
      args: [BigInt(id), ridInput],
      value: ep.price,
      chainId: cfg.chain.id,
    }, {
      onSuccess: hash => toast.success('Transaction submitted', { description: <a href={txUrl(cfg.explorer, hash)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>View on explorer</a> }),
      onError: err => toast.error(decodeContractError(err)),
    });
  };

  if (!isValidId) {
    return <NotFound message="Not a valid endpoint ID." />;
  }

  if (epCount !== undefined && BigInt(id) > epCount) {
    return <NotFound message={`Endpoint #${id} not found (total: ${epCount.toString()}).`} />;
  }

  if (!ep || ep.provider === '0x0000000000000000000000000000000000000000') {
    return <NotFound message={`Endpoint #${id} not found.`} />;
  }

  const explorerAddr = `${cfg.explorer}/address`;
  const curlSnippet = `curl -H "X-Payer: <your address>" \\
     https://your-api.example.com/v1/weather?city=Paris
# → 402 with requestId and token

# After paying:
curl -H "X-Payer: <your address>" \\
     -H "X-Paywall-Token: <token from 402>" \\
     -H "X-Paywall-Tx: <tx hash>" \\
     https://your-api.example.com/v1/weather?city=Paris`;

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '40px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <a href={`#/${net}`} style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none' }}>Home</a>
        <span style={{ color: 'var(--border-strong)' }}>/</span>
        <span style={{ fontSize: 13, color: 'var(--ink-2)', fontWeight: 500 }}>Endpoint #{id}</span>
      </div>

      <Card>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
          <div>
            <h1 className="display" style={{ fontSize: 22, fontWeight: 700, margin: '0 0 4px', color: 'var(--ink)', letterSpacing: '-0.02em' }}>
              {epName || `Endpoint #${id}`}
            </h1>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>ID {id}</p>
          </div>
          <StatusBadge active={ep.active} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
          <StatCard label="Price" value={`${formatUsdc(ep.price)} USDC`} />
          <StatCard label="Requests paid" value={String(ep.paidCount)} />
          <StatCard label="Total paid" value={`${formatUsdc(ep.totalPaid)} USDC`} />
        </div>
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: 'var(--ink-2)' }}>
          <div>Provider: <a href={`${explorerAddr}/${ep.provider}`} target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize: 12, color: 'var(--accent)' }}>{ep.provider}</a></div>
          <div>Payee: <a href={`${explorerAddr}/${ep.payee}`} target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize: 12, color: 'var(--accent)' }}>{ep.payee}</a></div>
        </div>
      </Card>

      {/* Call snippet */}
      <Section title="Call it">
        <code className="mono" style={{ display: 'block', background: 'var(--surface-muted)', borderRadius: 8, padding: '14px 16px', fontSize: 11.5, lineHeight: 1.8, color: 'var(--ink-2)', whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
          {curlSnippet}
        </code>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
          The <code className="mono">X-Payer</code> header is required — the server binds the requestId to it so only your address can pay it.
        </p>
      </Section>

      {/* Pay a requestId */}
      {cfg.address && (
        <Section title="Pay a requestId">
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
              <input type="radio" checked={useMyAddr} onChange={() => setUseMyAddr(true)} />
              New requestId for my address
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
              <input type="radio" checked={!useMyAddr} onChange={() => setUseMyAddr(false)} />
              Enter requestId
            </label>
          </div>
          {!useMyAddr && (
            <input
              value={customRid}
              onChange={e => setCustomRid(e.target.value)}
              placeholder="0x... (66 hex chars)"
              className="mono"
              style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px', fontSize: 12, marginBottom: 10, outline: 'none', background: '#fff' }}
            />
          )}
          {useMyAddr && !address && (
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 10px' }}>Connect your wallet to generate a bound requestId.</p>
          )}
          {ridInput && (
            <div style={{ fontSize: 12, color: 'var(--ink-2)', marginBottom: 10, wordBreak: 'break-all' }}>
              <span style={{ color: 'var(--muted)' }}>requestId: </span>
              <span className="mono">{ridInput}</span>
            </div>
          )}
          {canPayResult && ridInput && (
            <div style={{ marginBottom: 10, fontSize: 13, color: canPayResult[0] ? 'var(--success)' : 'var(--danger)' }}>
              {canPayResult[0] ? 'Ready to pay' : `Cannot pay: ${REASON_LABELS[canPayResult[1]] ?? 'Unknown reason'}`}
            </div>
          )}
          {paySuccess && payHash && (
            <div style={{ fontSize: 13, color: 'var(--success)', marginBottom: 10 }}>
              Paid! <a href={txUrl(cfg.explorer, payHash)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>View on explorer</a>
            </div>
          )}
          <button
            onClick={handlePay}
            disabled={!address || !ridInput || payPending || payConfirming || (canPayResult ? !canPayResult[0] : false)}
            style={{
              padding: '10px 20px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8,
              fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", opacity: (!address || !ridInput || payPending || payConfirming) ? 0.5 : 1,
            }}
          >
            {payPending ? 'Confirm in wallet…' : payConfirming ? 'Confirming…' : `Pay ${formatUsdc(ep.price)} USDC`}
          </button>
        </Section>
      )}
    </div>
  );
}

function NotFound({ message }: { message: string }) {
  return (
    <div style={{ maxWidth: 480, margin: '80px auto', textAlign: 'center', color: 'var(--muted)', padding: '0 16px' }}>
      <p style={{ fontSize: 16 }}>{message}</p>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)', borderRadius: 14, padding: '20px', marginBottom: 24, backdropFilter: 'blur(8px)' }}>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 16, fontWeight: 600, margin: '0 0 10px', color: 'var(--ink)', letterSpacing: '-0.02em' }}>{title}</h2>
      {children}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'var(--surface-muted)', borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 16, color: 'var(--ink)', tabularNums: true } as React.CSSProperties}>{value}</div>
    </div>
  );
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span style={{ padding: '4px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: active ? '#dcfce7' : '#fef2f2', color: active ? '#166534' : '#991b1b' }}>
      {active ? 'Active' : 'Paused'}
    </span>
  );
}

// suppress unused import warning
const _isAddress = isAddress;
void _isAddress;
