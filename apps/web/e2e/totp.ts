import { createHmac } from 'crypto';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function decode(s: string) {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export function totp(secret: string) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}
