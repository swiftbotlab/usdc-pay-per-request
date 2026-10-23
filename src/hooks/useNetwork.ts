/**
 * Network toggle stored in localStorage.
 * Falls back to DEFAULT_NETWORK on any storage error.
 */
import { useState, useCallback } from 'react';
import { DEFAULT_NETWORK, type NetworkKey } from '../config/networks';

const LS_KEY = 'usdc-ppr:network';

function readNetwork(): NetworkKey {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v === 'testnet' || v === 'mainnet') return v;
  } catch { /* ignore */ }
  return DEFAULT_NETWORK;
}

function writeNetwork(key: NetworkKey) {
  try { localStorage.setItem(LS_KEY, key); } catch { /* ignore */ }
}

export function useNetworkKey(): [NetworkKey, (k: NetworkKey) => void] {
  const [key, setKey] = useState<NetworkKey>(readNetwork);
  const set = useCallback((k: NetworkKey) => {
    writeNetwork(k);
    setKey(k);
  }, []);
  return [key, set];
}
