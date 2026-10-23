import { useReadContract, usePublicClient } from 'wagmi';
import { useState, useEffect } from 'react';
import { type Hex } from 'viem';
import { type NetworkKey, NETWORKS } from '../config/networks';
import { ABI } from '../config/abi';
import { formatUsdc, formatTs, formatAddr, txUrl } from '../lib/format';
import { payerOf, isBound } from '../lib/paywall';

interface Props { net: NetworkKey; requestId: string }

const ZERO_ADDR = '0x' + '0'.repeat(40);

export function RequestPage({ net, requestId }: Props) {
  const cfg = NETWORKS[net];
  const publicClient = usePublicClient({ chainId: cfg.chain.id });

  const isValidRid = /^0x[0-9a-fA-F]{64}$/.test(requestId);

  const { data: payment } = useReadContract({
    address: cfg.address, abi: ABI, functionName: 'getPayment',
    args: [isValidRid ? requestId as Hex : '0x0000000000000000000000000000000000000000000000000000000000000001'],
    chainId: cfg.chain.id,
    query: { enabled: isValidRid },
  });

  const { data: ep } = useReadContract({
    address: cfg.address, abi: ABI, functionName: 'getEndpoint',
    args: [payment ? payment.endpointId : 0n],
    chainId: cfg.chain.id,
    query: { enabled: !!payment && payment.payer !== ZERO_ADDR },
  });

  const { data: epName } = useReadContract({
    address: cfg.address, abi: ABI, functionName: 'nameOf',
    args: [payment ? payment.endpointId : 0n],
    chainId: cfg.chain.id,
    query: { enabled: !!payment && payment.payer !== ZERO_ADDR },
  });

  const [paidTxHash, setPaidTxHash] = useState<string | null>(null);
  const [blockNumber, setBlockNumber] = useState<bigint | null>(null);

  // F6: single-block getLogs using payment.paidBlock — no range scan needed
  useEffect(() => {
    if (!publicClient || !isValidRid || !payment || payment.payer === ZERO_ADDR || !payment.paidBlock) return;
    let cancelled = false;
    const paidBlock = BigInt(payment.paidBlock);
    void (async () => {
      try {
        const logs = await publicClient.getLogs({
          address: cfg.address,
          event: { type: 'event', name: 'Paid', inputs: [{ type: 'uint256', name: 'endpointId', indexed: true }, { type: 'bytes32', name: 'requestId', indexed: true }, { type: 'address', name: 'payer', indexed: true }, { type: 'address', name: 'payee', indexed: false }, { type: 'uint256', name: 'amount', indexed: false }] },
          args: { requestId: requestId as Hex },
          fromBlock: paidBlock,
          toBlock: paidBlock,
        });
        if (!cancelled && logs.length > 0) {
          setPaidTxHash(logs[0].transactionHash);
          setBlockNumber(logs[0].blockNumber ?? null);
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [publicClient, isValidRid, payment, requestId, cfg]);

  if (!isValidRid) {
    return <Center>Not a requestId — must be 0x followed by 64 hex characters.</Center>;
  }

  const paid = payment && payment.payer !== ZERO_ADDR;

  const bound = isBound(requestId as Hex);
  const extractedPayer = bound ? payerOf(requestId as Hex) : null;

  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: '40px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <a href={`#/${net}`} style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none' }}>Home</a>
        <span style={{ color: 'var(--border-strong)' }}>/</span>
        <span style={{ fontSize: 13, color: 'var(--ink-2)', fontWeight: 500 }}>Request</span>
      </div>

      <h1 className="display" style={{ fontSize: 20, fontWeight: 700, margin: '0 0 6px', color: 'var(--ink)', letterSpacing: '-0.02em' }}>Request</h1>
      <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', wordBreak: 'break-all', marginBottom: 24 }}>{requestId}</div>

      {/* Binding */}
      <Card>
        <SectionTitle>requestId binding</SectionTitle>
        {bound && extractedPayer ? (
          <Row label="Bound payer" value={extractedPayer} mono />
        ) : (
          <Row label="Binding" value="Unbound — anyone may pay" />
        )}
      </Card>

      {/* Payment */}
      <Card>
        <SectionTitle>Payment</SectionTitle>
        {!paid ? (
          <p style={{ fontSize: 14, color: 'var(--muted)', margin: 0 }}>Not paid yet.</p>
        ) : (
          <>
            <Row label="Payer" value={formatAddr(payment.payer)} mono />
            <Row label="Amount" value={`${formatUsdc(payment.amount)} USDC`} />
            <Row label="Endpoint" value={`#${payment.endpointId}${epName ? ` — ${epName}` : ''}`} link={`#/${net}/e/${payment.endpointId}`} />
            <Row label="Paid at" value={formatTs(payment.paidAt)} />
            <Row label="Block" value={String(payment.paidBlock)} />
            <Row label="Refunded" value={payment.refunded ? 'Yes' : 'No'} />
            {paidTxHash && (
              <Row label="Transaction" value={paidTxHash.slice(0, 10) + '…' + paidTxHash.slice(-6)} link={txUrl(cfg.explorer, paidTxHash)} external />
            )}
          </>
        )}
      </Card>

      {/* Verify checklist */}
      {paid && (
        <Card>
          <SectionTitle>Verify like a server</SectionTitle>
          {[
            { label: 'Payment exists (getPayment not zero)', ok: !!paid },
            { label: 'Endpoint matches', ok: !!ep && ep.provider !== ZERO_ADDR },
            { label: 'Payer binding matches (or unbound)', ok: !bound || (extractedPayer?.toLowerCase() === payment?.payer?.toLowerCase()) },
            { label: 'Not refunded', ok: paid && !payment.refunded },
            { label: 'Confirmations', ok: !!blockNumber && blockNumber > 0n },
          ].map(c => (
            <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
              <span style={{ color: c.ok ? 'var(--success)' : 'var(--danger)', fontWeight: 700, fontSize: 15 }}>{c.ok ? '✓' : '✗'}</span>
              <span style={{ color: 'var(--ink-2)' }}>{c.label}</span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div style={{ maxWidth: 480, margin: '80px auto', textAlign: 'center', color: 'var(--muted)', padding: '0 16px', fontSize: 15 }}>{children}</div>;
}

function Card({ children }: { children: React.ReactNode }) {
  return <div style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)', borderRadius: 14, padding: 20, marginBottom: 16, backdropFilter: 'blur(8px)' }}>{children}</div>;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 14, fontWeight: 600, margin: '0 0 10px', color: 'var(--ink)', letterSpacing: '-0.01em' }}>{children}</h2>;
}

function Row({ label, value, mono, link, external }: { label: string; value: string; mono?: boolean; link?: string; external?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--border)', gap: 8, alignItems: 'center' }}>
      <span style={{ color: 'var(--muted)', fontSize: 12, flexShrink: 0 }}>{label}</span>
      {link ? (
        <a href={link} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})} style={{ fontWeight: 500, fontSize: 12, fontFamily: mono ? "'JetBrains Mono', monospace" : undefined, color: 'var(--accent)', textDecoration: 'none', wordBreak: 'break-all' }}>
          {value}
        </a>
      ) : (
        <span style={{ fontWeight: 500, fontSize: 12, fontFamily: mono ? "'JetBrains Mono', monospace" : undefined, wordBreak: 'break-all' }}>{value}</span>
      )}
    </div>
  );
}
