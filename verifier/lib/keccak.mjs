/* Keccak-256 (the Ethereum variant: pad 0x01 ... 0x80, NOT NIST SHA3-256), dependency-free.
   Small and slow on purpose (BigInt lanes): the verifier hashes a few hundred bytes per request.
   Checked against eth_utils/cast vectors in test/vectors.json (incl. the 135/136/137-byte rate boundaries). */

const MASK = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];
/* rotation offsets r[x][y], lane index x + 5y */
const ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14]
];
const RATE = 136; /* bytes, keccak-256 */

function rotl(v, n) {
  n = BigInt(n);
  return n === 0n ? v : ((v << n) | (v >> (64n - n))) & MASK;
}

function permute(s) {
  const c = new Array(5);
  const b = new Array(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x][y]);
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) s[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK & b[((x + 2) % 5) + y]);
    }
    s[0] ^= RC[round];
  }
}

/** keccak256(Uint8Array) -> Uint8Array(32) */
export function keccak256(data) {
  if (!(data instanceof Uint8Array)) throw new TypeError('keccak256 expects a Uint8Array');
  const s = new Array(25).fill(0n);
  const padLen = RATE - (data.length % RATE);
  const msg = new Uint8Array(data.length + padLen);
  msg.set(data);
  msg[data.length] ^= 0x01;
  msg[msg.length - 1] ^= 0x80;
  for (let off = 0; off < msg.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(msg[off + 8 * i + k]);
      s[i] ^= lane;
    }
    permute(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = s[i];
    for (let k = 0; k < 8; k++) {
      out[8 * i + k] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}
