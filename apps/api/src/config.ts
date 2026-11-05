import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const Env = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/aquisito'),
  TEST_DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/aquisito_test'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  PUBLIC_WEB_URL: z.string().default('http://localhost:3000'),
  SESSION_TTL_HOURS: z.coerce.number().default(24 * 30),
  ADMIN_SESSION_TTL_HOURS: z.coerce.number().default(12),
  COOKIE_SECURE: bool.default(false),
  /** Clave para cifrar códigos de entrega (AES-256-GCM). 32 bytes en base64. */
  DATA_ENCRYPTION_KEY: z.string().default(''),
  /** Proveedores de pago habilitados, separados por coma: sandbox (solo dev/test), culqi. */
  PAYMENT_PROVIDERS: z.string().default('sandbox'),
  CARD_PROVIDER: z.string().default('sandbox'),
  WALLET_PROVIDER: z.string().default('sandbox'),
  SANDBOX_WEBHOOK_SECRET: z.string().default('dev-sandbox-webhook-secret'),
  CULQI_SECRET_KEY: z.string().default(''),
  CULQI_PUBLIC_KEY: z.string().default(''),
  CULQI_API_URL: z.string().default('https://api.culqi.com/v2'),
  TRANSFER_PAYMENTS_ENABLED: bool.default(false),
  PAYMENT_DEADLINE_MINUTES: z.coerce.number().default(15),
  QUOTE_TTL_MINUTES: z.coerce.number().default(10),
  OFFER_TTL_SECONDS: z.coerce.number().default(60),
  /** SMS: console (solo dev/test) | twilio */
  SMS_PROVIDER: z.string().default('console'),
  TWILIO_ACCOUNT_SID: z.string().default(''),
  TWILIO_AUTH_TOKEN: z.string().default(''),
  TWILIO_FROM: z.string().default(''),
  /** Push: none | expo */
  PUSH_PROVIDER: z.string().default('none'),
  EXPO_ACCESS_TOKEN: z.string().default(''),
  /** Correo: console (solo dev/test) | none | smtp (pendiente) */
  EMAIL_PROVIDER: z.string().default('console'),
  /** Rutas: haversine (aproximación) | osrm */
  ROUTE_PROVIDER: z.string().default('haversine'),
  OSRM_URL: z.string().default(''),
  /** Almacenamiento: local (dev) | s3 */
  STORAGE_DRIVER: z.string().default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  S3_BUCKET: z.string().default(''),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().default(''),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  JOBS_ENABLED: bool.default(true),
  JOBS_INTERVAL_MS: z.coerce.number().default(3000),
  ALLOW_DEMO_SEED: bool.default(true),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AppConfig = z.infer<typeof Env> & { isProd: boolean; isDevLike: boolean };

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = Env.parse(env);
  const cfg = {
    ...parsed,
    isProd: parsed.APP_ENV === 'production',
    isDevLike: parsed.APP_ENV === 'development' || parsed.APP_ENV === 'test',
  };
  if (parsed.APP_ENV === 'test') cfg.DATABASE_URL = parsed.TEST_DATABASE_URL;
  return cfg;
}

export function config(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

export function setConfigForTests(overrides: Partial<AppConfig>): void {
  cached = { ...config(), ...overrides };
}

/**
 * Criterio 30: la configuración de ensayo/producción rechaza simuladores y funciones restringidas
 * sin habilitación. Devuelve la lista de problemas; main.ts aborta el arranque si no está vacía.
 */
export function productionConfigProblems(cfg: AppConfig): string[] {
  if (cfg.isDevLike) return [];
  const p: string[] = [];
  const providers = cfg.PAYMENT_PROVIDERS.split(',').map((s) => s.trim());
  if (providers.includes('sandbox') || cfg.CARD_PROVIDER === 'sandbox' || cfg.WALLET_PROVIDER === 'sandbox')
    p.push('El proveedor de pagos "sandbox" (simulador) no se permite fuera de desarrollo/pruebas');
  if (providers.includes('culqi') && !cfg.CULQI_SECRET_KEY) p.push('Culqi habilitado sin CULQI_SECRET_KEY');
  if (cfg.SMS_PROVIDER === 'console') p.push('SMS_PROVIDER=console (simulador) no se permite; configure un proveedor real o desactive OTP');
  if (cfg.EMAIL_PROVIDER === 'console') p.push('EMAIL_PROVIDER=console no se permite fuera de desarrollo');
  if (cfg.ALLOW_DEMO_SEED) p.push('ALLOW_DEMO_SEED debe ser false');
  if (!cfg.DATA_ENCRYPTION_KEY || Buffer.from(cfg.DATA_ENCRYPTION_KEY, 'base64').length !== 32)
    p.push('DATA_ENCRYPTION_KEY debe ser 32 bytes en base64');
  if (!cfg.COOKIE_SECURE) p.push('COOKIE_SECURE debe ser true (HTTPS)');
  if (cfg.STORAGE_DRIVER === 'local' && cfg.isProd) p.push('STORAGE_DRIVER=local no se permite en producción; use s3 privado');
  return p;
}
