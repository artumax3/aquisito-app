import { mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { config } from '../config';
import { logger } from '../common/logger';

export interface SmsProvider {
  name: string;
  isSimulator: boolean;
  send(to: string, text: string): Promise<{ delivered: boolean; reference?: string }>;
}

/**
 * SIMULADOR (solo dev/test): escribe el SMS en storage/dev-outbox/sms.log para poder comprobar el
 * flujo OTP localmente. Nunca se envía nada. Producción lo rechaza.
 */
class ConsoleSms implements SmsProvider {
  name = 'console';
  isSimulator = true;
  static last: { to: string; text: string } | null = null;
  async send(to: string, text: string) {
    ConsoleSms.last = { to, text };
    const dir = join(config().STORAGE_LOCAL_DIR, 'dev-outbox');
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'sms.log'), `${new Date().toISOString()} ${to} ${text}\n`);
    } catch {
      /* noop */
    }
    return { delivered: false, reference: 'dev-console' };
  }
}
export const devSms = ConsoleSms;

/** Twilio (REST). Código escrito; sin probar con credenciales. Verificar remitente habilitado para Perú. */
export class TwilioSms implements SmsProvider {
  name = 'twilio';
  isSimulator = false;
  async send(to: string, text: string) {
    const c = config();
    const res = await fetch(`${c.TWILIO_API_URL}/2010-04-01/Accounts/${c.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${c.TWILIO_ACCOUNT_SID}:${c.TWILIO_AUTH_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: c.TWILIO_FROM, Body: text }),
      signal: AbortSignal.timeout(10000),
    });
    const b: any = await res.json().catch(() => ({}));
    return { delivered: res.ok, reference: b.sid };
  }
}

export function smsProvider(): SmsProvider {
  const n = config().SMS_PROVIDER;
  if (n === 'console') {
    if (!config().isDevLike) throw new Error('SMS console solo en desarrollo');
    return new ConsoleSms();
  }
  if (n === 'twilio') return new TwilioSms();
  throw new Error('SMS no configurado');
}

export interface EmailProvider {
  name: string;
  send(to: string, subject: string, text: string): Promise<{ delivered: boolean }>;
}
class ConsoleEmail implements EmailProvider {
  name = 'console';
  static sent: { to: string; subject: string; text: string }[] = [];
  async send(to: string, subject: string, text: string) {
    ConsoleEmail.sent.push({ to, subject, text });
    const dir = join(config().STORAGE_LOCAL_DIR, 'dev-outbox');
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'email.log'), `${new Date().toISOString()} [${subject}] -> (destinatario redactado)\n${text}\n---\n`);
    } catch {
      /* noop */
    }
    return { delivered: false };
  }
}
export const devEmail = ConsoleEmail;
export function emailProvider(): EmailProvider | null {
  const n = config().EMAIL_PROVIDER;
  if (n === 'console' && config().isDevLike) return new ConsoleEmail();
  return null; // SMTP/API de correo pendiente de selección: el registro en BD no depende de ello.
}

/** Expo Push. Requiere tokens de dispositivos (compilación nativa) y EXPO_ACCESS_TOKEN. */
export async function sendPush(tokens: string[], title: string, body: string, data: Record<string, unknown>) {
  const c = config();
  if (c.PUSH_PROVIDER !== 'expo' || tokens.length === 0) return 'not_configured';
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(c.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${c.EXPO_ACCESS_TOKEN}` } : {}) },
      body: JSON.stringify(tokens.map((to) => ({ to, title, body, data }))),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok ? 'sent' : 'failed';
  } catch (e) {
    logger.warn('push falló', { err: (e as Error).message });
    return 'failed';
  }
}
