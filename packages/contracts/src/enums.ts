export const ROLES = [
  'customer',
  'merchant_owner',
  'branch_operator',
  'courier',
  'city_dispatcher',
  'support_agent',
  'finance',
  'admin',
] as const;
export type Role = (typeof ROLES)[number];

/** Roles que exigen segundo factor (TOTP) antes de operar. */
export const MFA_REQUIRED_ROLES: Role[] = ['admin', 'finance'];

export const COMMERCIAL_STATUSES = [
  'pendiente_confirmacion',
  'confirmado',
  'aceptado_comercio',
  'en_preparacion',
  'listo_para_recojo',
  'completado',
  'rechazado_comercio',
  'cancelado',
] as const;
export type CommercialStatus = (typeof COMMERCIAL_STATUSES)[number];

export const DELIVERY_STATUSES = [
  'sin_asignar',
  'oferta_enviada',
  'asignado',
  'en_camino_al_comercio',
  'recogido',
  'en_camino_al_cliente',
  'en_destino',
  'verificacion_requerida',
  'entregado',
  'entrega_fallida',
  'entrega_rechazada',
  'retorno_pendiente',
  'devuelto',
  'no_aplica',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const PAYMENT_STATUSES = [
  'pendiente',
  'autorizado',
  'pagado',
  'fallido',
  'vencido',
  'en_conciliacion',
  'reembolso_pendiente',
  'parcialmente_reembolsado',
  'reembolsado',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_METHODS = ['card', 'wallet', 'cash', 'transfer'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const AGE_STATUSES = ['none', 'declared', 'pending', 'verified', 'rejected', 'revoked'] as const;
export type AgeStatus = (typeof AGE_STATUSES)[number];

export const PRODUCT_KINDS = ['prepared', 'stock', 'combo'] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

export const CATEGORY_KINDS = ['food', 'market', 'drinks', 'alcohol', 'offers'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const INCIDENT_KINDS = [
  'missing_item',
  'damaged',
  'wrong_item',
  'late',
  'customer_absent',
  'wrong_address',
  'accident',
  'vehicle_breakdown',
  'age_check_failed',
  'other',
] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export const ACCEPTED_ID_DOCUMENTS = ['dni', 'carne_extranjeria', 'pasaporte'] as const;
export type AcceptedIdDocument = (typeof ACCEPTED_ID_DOCUMENTS)[number];

export const AGE_CHECK_REJECTION_REASONS = [
  'no_document',
  'identity_mismatch',
  'underage',
  'manifest_intoxication',
  'safety_risk',
  'recipient_not_buyer',
] as const;
export type AgeCheckRejectionReason = (typeof AGE_CHECK_REJECTION_REASONS)[number];

export const LABELS = {
  commercial: {
    pendiente_confirmacion: 'Pendiente de confirmación',
    confirmado: 'Confirmado',
    aceptado_comercio: 'Aceptado por el comercio',
    en_preparacion: 'En preparación',
    listo_para_recojo: 'Listo para recojo',
    completado: 'Completado',
    rechazado_comercio: 'Rechazado por el comercio',
    cancelado: 'Cancelado',
  } satisfies Record<CommercialStatus, string>,
  delivery: {
    sin_asignar: 'Buscando repartidor',
    oferta_enviada: 'Oferta enviada a repartidor',
    asignado: 'Repartidor asignado',
    en_camino_al_comercio: 'Repartidor en camino al comercio',
    recogido: 'Pedido recogido',
    en_camino_al_cliente: 'En camino a tu dirección',
    en_destino: 'Repartidor en tu dirección',
    verificacion_requerida: 'Verificación de edad en la entrega',
    entregado: 'Entregado',
    entrega_fallida: 'Entrega fallida',
    entrega_rechazada: 'Entrega rechazada',
    retorno_pendiente: 'Retorno al comercio pendiente',
    devuelto: 'Devuelto al comercio',
    no_aplica: 'No aplica',
  } satisfies Record<DeliveryStatus, string>,
  payment: {
    pendiente: 'Pago pendiente',
    autorizado: 'Pago autorizado',
    pagado: 'Pagado',
    fallido: 'Pago fallido',
    vencido: 'Pago vencido',
    en_conciliacion: 'Pago en conciliación',
    reembolso_pendiente: 'Reembolso pendiente',
    parcialmente_reembolsado: 'Parcialmente reembolsado',
    reembolsado: 'Reembolsado',
  } satisfies Record<PaymentStatus, string>,
};

export const ALCOHOL_LEGAL_NOTICES = [
  'Prohibida la venta de bebidas alcohólicas a menores de 18 años',
  'Tomar bebidas alcohólicas en exceso es dañino',
] as const;
