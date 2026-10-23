import { type NetworkKey, NETWORKS, networkLabel } from '../config/networks';

interface FooterProps { net: NetworkKey }

export function Footer({ net }: FooterProps) {
  const cfg = NETWORKS[net];
  return (
    <footer style={{ borderTop: '1px solid var(--border)', padding: '24px 16px', marginTop: 48 }}>
      <div style={{ maxWidth: 1100, margin: '0 auto', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>
          {cfg.address ? (
            <>
              Contract:{' '}
              <a
                href={`${cfg.explorer}/address/${cfg.address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mono"
                style={{ color: 'var(--ink-2)', fontSize: 12 }}
              >
                {cfg.address.slice(0, 10)}…{cfg.address.slice(-6)}
              </a>
              {' — '}{networkLabel(net)}
            </>
          ) : (
            <span>Not deployed on {networkLabel(net)}</span>
          )}
        </div>
        <div style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 500 }}>
          Swift Bot Labs
        </div>
      </div>
    </footer>
  );
}
