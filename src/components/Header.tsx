import { ConnectKitButton } from 'connectkit';
import { type NetworkKey, NETWORKS, networkLabel } from '../config/networks';
import { useNetworkKey } from '../hooks/useNetwork';

interface HeaderProps {
  net: NetworkKey;
  setNet: (k: NetworkKey) => void;
}

export function Header({ net, setNet }: HeaderProps) {
  const addr = NETWORKS[net].address;

  return (
    <header
      style={{
        position: 'sticky', top: 0, zIndex: 100,
        background: 'rgba(255,255,255,0.88)', backdropFilter: 'blur(16px)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {net === 'testnet' && (
        <div style={{ background: '#fef3c7', borderBottom: '1px solid #fde68a', padding: '6px 16px', textAlign: 'center', fontSize: 12, fontWeight: 500, color: '#92400e' }}>
          Arc Testnet — test USDC only, no real value
        </div>
      )}
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '0 16px', height: 56, display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* Logo */}
        <a href={`#/${net}`} style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none', flexShrink: 0 }}>
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
            <rect width="22" height="22" rx="6" fill="#E3242B"/>
            <path d="M6 16l5-10 5 10M8 12h6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 15, color: 'var(--ink)', letterSpacing: '-0.02em' }}>
            Pay-per-Request
          </span>
        </a>

        {/* Nav */}
        <nav style={{ display: 'flex', gap: 2, flex: 1 }}>
          {addr ? (
            <>
              <NavLink href={`#/${net}`}>How it works</NavLink>
              <NavLink href={`#/${net}/demo`}>Demo</NavLink>
              <NavLink href={`#/${net}/provider`}>Provider</NavLink>
            </>
          ) : null}
        </nav>

        {/* Right side */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {/* Network toggle */}
          <button
            onClick={() => setNet(net === 'mainnet' ? 'testnet' : 'mainnet')}
            style={{
              display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px',
              background: net === 'testnet' ? '#fef3c7' : 'var(--surface-muted)',
              border: `1px solid ${net === 'testnet' ? '#fde68a' : 'var(--border)'}`,
              borderRadius: 8, fontSize: 12, fontWeight: 600, color: net === 'testnet' ? '#92400e' : 'var(--ink-2)',
              cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: net === 'testnet' ? '#f59e0b' : '#16a34a', flexShrink: 0 }} />
            {networkLabel(net)}
          </button>
          <ConnectKitButton showBalance={false} />
        </div>
      </div>
    </header>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const active = window.location.hash.startsWith(href.replace('#', ''));
  return (
    <a
      href={href}
      style={{
        padding: '6px 12px', borderRadius: 8, fontSize: 14, fontWeight: 500,
        color: active ? 'var(--accent)' : 'var(--muted)',
        textDecoration: 'none', background: active ? 'var(--surface-muted)' : 'transparent',
        transition: 'background 0.15s, color 0.15s',
      }}
      onMouseEnter={e => { (e.target as HTMLElement).style.color = 'var(--accent)'; }}
      onMouseLeave={e => { (e.target as HTMLElement).style.color = active ? 'var(--accent)' : 'var(--muted)'; }}
    >
      {children}
    </a>
  );
}

// re-export for useNetworkKey so App can use single import
export { useNetworkKey };
