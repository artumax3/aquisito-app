import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { config } from '../config';
import { hmacHex, safeEqual } from '../common/crypto';

export interface StorageAdapter {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Enlace temporal (minutos) para documentos restringidos. */
  signedUrl(key: string, minutes: number): Promise<string>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

import { createHash } from 'crypto';
/** Secreto de firma de enlaces locales derivado de DATA_ENCRYPTION_KEY (obligatoria fuera de desarrollo). */
const signingSecret = () => createHash('sha256').update(`storage-links:${config().DATA_ENCRYPTION_KEY || 'aquisito-dev-only-key'}`).digest('hex');

/** Disco local privado (dev). Los archivos se sirven solo vía /files/signed con firma y vencimiento. */
class LocalStorage implements StorageAdapter {
  private root = resolve(config().STORAGE_LOCAL_DIR, 'private');
  private path(key: string) {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root)) throw new Error('clave inválida');
    return p;
  }
  async put(key: string, body: Buffer) {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  async signedUrl(key: string, minutes: number) {
    const exp = Math.floor(Date.now() / 1000) + minutes * 60;
    const sig = hmacHex(signingSecret(), `${key}:${exp}`);
    return `/files/signed?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}`;
  }
  async read(key: string) {
    return readFileSync(this.path(key));
  }
  async remove(key: string) {
    const p = this.path(key);
    if (existsSync(p)) unlinkSync(p);
  }
}

export function verifyLocalSignature(key: string, exp: number, sig: string): boolean {
  if (exp < Date.now() / 1000) return false;
  return safeEqual(hmacHex(signingSecret(), `${key}:${exp}`), sig);
}

/** S3 compatible (bucket privado). Sin probar contra un bucket real en esta sesión. */
class S3Storage implements StorageAdapter {
  private client: any;
  private s3: any;
  private presign: any;
  constructor() {
    this.s3 = require('@aws-sdk/client-s3');
    this.presign = require('@aws-sdk/s3-request-presigner');
    const c = config();
    this.client = new this.s3.S3Client({
      region: c.S3_REGION,
      endpoint: c.S3_ENDPOINT || undefined,
      forcePathStyle: !!c.S3_ENDPOINT,
      credentials: c.S3_ACCESS_KEY_ID ? { accessKeyId: c.S3_ACCESS_KEY_ID, secretAccessKey: c.S3_SECRET_ACCESS_KEY } : undefined,
    });
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(new this.s3.PutObjectCommand({ Bucket: config().S3_BUCKET, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'AES256' }));
  }
  async signedUrl(key: string, minutes: number) {
    return this.presign.getSignedUrl(this.client, new this.s3.GetObjectCommand({ Bucket: config().S3_BUCKET, Key: key }), { expiresIn: minutes * 60 });
  }
  async read(key: string) {
    const r = await this.client.send(new this.s3.GetObjectCommand({ Bucket: config().S3_BUCKET, Key: key }));
    return Buffer.from(await r.Body.transformToByteArray());
  }
  async remove(key: string) {
    await this.client.send(new this.s3.DeleteObjectCommand({ Bucket: config().S3_BUCKET, Key: key }));
  }
}

let instance: StorageAdapter | null = null;
export function storage(): StorageAdapter {
  if (!instance) instance = config().STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage();
  return instance;
}

/** Validación por firma de bytes (no por extensión ni Content-Type declarado). */
export function sniffContentType(buf: Buffer): string | null {
  if (buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}
export { join };
