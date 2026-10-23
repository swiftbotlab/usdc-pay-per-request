import { useState } from 'react';
import { useReadContract } from 'wagmi';
import { type NetworkKey, NETWORKS } from '../config/networks';
import { ABI } from '../config/abi';
import { formatUsdc, formatAddr } from '../lib/format';

interface Props { net: NetworkKey }

export function HowItWorksPage({ net }: Props) {
  const cfg = NETWORKS[net];
  const [lookupId, setLookupId] = useState('');

  const { data: ep } = useReadContract({
    address: cfg.address,
    abi: ABI,
    functionName: 'getEndpoint',
    args: [lookupId ? BigInt(lookupId) : 0n],
    chainId: cfg.chain.id,
    query: { enabled: !!lookupId && /^[1-9]\d*$/.test(lookupId) },
  });

  const { data: epName } = useReadContract({
    address: cfg.address,
    abi: ABI,
    functionName: 'nameOf',
    args: [lookupId ? BigInt(lookupId) : 0n],
    chainId: cfg.chain.id,
    query: { enabled: !!lookupId && /^[1-9]\d*$/.test(lookupId) },
  });

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', padding: '40px 16px' }}>
      {!cfg.address ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--muted)' }}>Not deployed yet on this network.</div>
      ) : (
        <>
          {/* Hero */}
          <div style={{ textAlign: 'center', marginBottom: 48 }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 20, padding: '4px 12px', marginBottom: 16, fontSize: 12, fontWeight: 600, color: '#E3242B' }}>
              HTTP 402 · Arc · USDC
            </div>
            <h1 className="display" style={{ fontSize: 36, fontWeight: 700, margin: '0 0 12px', color: 'var(--ink)', lineHeight: 1.15, letterSpacing: '-0.03em' }}>
              USDC Pay-per-Request
            </h1>
            <p style={{ fontSize: 16, color: 'var(--muted)', maxWidth: 520, margin: '0 auto', lineHeight: 1.6 }}>
              An HTTP 402 paywall settled on Arc: agents pay per request in USDC, APIs verify on-chain.
            </p>
          </div>

          {/* 4-step flow */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 40 }}>
            {[
              { n: '1', title: 'Request', desc: 'Agent calls GET /v1/weather?city=Paris with X-Payer header' },
              { n: '2', title: '402 Challenge', desc: 'Server returns endpointId, price, payTo (this contract), requestId, token' },
              { n: '3', title: 'pay()', desc: 'Agent calls pay(endpointId, requestId) with exactly the price as msg.value' },
              { n: '4', title: 'Verify + Serve', desc: 'Retry with tx hash — server checks the Paid event and answers' },
            ].map(s => (
              <div key={s.n} style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)', borderRadius: 12, padding: '20px 16px', backdropFilter: 'blur(8px)' }}>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#E3242B', color: '#fff', fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}>{s.n}</div>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6, color: 'var(--ink)' }}>{s.title}</div>
                <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>{s.desc}</div>
              </div>
            ))}
          </div>

          {/* Why */}
          <Section title="Why">
            <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.6 }}>
              <li>No accounts or API keys — one on-chain receipt per request</li>
              <li>requestIds are bound to the payer address: a front-runner cannot pay or burn yours</li>
              <li>Price changes only affect new requests; old quotes get WrongAmount</li>
              <li>Refunds: providers return the exact paid amount from their credit balance</li>
              <li>Providers withdraw credit when they like, to any address</li>
            </ul>
          </Section>

          {/* Retry headers */}
          <Section title="Retry headers after paying">
            <code className="mono" style={{ display: 'block', background: 'var(--surface-muted)', borderRadius: 8, padding: '14px 16px', fontSize: 12, lineHeight: 1.8, color: 'var(--ink-2)', whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
{`X-Payer:         <your address>        (required: binds the requestId)
X-Paywall-Token: <token from 402>       (bearer secret — don't share)
X-Paywall-Tx:    <pay() tx hash>`}
            </code>
          </Section>

          {/* requestId formula */}
          <Section title="requestId derivation">
            <p style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.6 }}>
              The server computes <code className="mono" style={{ fontSize: 12 }}>requestId</code> from the payer, resource, and a random token so the same resource always produces a different ID. The top 20 bytes are the payer address — the contract enforces that only this address can pay it.
            </p>
            <code className="mono" style={{ display: 'block', background: 'var(--surface-muted)', borderRadius: 8, padding: '14px 16px', fontSize: 12, lineHeight: 1.8, color: 'var(--ink-2)', whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
{`digest    = keccak256(abi.encode(
              DOMAIN,      // "arc-paywall/v1"
              chainId,
              contract,
              endpointId,
              payer,
              keccak256(resource),
              token
            ))
requestId = payer[0..20] || digest[20..32]`}
            </code>
          </Section>

          {/* Endpoint lookup */}
          <Section title="Endpoint lookup">
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <input
                value={lookupId}
                onChange={e => setLookupId(e.target.value.replace(/\D/g, ''))}
                placeholder="Endpoint ID (e.g. 1)"
                style={{ flex: 1, border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px', fontSize: 14, fontFamily: "'DM Sans', sans-serif", color: 'var(--ink)', background: '#fff', outline: 'none' }}
              />
              {lookupId && (
                <a href={`#/${net}/e/${lookupId}`} style={{ padding: '9px 16px', background: 'var(--accent)', color: '#fff', borderRadius: 8, fontSize: 14, fontWeight: 600, textDecoration: 'none', display: 'flex', alignItems: 'center' }}>
                  View
                </a>
              )}
            </div>
            {ep && ep.provider !== '0x0000000000000000000000000000000000000000' && (
              <div style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', fontSize: 13 }}>
                <Row label="Name" value={epName ?? '—'} />
                <Row label="Provider" value={formatAddr(ep.provider)} mono />
                <Row label="Payee"    value={formatAddr(ep.payee)} mono />
                <Row label="Price"    value={`${formatUsdc(ep.price)} USDC`} />
                <Row label="Status"   value={ep.active ? 'Active' : 'Paused'} />
                <Row label="Paid"     value={String(ep.paidCount)} />
              </div>
            )}
            {lookupId && ep && ep.provider === '0x0000000000000000000000000000000000000000' && (
              <p style={{ fontSize: 13, color: 'var(--muted)' }}>Endpoint not found.</p>
            )}
          </Section>

          {/* Run verifier */}
          <Section title="Run the real verifier">
            <code className="mono" style={{ display: 'block', background: 'var(--surface-muted)', borderRadius: 8, padding: '14px 16px', fontSize: 12, lineHeight: 1.8, color: 'var(--ink-2)', whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
{`PAYWALL_NETWORK=mainnet \\
PAYWALL_CONTRACT=${cfg.address} \\
PAYWALL_ENDPOINT_ID=1 \\
node verifier/server.mjs`}
            </code>
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 17, fontWeight: 600, margin: '0 0 12px', color: 'var(--ink)', letterSpacing: '-0.02em' }}>{title}</h2>
      {children}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border)', gap: 8 }}>
      <span style={{ color: 'var(--muted)', fontSize: 12 }}>{label}</span>
      <span style={{ fontWeight: 500, fontSize: 12, fontFamily: mono ? "'JetBrains Mono', monospace" : undefined }}>{value}</span>
    </div>
  );
}
