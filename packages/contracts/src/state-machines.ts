import type { CommercialStatus, DeliveryStatus, PaymentStatus } from './enums';

export type Actor =
  | 'customer'
  | 'merchant'
  | 'courier'
  | 'dispatcher'
  | 'support'
  | 'finance'
  | 'system'
  | 'payment_provider';

export interface Transition<S extends string> {
  from: S;
  to: S;
  actors: Actor[];
  pre: string;
  inventory: string;
  economic: string;
  notify: string;
}

/**
 * Tabla canónica de transiciones. El servidor rechaza cualquier par (from,to) que no figure aquí
 * o cuyo actor no esté autorizado. docs/estados.md se genera a partir de estas tablas.
 */
export const COMMERCIAL_TRANSITIONS: Transition<CommercialStatus>[] = [
  { from: 'pendiente_confirmacion', to: 'confirmado', actors: ['system', 'payment_provider'], pre: 'Pago confirmado por proveedor (o efectivo aceptado) y reservas de stock vigentes', inventory: 'Reservas se mantienen', economic: 'Ninguno (el cobro se registra en el ciclo de pago)', notify: 'Cliente y comercio' },
  { from: 'pendiente_confirmacion', to: 'cancelado', actors: ['customer', 'system', 'support'], pre: 'Pago no confirmado o vencido', inventory: 'Libera reservas', economic: 'Si hubo cobro tardío: reembolso', notify: 'Cliente' },
  { from: 'confirmado', to: 'aceptado_comercio', actors: ['merchant'], pre: 'Dentro del plazo de aceptación; revalida horario de alcohol', inventory: 'Reservas se mantienen', economic: 'Ninguno', notify: 'Cliente' },
  { from: 'confirmado', to: 'rechazado_comercio', actors: ['merchant', 'system'], pre: 'Motivo obligatorio; system cuando vence el plazo de aceptación', inventory: 'Libera reservas', economic: 'Reembolso total del pago digital', notify: 'Cliente' },
  { from: 'confirmado', to: 'cancelado', actors: ['customer', 'support'], pre: 'Antes de la aceptación del comercio', inventory: 'Libera reservas', economic: 'Reembolso total', notify: 'Cliente y comercio' },
  { from: 'aceptado_comercio', to: 'en_preparacion', actors: ['merchant'], pre: 'Revalida restricciones de alcohol', inventory: 'Convierte reservas en salida definitiva', economic: 'Ninguno', notify: 'Cliente' },
  { from: 'aceptado_comercio', to: 'cancelado', actors: ['support'], pre: 'Motivo obligatorio', inventory: 'Libera reservas', economic: 'Reembolso total', notify: 'Cliente y comercio' },
  { from: 'en_preparacion', to: 'listo_para_recojo', actors: ['merchant'], pre: '—', inventory: '—', economic: '—', notify: 'Repartidor asignado' },
  { from: 'en_preparacion', to: 'cancelado', actors: ['support'], pre: 'Motivo obligatorio; mercadería ya descontada', inventory: 'Retorno requiere inspección del comercio', economic: 'Reembolso según política (soporte decide importes por concepto)', notify: 'Cliente y comercio' },
  { from: 'listo_para_recojo', to: 'completado', actors: ['system'], pre: 'Entrega en estado entregado', inventory: '—', economic: 'Asientos de venta, comisión, reparto y propina', notify: 'Cliente' },
  { from: 'listo_para_recojo', to: 'cancelado', actors: ['support', 'system'], pre: 'Entrega rechazada/devuelta o cancelación supervisada', inventory: 'Retorno requiere inspección', economic: 'Resolución económica trazable', notify: 'Cliente y comercio' },
];

export const DELIVERY_TRANSITIONS: Transition<DeliveryStatus>[] = [
  { from: 'sin_asignar', to: 'oferta_enviada', actors: ['system', 'dispatcher'], pre: 'Pedido confirmado; repartidor aprobado, disponible y de la ciudad', inventory: '—', economic: '—', notify: 'Repartidor' },
  { from: 'oferta_enviada', to: 'asignado', actors: ['courier'], pre: 'Oferta vigente, aceptación atómica, sin otra entrega activa', inventory: '—', economic: '—', notify: 'Cliente y comercio' },
  { from: 'oferta_enviada', to: 'sin_asignar', actors: ['system', 'courier'], pre: 'Oferta rechazada o vencida', inventory: '—', economic: '—', notify: 'Despacho' },
  { from: 'sin_asignar', to: 'asignado', actors: ['dispatcher'], pre: 'Asignación manual supervisada con motivo', inventory: '—', economic: '—', notify: 'Repartidor, cliente' },
  { from: 'asignado', to: 'en_camino_al_comercio', actors: ['courier'], pre: '—', inventory: '—', economic: '—', notify: 'Comercio' },
  { from: 'asignado', to: 'sin_asignar', actors: ['dispatcher', 'courier'], pre: 'Reasignación con motivo (antes del recojo)', inventory: '—', economic: '—', notify: 'Despacho' },
  { from: 'en_camino_al_comercio', to: 'sin_asignar', actors: ['dispatcher'], pre: 'Reasignación con motivo (antes del recojo)', inventory: '—', economic: '—', notify: 'Despacho' },
  { from: 'en_camino_al_comercio', to: 'recogido', actors: ['courier'], pre: 'Pedido listo; código de recojo correcto; paquetes confirmados', inventory: '—', economic: '—', notify: 'Cliente' },
  { from: 'asignado', to: 'recogido', actors: ['courier'], pre: 'Pedido listo; código de recojo correcto; paquetes confirmados', inventory: '—', economic: '—', notify: 'Cliente' },
  { from: 'recogido', to: 'en_camino_al_cliente', actors: ['courier'], pre: '—', inventory: '—', economic: '—', notify: 'Cliente' },
  { from: 'en_camino_al_cliente', to: 'en_destino', actors: ['courier'], pre: '—', inventory: '—', economic: '—', notify: 'Cliente' },
  { from: 'en_destino', to: 'verificacion_requerida', actors: ['courier', 'system'], pre: 'Pedido con alcohol', inventory: '—', economic: '—', notify: '—' },
  { from: 'en_destino', to: 'entregado', actors: ['courier'], pre: 'Pedido SIN alcohol; código de entrega de un solo uso válido; efectivo registrado si aplica', inventory: '—', economic: 'Asientos de liquidación', notify: 'Cliente' },
  { from: 'verificacion_requerida', to: 'entregado', actors: ['courier'], pre: 'Comprobación presencial de edad APROBADA para esta entrega + código válido', inventory: '—', economic: 'Asientos de liquidación', notify: 'Cliente' },
  { from: 'verificacion_requerida', to: 'entrega_rechazada', actors: ['courier'], pre: 'Comprobación presencial rechazada (motivo obligatorio)', inventory: '—', economic: 'Abre resolución económica', notify: 'Cliente, soporte, comercio' },
  { from: 'en_destino', to: 'entrega_fallida', actors: ['courier'], pre: 'Cliente ausente / dirección incorrecta tras espera', inventory: '—', economic: 'Abre resolución', notify: 'Cliente, soporte' },
  { from: 'en_camino_al_cliente', to: 'entrega_fallida', actors: ['courier'], pre: 'Accidente o avería', inventory: '—', economic: 'Abre resolución', notify: 'Soporte' },
  { from: 'entrega_rechazada', to: 'retorno_pendiente', actors: ['system'], pre: '—', inventory: '—', economic: '—', notify: 'Comercio' },
  { from: 'entrega_fallida', to: 'retorno_pendiente', actors: ['system', 'support'], pre: '—', inventory: '—', economic: '—', notify: 'Comercio' },
  { from: 'retorno_pendiente', to: 'devuelto', actors: ['merchant'], pre: 'Comercio confirma recepción', inventory: 'Inspección decide si vuelve a stock vendible', economic: 'Resolución por concepto', notify: 'Soporte, cliente' },
];

export const PAYMENT_TRANSITIONS: Transition<PaymentStatus>[] = [
  { from: 'pendiente', to: 'autorizado', actors: ['payment_provider'], pre: 'Evento verificado', inventory: '—', economic: '—', notify: '—' },
  { from: 'pendiente', to: 'pagado', actors: ['payment_provider', 'courier', 'finance'], pre: 'Evento verificado con importe, moneda y referencia; efectivo cobrado; transferencia conciliada', inventory: 'Confirma reservas o activa recuperación si vencieron', economic: 'Asiento de cobro', notify: 'Cliente' },
  { from: 'pendiente', to: 'fallido', actors: ['payment_provider'], pre: 'Evento verificado', inventory: 'Libera reservas', economic: '—', notify: 'Cliente' },
  { from: 'pendiente', to: 'vencido', actors: ['system'], pre: 'Plazo de pago vencido', inventory: 'Libera reservas', economic: '—', notify: 'Cliente' },
  { from: 'pendiente', to: 'en_conciliacion', actors: ['system'], pre: 'Respuesta incierta del proveedor', inventory: 'Mantiene reservas hasta vencer', economic: '—', notify: '—' },
  { from: 'en_conciliacion', to: 'pagado', actors: ['system', 'finance'], pre: 'Consulta al proveedor confirma cobro', inventory: 'Igual que pendiente→pagado', economic: 'Asiento de cobro', notify: 'Cliente' },
  { from: 'en_conciliacion', to: 'fallido', actors: ['system', 'finance'], pre: 'Consulta confirma que no hubo cobro', inventory: 'Libera reservas', economic: '—', notify: 'Cliente' },
  { from: 'autorizado', to: 'pagado', actors: ['payment_provider'], pre: 'Captura confirmada', inventory: '—', economic: 'Asiento de cobro', notify: '—' },
  { from: 'fallido', to: 'pagado', actors: ['payment_provider'], pre: 'Evento de pago confirmado llegado fuera de orden tras un fallo: devolución automática', inventory: '—', economic: 'Cobro y reembolso', notify: 'Cliente' },
  { from: 'vencido', to: 'pagado', actors: ['payment_provider'], pre: 'Pago tardío: se intenta re-reservar stock; si no es posible se inicia reembolso', inventory: 'Re-reserva atómica', economic: 'Cobro o reembolso', notify: 'Cliente' },
  { from: 'pagado', to: 'reembolso_pendiente', actors: ['system', 'support', 'finance'], pre: 'Cancelación/rechazo/resolución', inventory: '—', economic: 'Solicitud de reembolso idempotente', notify: 'Cliente' },
  { from: 'reembolso_pendiente', to: 'reembolsado', actors: ['payment_provider', 'finance'], pre: 'Confirmación del proveedor o del proceso manual autorizado', inventory: '—', economic: 'Asiento de reembolso', notify: 'Cliente' },
  { from: 'reembolso_pendiente', to: 'parcialmente_reembolsado', actors: ['payment_provider', 'finance'], pre: 'Confirmación de reembolso parcial', inventory: '—', economic: 'Asiento de reembolso', notify: 'Cliente' },
  { from: 'parcialmente_reembolsado', to: 'reembolso_pendiente', actors: ['system', 'support', 'finance'], pre: 'Nuevo reembolso sobre el saldo', inventory: '—', economic: '—', notify: '—' },
];

export function findTransition<S extends string>(
  table: Transition<S>[],
  from: S,
  to: S,
): Transition<S> | undefined {
  return table.find((t) => t.from === from && t.to === to);
}

export function canTransition<S extends string>(table: Transition<S>[], from: S, to: S, actor: Actor): boolean {
  const t = findTransition(table, from, to);
  return !!t && t.actors.includes(actor);
}
