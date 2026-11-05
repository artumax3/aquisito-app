import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { config } from '../config';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    await scryptAsync(pw, randomBytes(16), 32, SCRYPT); // tiempo constante aproximado
    return false;
  }
  const [, n, saltB64, keyB64] = stored.split('$');
  const key = await scryptAsync(pw, Buffer.from(saltB64, 'base64'), 32, { ...SCRYPT, N: Number(n) });
  const expected = Buffer.from(keyB64, 'base64');
  return expected.length === key.length && timingSafeEqual(expected, key);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const randomDigits = (n: number) => Array.from({ length: n }, () => randomInt(0, 10)).join('');
export const hmacHex = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function encKey(): Buffer {
  const k = config().DATA_ENCRYPTION_KEY;
  if (k) return Buffer.from(k, 'base64');
  // Solo dev/test: clave derivada fija (la configuración de producción exige DATA_ENCRYPTION_KEY).
  return createHash('sha256').update('aquisito-dev-only-key').digest();
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decrypt(blob: string): string {
  const [iv, tag, data] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', encKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

// ---------- TOTP (RFC 6238, SHA-1, 30 s, 6 dígitos) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export function totp(secretB32: string, step = Math.floor(Date.now() / 30000)): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}
/** Verifica con ventana ±1 paso; devuelve el paso usado para impedir reutilización. */
export function verifyTotp(secretB32: string, code: string): number | null {
  const now = Math.floor(Date.now() / 30000);
  for (const s of [now - 1, now, now + 1]) if (safeEqual(totp(secretB32, s), code)) return s;
  return null;
}
