import { endpoints, EndpointKey } from '@aquisito/contracts';
import type {
  AuthResult,
  CartDto,
  CityDto,
  CourierDeliveryDto,
  MeDto,
  OfferDto,
  OrderDto,
  ProductDto,
  QuoteDto,
  StoreDetailDto,
  StoreSummaryDto,
  TrackingDto,
} from '@aquisito/contracts';
import type { z } from 'zod';

/** Tipos de respuesta conocidos por endpoint (el resto se tipa como unknown/any). */
export interface ResponseMap {
  login: AuthResult;
  register: AuthResult;
  otpVerify: AuthResult;
  me: MeDto;
  updateMe: MeDto;
  cities: CityDto[];
  stores: StoreSummaryDto[];
  store: StoreDetailDto;
  product: ProductDto;
  cart: CartDto;
  putCart: CartDto;
  quote: QuoteDto;
  createOrder: OrderDto;
  orders: OrderDto[];
  order: OrderDto;
  cancelOrder: OrderDto;
  courierOffers: OfferDto[];
  courierDelivery: CourierDeliveryDto | { none: true };
  tracking: TrackingDto;
  merchantOrders: OrderDto[];
  merchantAccept: OrderDto;
  merchantStart: OrderDto;
  merchantReady: OrderDto;
  merchantReject: OrderDto;
}

type Body<K extends EndpointKey> = (typeof endpoints)[K] extends { body: infer B } ? (B extends z.ZodType ? z.input<B> : never) : never;
type Resp<K extends EndpointKey> = K extends keyof ResponseMap ? ResponseMap[K] : any;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown, public correlationId?: string) {
    super(message);
  }
}
/** La petición no llegó al servidor (sin conexión, timeout). Nunca implica éxito. */
export class NetworkError extends Error {
  code = 'NETWORK';
  constructor(message = 'Sin conexión. Revisa tu red e inténtalo de nuevo.') {
    super(message);
  }
}

export interface ClientOptions {
  baseUrl: string;
  /** 'bearer' (móvil, token en almacenamiento seguro) o 'cookie' (web, httpOnly + CSRF). */
  mode: 'bearer' | 'cookie';
  getToken?: () => string | null | Promise<string | null>;
  getCsrf?: () => string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface CallOptions<K extends EndpointKey> {
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: Body<K> | Record<string, unknown>;
  idempotencyKey?: string;
  raw?: boolean;
}

export function newIdempotencyKey(): string {
  const r = () => Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}${r()}${r()}`;
}

export function createClient(opts: ClientOptions) {
  const f = opts.fetchImpl ?? fetch;
  async function call<K extends EndpointKey>(key: K, o: CallOptions<K> = {}): Promise<Resp<K>> {
    const def = endpoints[key];
    let path: string = def.path;
    for (const [k, v] of Object.entries(o.params ?? {})) path = path.replace(`:${k}`, encodeURIComponent(v));
    const qs = o.query ? Object.entries(o.query).filter(([, v]) => v !== undefined && v !== '') : [];
    const url = `${opts.baseUrl}${path}${qs.length ? '?' + new URLSearchParams(qs.map(([k, v]) => [k, String(v)])).toString() : ''}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.mode === 'bearer') {
      const t = await opts.getToken?.();
      if (t) headers.authorization = `Bearer ${t}`;
    } else {
      headers['x-client'] = 'web';
      const csrf = opts.getCsrf?.();
      if (csrf && def.method !== 'GET') headers['x-csrf-token'] = csrf;
    }
    if (def.idempotent || o.idempotencyKey) headers['idempotency-key'] = o.idempotencyKey ?? newIdempotencyKey();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20000);
    let res: Response;
    try {
      res = await f(url, {
        method: def.method,
        headers,
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
        credentials: opts.mode === 'cookie' ? 'include' : 'omit',
        signal: ctrl.signal,
      });
    } catch {
      throw new NetworkError();
    } finally {
      clearTimeout(timer);
    }
    if (o.raw) return (await res.text()) as any;
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) {
      const err = (data as any)?.error;
      throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? 'Error inesperado', err?.details, (data as any)?.correlationId);
    }
    return data as Resp<K>;
  }
  return { call, baseUrl: opts.baseUrl };
}

function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

export type AquisitoClient = ReturnType<typeof createClient>;

export { formatPEN, LABELS, ALCOHOL_LEGAL_NOTICES } from '@aquisito/contracts';
