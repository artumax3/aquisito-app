import 'reflect-metadata';
import { INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { json } from 'express';
import { randomUUID } from 'crypto';
import { config } from './config';
import { AllExceptionsFilter } from './common/errors';
import { AuthGuard } from './common/auth';
import { logger } from './common/logger';
import { metrics } from './metrics';
import {
  AdminController,
  AuthController,
  CatalogController,
  CourierController,
  MeController,
  MerchantController,
  OpsController,
  OrdersController,
} from './controllers';

@Module({
  controllers: [AuthController, MeController, CatalogController, OrdersController, MerchantController, CourierController, AdminController, OpsController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}

/** Limitador simple por IP (ventana fija de 60 s). En multi-instancia, complementar en el proxy. */
const buckets = new Map<string, { n: number; reset: number }>();
function rateLimit(limitPerMinute: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (config().APP_ENV === 'test') return next();
    const key = (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.socket.remoteAddress || 'x';
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || b.reset < now) buckets.set(key, { n: 1, reset: now + 60000 });
    else if (++b.n > limitPerMinute) {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Demasiadas solicitudes' }, correlationId: (req as any).correlationId });
      return;
    }
    next();
  };
}

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'], bodyParser: false });
  const origins = config().CORS_ORIGINS.split(',').map((s) => s.trim());
  app.enableCors({ origin: origins, credentials: true, allowedHeaders: ['content-type', 'authorization', 'idempotency-key', 'x-csrf-token', 'x-client', 'x-correlation-id'] });
  app.use((req: Request & { correlationId?: string }, res: Response, next: NextFunction) => {
    const incoming = req.headers['x-correlation-id'];
    req.correlationId = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-correlation-id', req.correlationId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'private, no-store');
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      metrics.record(ms, res.statusCode);
      // Ruta sin query string (puede contener datos) y sin cuerpo.
      logger.info('http', { method: req.method, route: req.path, status: res.statusCode, ms, correlationId: req.correlationId });
    });
    next();
  });
  app.use(rateLimit(config().RATE_LIMIT_PER_MINUTE));
  // Cuerpo crudo para verificar firmas de webhooks; límite de tamaño.
  app.use(json({ limit: '7mb', verify: (req: any, _res, buf) => { if (req.url?.startsWith('/webhooks/')) req.rawBody = Buffer.from(buf); } }));
  await app.init();
  return app;
}
