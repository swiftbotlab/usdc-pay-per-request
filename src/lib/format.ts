/** Formatting helpers for addresses, amounts, and dates. */
import { formatEther } from 'viem';

/** Shorten an address to 0x1234…abcd */
export function formatAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Format a native-USDC amount (18-decimal bigint) up to 6 decimal places. */
export function formatUsdc(amount: bigint | undefined | null, decimals = 6): string {
  if (amount === undefined || amount === null) return '—';
  const s = formatEther(amount);
  const [int, frac = ''] = s.split('.');
  const trimmed = frac.slice(0, decimals).replace(/0+$/, '');
  return trimmed ? `${int}.${trimmed}` : int;
}

/** Format a timestamp (seconds) as a local date+time string. */
export function formatTs(ts: bigint | number): string {
  const ms = typeof ts === 'bigint' ? Number(ts) * 1000 : ts * 1000;
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Shorten a bytes32 to 0x1234…abcd. */
export function formatB32(h: string): string {
  if (!h || h.length < 10) return h;
  return `${h.slice(0, 10)}…${h.slice(-4)}`;
}

/** Build a tx explorer URL from a base URL and tx hash. */
export function txUrl(explorerBase: string, hash: string): string {
  return `${explorerBase}/tx/${hash}`;
}

/** Build an address explorer URL. */
export function addrUrl(explorerBase: string, addr: string): string {
  return `${explorerBase}/address/${addr}`;
}
