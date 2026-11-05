import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  PipeTransform,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError, ZodType } from 'zod';
import { logger } from './logger';

/**
 * Error de negocio con código estable. Los clientes deciden por `code`, no por el texto.
 * Diferente de fallas técnicas, que se responden como INTERNAL con correlation_id.
 */
export class BizError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 422,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Recurso') => new BizError('NOT_FOUND', `${what} no encontrado`, 404);
export const forbidden = (msg = 'No tienes permiso para esta acción') => new BizError('FORBIDDEN', msg, 403);
export const conflict = (code: string, msg: string, details?: unknown) => new BizError(code, msg, 409, details);

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { correlationId?: string }>();
    const correlationId = req.correlationId ?? 'n/a';
    if (res.headersSent) return;
    if (exception instanceof BizError) {
      res.status(exception.status).json({
        error: { code: exception.code, message: exception.message, details: exception.details },
        correlationId,
      });
      return;
    }
    if (exception instanceof ZodError) {
      res.status(400).json({
        error: { code: 'VALIDATION', message: 'Datos inválidos', details: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
        correlationId,
      });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      res.status(status).json({
        error: { code: status === 404 ? 'NOT_FOUND' : status === 401 ? 'UNAUTHENTICATED' : 'HTTP_' + status, message: exception.message },
        correlationId,
      });
      return;
    }
    const pgCode = (exception as any)?.code;
    if (pgCode === '23514' || pgCode === '23505') {
      // Restricción de integridad: la base de datos protegió el invariante.
      logger.warn('restricción violada', { correlationId, constraint: (exception as any)?.constraint });
      res.status(409).json({ error: { code: 'CONFLICT', message: 'La operación entra en conflicto con el estado actual. Actualiza e inténtalo de nuevo.' }, correlationId });
      return;
    }
    logger.error('error no controlado', { correlationId, err: (exception as Error)?.message, stack: (exception as Error)?.stack });
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Error interno. Usa el código de diagnóstico para soporte.' }, correlationId });
  }
}

export class ZodPipe implements PipeTransform {
  constructor(private schema: ZodType) {}
  transform(value: unknown) {
    const r = this.schema.safeParse(value ?? {});
    if (!r.success) throw r.error;
    return r.data;
  }
}

export function parse<T>(schema: ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw r.error;
  return r.data;
}

export { BadRequestException };
