import { ConnectKitButton } from 'connectkit';
import { type NetworkKey, NETWORKS, networkLabel } from '../config/networks';
import { useNetworkKey } from '../hooks/useNetwork';
import { formatAddr } from '../lib/format';

interface HeaderProps {
  net: NetworkKey;
  setNet: (k: NetworkKey) => void;
}

// Injected once — media query for the two-row mobile header layout.
const HEADER_CSS = `
  .hdr-outer { max-width: 1100px; margin: 0 auto; padding: 0 16px; }
  .hdr-row1  { height: 52px; display: flex; align-items: center; gap: 10px; }
  .hdr-nav   { display: flex; gap: 2px; flex: 1; min-width: 0; }
  .hdr-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .hdr-row2  { display: none; }
  @media (max-width: 639px) {
    .hdr-nav  { display: none; }
    .hdr-row2 { display: flex; width: 100%; justify-content: space-around;
                padding: 0 8px 8px; gap: 0; }
    .hdr-row2 a { flex: 1; text-align: center; padding: 6px 4px; border-radius: 8px;
                  font-size: 13px; font-weight: 500; color: var(--muted);
                  text-decoration: none; white-space: nowrap; }
    .hdr-row2 a.active { color: var(--accent); background: var(--surface-muted); }
  }
`;

export function Header({ net, setNet }: HeaderProps) {
  const addr = NETWORKS[net].address;
  const hash = typeof window !== 'undefined' ? window.location.hash : '';

  return (
    <header
      style={{
        position: 'sticky', top: 0, zIndex: 100,
        background: 'rgba(255,255,255,0.88)', backdropFilter: 'blur(16px)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {/* Inject responsive CSS once */}
      <style>{HEADER_CSS}</style>

      {net === 'testnet' && (
        <div style={{ background: '#fef3c7', borderBottom: '1px solid #fde68a', padding: '6px 16px', textAlign: 'center', fontSize: 12, fontWeight: 500, color: '#92400e' }}>
          Arc Testnet — test USDC only, no real value
        </div>
      )}

      <div className="hdr-outer">
        {/* Row 1: logo · (desktop nav) · network toggle · wallet */}
        <div className="hdr-row1">
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

          {/* Desktop nav (hidden on mobile via CSS) */}
          {addr && (
            <nav className="hdr-nav">
              <NavLink href={`#/${net}`} hash={hash}>How it works</NavLink>
              <NavLink href={`#/${net}/demo`} hash={hash}>Demo</NavLink>
              <NavLink href={`#/${net}/provider`} hash={hash}>Provider</NavLink>
            </nav>
          )}
          {!addr && <div style={{ flex: 1 }} />}

          {/* Right: network toggle + compact wallet */}
          <div className="hdr-right">
            <button
              onClick={() => setNet(net === 'mainnet' ? 'testnet' : 'mainnet')}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '5px 9px',
                background: net === 'testnet' ? '#fef3c7' : 'var(--surface-muted)',
                border: `1px solid ${net === 'testnet' ? '#fde68a' : 'var(--border)'}`,
                borderRadius: 8, fontSize: 12, fontWeight: 600,
                color: net === 'testnet' ? '#92400e' : 'var(--ink-2)',
                cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap',
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: net === 'testnet' ? '#f59e0b' : '#16a34a', flexShrink: 0 }} />
              {networkLabel(net)}
            </button>

            {/* Compact wallet button: "Connect" or truncated address */}
            <ConnectKitButton.Custom>
              {({ isConnected, isConnecting, show, address: ckAddr }) => (
                <button
                  onClick={show}
                  style={{
                    padding: '6px 12px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                    background: isConnected ? 'var(--surface-muted)' : 'var(--accent)',
                    color: isConnected ? 'var(--ink)' : '#fff',
                    border: isConnected ? '1px solid var(--border)' : 'none',
                    cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
                    whiteSpace: 'nowrap', flexShrink: 0,
                  }}
                >
                  {isConnecting ? '…' : isConnected && ckAddr ? formatAddr(ckAddr) : 'Connect'}
                </button>
              )}
            </ConnectKitButton.Custom>
          </div>
        </div>

        {/* Row 2: mobile nav (shown only < 640px) */}
        {addr && (
          <div className="hdr-row2">
            <MobileNavLink href={`#/${net}`} hash={hash}>How it works</MobileNavLink>
            <MobileNavLink href={`#/${net}/demo`} hash={hash}>Demo</MobileNavLink>
            <MobileNavLink href={`#/${net}/provider`} hash={hash}>Provider</MobileNavLink>
          </div>
        )}
      </div>
    </header>
  );
}

function NavLink({ href, hash, children }: { href: string; hash: string; children: React.ReactNode }) {
  const path = href.replace(/^#/, '');
  const active = hash === `#${path}` || (path !== `/${href.split('/')[1]}` && hash.startsWith(`#${path}`));
  return (
    <a
      href={href}
      style={{
        padding: '6px 12px', borderRadius: 8, fontSize: 14, fontWeight: 500,
        color: active ? 'var(--accent)' : 'var(--muted)',
        textDecoration: 'none', background: active ? 'var(--surface-muted)' : 'transparent',
        transition: 'background 0.15s, color 0.15s', whiteSpace: 'nowrap',
      }}
      onMouseEnter={e => { (e.target as HTMLElement).style.color = 'var(--accent)'; }}
      onMouseLeave={e => { (e.target as HTMLElement).style.color = active ? 'var(--accent)' : 'var(--muted)'; }}
    >
      {children}
    </a>
  );
}

function MobileNavLink({ href, hash, children }: { href: string; hash: string; children: React.ReactNode }) {
  const path = href.replace(/^#/, '');
  const active = hash === `#${path}` || (path !== `/${href.split('/')[1]}` && hash.startsWith(`#${path}`));
  return (
    <a href={href} className={active ? 'active' : ''}>
      {children}
    </a>
  );
}

// re-export for useNetworkKey so App can use single import
export { useNetworkKey };
