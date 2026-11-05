import { z } from 'zod';
import { endpoints } from '@aquisito/contracts';

/** OpenAPI 3.1 generado desde el registro único de endpoints y los esquemas zod compartidos. */
export function buildOpenApi() {
  const paths: Record<string, any> = {};
  const errorSchema = {
    type: 'object',
    properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} }, required: ['code', 'message'] }, correlationId: { type: 'string' } },
  };
  for (const [name, e] of Object.entries(endpoints)) {
    const oaPath = e.path.replace(/:(\w+)/g, '{$1}');
    const params = [...e.path.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    if (e.idempotent) params.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,80}$' } } as any);
    if ((e as any).query) {
      const qs: any = z.toJSONSchema((e as any).query, { io: 'input' });
      for (const [k, v] of Object.entries(qs.properties ?? {})) params.push({ name: k, in: 'query', required: (qs.required ?? []).includes(k), schema: v } as any);
    }
    const op: any = {
      operationId: name,
      tags: [e.tag],
      summary: e.summary,
      parameters: params,
      security: e.auth === 'public' ? [] : [{ bearer: [] }, { cookie: [] }],
      'x-roles': Array.isArray(e.auth) ? e.auth : e.auth,
      responses: {
        '2XX': { description: 'Éxito' },
        '4XX': { description: 'Error de negocio o de validación (código estable en error.code)', content: { 'application/json': { schema: errorSchema } } },
        '5XX': { description: 'Falla técnica (usar correlationId para diagnóstico)', content: { 'application/json': { schema: errorSchema } } },
      },
    };
    if (e.body) op.requestBody = { required: true, content: { 'application/json': { schema: z.toJSONSchema(e.body as z.ZodType, { io: 'input' }) } } };
    paths[oaPath] = { ...(paths[oaPath] ?? {}), [e.method.toLowerCase()]: op };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Aquisito API', version: '0.1.0', description: 'API de la plataforma de delivery (nombre provisional). Moneda: céntimos de PEN. Instantes en UTC; reglas locales en America/Lima.' },
    servers: [{ url: 'http://localhost:4000', description: 'Desarrollo local' }],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'Token de sesión opaco (apps móviles)' },
        cookie: { type: 'apiKey', in: 'cookie', name: 'aq_session', description: 'Web: cookie httpOnly + cabecera x-csrf-token en operaciones de escritura' },
      },
    },
    paths,
  };
}
