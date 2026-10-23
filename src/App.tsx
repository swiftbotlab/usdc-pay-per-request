import { useState, useEffect } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Header } from './components/Header';
import { Footer } from './components/Footer';
import { useNetworkKey } from './hooks/useNetwork';
import { DEFAULT_NETWORK, getNetwork, type NetworkKey } from './config/networks';
import { HowItWorksPage } from './pages/HowItWorksPage';
import { DemoPage } from './pages/DemoPage';
import { ProviderPage } from './pages/ProviderPage';
import { EndpointPage } from './pages/EndpointPage';
import { RequestPage } from './pages/RequestPage';

interface ParsedRoute {
  net: NetworkKey;
  page: 'home' | 'demo' | 'provider' | 'endpoint' | 'request';
  param?: string;
}

function parseHash(hash: string): ParsedRoute {
  // strip leading # and /
  const raw = hash.replace(/^#\/?/, '');
  const parts = raw.split('/');
  const net = getNetwork(parts[0] ?? '');
  const page = parts[1];
  const param = parts[2];

  if (page === 'demo')     return { net, page: 'demo' };
  if (page === 'provider') return { net, page: 'provider' };
  if (page === 'e' && param)  return { net, page: 'endpoint', param };
  if (page === 'r' && param)  return { net, page: 'request',  param };
  return { net, page: 'home' };
}

export default function App() {
  const [net, setNet] = useNetworkKey();
  const [hash, setHash] = useState(() => window.location.hash || `#/${DEFAULT_NETWORK}`);

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // When user toggles network, redirect to the same page on the new network
  const handleSetNet = (k: NetworkKey) => {
    setNet(k);
    const { page, param } = parseHash(hash);
    if (page === 'home')     window.location.hash = `#/${k}`;
    else if (page === 'demo')     window.location.hash = `#/${k}/demo`;
    else if (page === 'provider') window.location.hash = `#/${k}/provider`;
    else if (page === 'endpoint' && param) window.location.hash = `#/${k}/e/${param}`;
    else if (page === 'request'  && param) window.location.hash = `#/${k}/r/${param}`;
    else window.location.hash = `#/${k}`;
  };

  const route = parseHash(hash);
  // Sync network selection from URL
  const activeNet = route.net;
  if (activeNet !== net) {
    // URL drove the net — sync state without redirect
    setNet(activeNet);
  }

  const renderPage = () => {
    if (!hash || hash === '#' || hash === '#/') {
      // Redirect to the default network's home; do this after render via effect.
      setTimeout(() => { window.location.hash = `#/${net}`; }, 0);
      return null;
    }
    switch (route.page) {
      case 'demo':     return <DemoPage net={activeNet} />;
      case 'provider': return <ProviderPage net={activeNet} />;
      case 'endpoint': return <EndpointPage net={activeNet} id={route.param ?? ''} />;
      case 'request':  return <RequestPage  net={activeNet} requestId={route.param ?? ''} />;
      default:         return <HowItWorksPage net={activeNet} />;
    }
  };

  return (
    <ErrorBoundary>
      <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
        <Header net={activeNet} setNet={handleSetNet} />
        <main style={{ flex: 1 }}>
          {renderPage()}
        </main>
        <Footer net={activeNet} />
      </div>
    </ErrorBoundary>
  );
}
