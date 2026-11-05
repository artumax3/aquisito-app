import type { z } from 'zod';
import * as S from './schemas';
import type { Role } from './enums';

export type Auth = 'public' | 'session' | Role[];

export interface EndpointDef<B extends z.ZodType | undefined = z.ZodType | undefined> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  auth: Auth;
  tag: string;
  summary: string;
  body?: B;
  query?: z.ZodType;
  idempotent?: boolean;
}

function e<B extends z.ZodType | undefined = undefined>(d: EndpointDef<B>): EndpointDef<B> {
  return d;
}

const ADMIN_OPS: Role[] = ['admin', 'city_dispatcher', 'support_agent'];
const MERCHANT: Role[] = ['merchant_owner', 'branch_operator'];

/**
 * Registro único de endpoints. Lo usan: el generador OpenAPI (apps/api/scripts/openapi.ts), el
 * cliente tipado (@aquisito/api-client) y la matriz de trazabilidad. Las rutas reales están en los
 * controladores Nest; un test verifica que cada entrada exista como ruta registrada.
 */
export const endpoints = {
  // Auth
  register: e({ method: 'POST', path: '/auth/register', auth: 'public', tag: 'auth', summary: 'Registro por correo', body: S.RegisterInput }),
  login: e({ method: 'POST', path: '/auth/login', auth: 'public', tag: 'auth', summary: 'Acceso por correo y contraseña', body: S.LoginInput }),
  otpRequest: e({ method: 'POST', path: '/auth/otp/request', auth: 'public', tag: 'auth', summary: 'Solicitar OTP por SMS', body: S.OtpRequestInput }),
  otpVerify: e({ method: 'POST', path: '/auth/otp/verify', auth: 'public', tag: 'auth', summary: 'Verificar OTP', body: S.OtpVerifyInput }),
  mfaSetup: e({ method: 'POST', path: '/auth/mfa/setup', auth: 'session', tag: 'auth', summary: 'Generar secreto TOTP' }),
  mfaVerify: e({ method: 'POST', path: '/auth/mfa/verify', auth: 'session', tag: 'auth', summary: 'Verificar TOTP y elevar sesión', body: S.MfaVerifyInput }),
  logout: e({ method: 'POST', path: '/auth/logout', auth: 'session', tag: 'auth', summary: 'Cerrar sesión actual' }),
  sessions: e({ method: 'GET', path: '/auth/sessions', auth: 'session', tag: 'auth', summary: 'Listar sesiones/dispositivos' }),
  revokeSession: e({ method: 'DELETE', path: '/auth/sessions/:id', auth: 'session', tag: 'auth', summary: 'Revocar dispositivo' }),
  passwordResetRequest: e({ method: 'POST', path: '/auth/password/reset-request', auth: 'public', tag: 'auth', summary: 'Solicitar recuperación', body: S.PasswordResetRequestInput }),
  passwordReset: e({ method: 'POST', path: '/auth/password/reset', auth: 'public', tag: 'auth', summary: 'Restablecer contraseña', body: S.PasswordResetInput }),
  me: e({ method: 'GET', path: '/me', auth: 'session', tag: 'me', summary: 'Perfil, membresías y estado de edad' }),
  updateMe: e({ method: 'PATCH', path: '/me', auth: 'session', tag: 'me', summary: 'Actualizar perfil (revoca verificación si cambia identidad)', body: S.UpdateMeInput }),
  addresses: e({ method: 'GET', path: '/me/addresses', auth: 'session', tag: 'me', summary: 'Direcciones guardadas' }),
  addAddress: e({ method: 'POST', path: '/me/addresses', auth: 'session', tag: 'me', summary: 'Guardar dirección con punto confirmado', body: S.AddressInput }),
  deleteAddress: e({ method: 'DELETE', path: '/me/addresses/:id', auth: 'session', tag: 'me', summary: 'Eliminar dirección' }),
  consents: e({ method: 'GET', path: '/me/consents', auth: 'session', tag: 'me', summary: 'Consentimientos vigentes' }),
  setConsent: e({ method: 'POST', path: '/me/consents', auth: 'session', tag: 'me', summary: 'Registrar consentimiento', body: S.ConsentInput }),
  dataRequest: e({ method: 'POST', path: '/me/data-requests', auth: 'session', tag: 'me', summary: 'Solicitud ARCO / eliminación', body: S.DataRequestInput }),
  dataRequests: e({ method: 'GET', path: '/me/data-requests', auth: 'session', tag: 'me', summary: 'Mis solicitudes ARCO' }),
  favorites: e({ method: 'GET', path: '/me/favorites', auth: 'session', tag: 'me', summary: 'Comercios favoritos' }),
  addFavorite: e({ method: 'POST', path: '/me/favorites/:branchId', auth: 'session', tag: 'me', summary: 'Marcar favorito' }),
  removeFavorite: e({ method: 'DELETE', path: '/me/favorites/:branchId', auth: 'session', tag: 'me', summary: 'Quitar favorito' }),
  notifications: e({ method: 'GET', path: '/notifications', auth: 'session', tag: 'me', summary: 'Notificaciones internas' }),
  readNotification: e({ method: 'POST', path: '/notifications/:id/read', auth: 'session', tag: 'me', summary: 'Marcar leída' }),
  pushToken: e({ method: 'POST', path: '/me/push-tokens', auth: 'session', tag: 'me', summary: 'Registrar token push del dispositivo' }),
  realtime: e({ method: 'GET', path: '/realtime', auth: 'session', tag: 'realtime', summary: 'SSE de novedades del usuario (recuperar desde API al reconectar)' }),

  // Ciudades / cobertura
  cities: e({ method: 'GET', path: '/cities', auth: 'public', tag: 'geo', summary: 'Ciudades operativas' }),
  suggestCity: e({ method: 'GET', path: '/cities/suggest', auth: 'public', tag: 'geo', summary: 'Sugerir ciudad por ubicación (con permiso)' }),
  cityZones: e({ method: 'GET', path: '/cities/:id/zones', auth: 'public', tag: 'geo', summary: 'Zonas vigentes (GeoJSON de prueba)' }),
  coverageCheck: e({ method: 'POST', path: '/coverage/check', auth: 'public', tag: 'geo', summary: 'Validar cobertura de un punto', body: S.CoverageCheckInput }),

  // Catálogo
  stores: e({ method: 'GET', path: '/stores', auth: 'public', tag: 'catalog', summary: 'Comercios por ciudad', query: S.StoreListQuery }),
  store: e({ method: 'GET', path: '/stores/:id', auth: 'public', tag: 'catalog', summary: 'Detalle de sucursal y catálogo' }),
  product: e({ method: 'GET', path: '/products/:id', auth: 'public', tag: 'catalog', summary: 'Producto con variantes y adicionales' }),
  search: e({ method: 'GET', path: '/search', auth: 'public', tag: 'catalog', summary: 'Búsqueda de comercios y productos' }),

  // Carrito / checkout / pedidos
  cart: e({ method: 'GET', path: '/cart', auth: 'session', tag: 'orders', summary: 'Carrito recalculado en servidor' }),
  putCart: e({ method: 'PUT', path: '/cart', auth: 'session', tag: 'orders', summary: 'Reemplazar contenido del carrito', body: S.PutCartInput }),
  clearCart: e({ method: 'DELETE', path: '/cart', auth: 'session', tag: 'orders', summary: 'Vaciar carrito' }),
  slots: e({ method: 'GET', path: '/stores/:id/slots', auth: 'public', tag: 'orders', summary: 'Franjas programables con capacidad' }),
  quote: e({ method: 'POST', path: '/checkout/quotes', auth: 'session', tag: 'orders', summary: 'Cotización versionada con vencimiento', body: S.QuoteInput }),
  createOrder: e({ method: 'POST', path: '/orders', auth: 'session', tag: 'orders', summary: 'Confirmar pedido (Idempotency-Key obligatorio)', body: S.CreateOrderInput, idempotent: true }),
  orders: e({ method: 'GET', path: '/orders', auth: 'session', tag: 'orders', summary: 'Mis pedidos' }),
  order: e({ method: 'GET', path: '/orders/:id', auth: 'session', tag: 'orders', summary: 'Detalle con cronología' }),
  cancelOrder: e({ method: 'POST', path: '/orders/:id/cancel', auth: 'session', tag: 'orders', summary: 'Cancelar según estado', body: S.CancelOrderInput }),
  reorder: e({ method: 'POST', path: '/orders/:id/reorder', auth: 'session', tag: 'orders', summary: 'Recompra: carga el carrito con productos disponibles' }),
  orderMessages: e({ method: 'GET', path: '/orders/:id/messages', auth: 'session', tag: 'support', summary: 'Mensajes del pedido' }),
  sendOrderMessage: e({ method: 'POST', path: '/orders/:id/messages', auth: 'session', tag: 'support', summary: 'Enviar mensaje', body: S.MessageInput }),
  reportIncident: e({ method: 'POST', path: '/orders/:id/incidents', auth: 'session', tag: 'support', summary: 'Reportar problema', body: S.IncidentInput }),
  rateOrder: e({ method: 'POST', path: '/orders/:id/rating', auth: 'session', tag: 'orders', summary: 'Valorar pedido completado', body: S.RatingInput }),
  respondSubstitution: e({ method: 'POST', path: '/orders/:id/substitutions/:sid/respond', auth: 'session', tag: 'orders', summary: 'Aceptar/rechazar faltante', body: S.SubstitutionResponseInput }),
  deliveryCode: e({ method: 'GET', path: '/orders/:id/delivery-code', auth: 'session', tag: 'orders', summary: 'Código de entrega (solo comprador)' }),
  tracking: e({ method: 'GET', path: '/orders/:id/tracking', auth: 'session', tag: 'orders', summary: 'Última ubicación vigente del repartidor' }),

  // Pagos
  startPayment: e({ method: 'POST', path: '/payments', auth: 'session', tag: 'payments', summary: 'Iniciar intento de pago', body: S.StartPaymentInput, idempotent: true }),
  paymentsConfig: e({ method: 'GET', path: '/payments/config', auth: 'public', tag: 'payments', summary: 'Proveedor y llave pública por medio de pago (sin secretos)' }),
  payment: e({ method: 'GET', path: '/payments/:id', auth: 'session', tag: 'payments', summary: 'Estado del pago' }),
  paymentWebhook: e({ method: 'POST', path: '/webhooks/payments/:provider', auth: 'public', tag: 'payments', summary: 'Eventos del proveedor (autenticidad verificada)' }),
  simulatePayment: e({ method: 'POST', path: '/dev/payments/:id/simulate', auth: 'session', tag: 'dev', summary: 'SOLO DESARROLLO: simular resultado del proveedor', body: S.SimulatePaymentInput }),

  // Edad
  requestAgeVerification: e({ method: 'POST', path: '/age-verifications', auth: 'session', tag: 'age', summary: 'Solicitar verificación (queda pendiente)', body: S.AgeVerificationInput }),
  myAgeVerification: e({ method: 'GET', path: '/age-verifications/me', auth: 'session', tag: 'age', summary: 'Estado de verificación' }),

  // Comercio
  merchantApply: e({ method: 'POST', path: '/merchant/applications', auth: 'session', tag: 'merchant', summary: 'Solicitud de alta', body: S.MerchantApplicationInput }),
  merchantBranches: e({ method: 'GET', path: '/merchant/branches', auth: MERCHANT, tag: 'merchant', summary: 'Mis sucursales' }),
  merchantOrders: e({ method: 'GET', path: '/merchant/branches/:id/orders', auth: MERCHANT, tag: 'merchant', summary: 'Bandeja de pedidos' }),
  merchantAccept: e({ method: 'POST', path: '/merchant/orders/:id/accept', auth: MERCHANT, tag: 'merchant', summary: 'Aceptar pedido' }),
  merchantReject: e({ method: 'POST', path: '/merchant/orders/:id/reject', auth: MERCHANT, tag: 'merchant', summary: 'Rechazar con motivo', body: S.RejectOrderInput }),
  merchantStart: e({ method: 'POST', path: '/merchant/orders/:id/start', auth: MERCHANT, tag: 'merchant', summary: 'Iniciar preparación' }),
  merchantReady: e({ method: 'POST', path: '/merchant/orders/:id/ready', auth: MERCHANT, tag: 'merchant', summary: 'Marcar listo' }),
  merchantEta: e({ method: 'POST', path: '/merchant/orders/:id/eta', auth: MERCHANT, tag: 'merchant', summary: 'Ajustar estimación', body: S.EtaInput }),
  merchantSubstitution: e({ method: 'POST', path: '/merchant/orders/:id/substitutions', auth: MERCHANT, tag: 'merchant', summary: 'Proponer ajuste por faltante', body: S.SubstitutionProposalInput }),
  merchantReturnInspection: e({ method: 'POST', path: '/merchant/orders/:id/return-inspection', auth: MERCHANT, tag: 'merchant', summary: 'Recepción e inspección de devolución', body: S.ReturnInspectionInput }),
  merchantCatalog: e({ method: 'GET', path: '/merchant/branches/:id/catalog', auth: MERCHANT, tag: 'merchant', summary: 'Catálogo con stock' }),
  merchantCreateProduct: e({ method: 'POST', path: '/merchant/branches/:id/products', auth: MERCHANT, tag: 'merchant', summary: 'Crear producto', body: S.ProductInput }),
  merchantPatchProduct: e({ method: 'PATCH', path: '/merchant/products/:id', auth: MERCHANT, tag: 'merchant', summary: 'Editar producto', body: S.ProductPatchInput }),
  merchantStock: e({ method: 'POST', path: '/merchant/skus/:id/adjust', auth: MERCHANT, tag: 'merchant', summary: 'Ajuste de stock con motivo', body: S.StockAdjustInput }),
  merchantCreateCombo: e({ method: 'POST', path: '/merchant/branches/:id/combos', auth: MERCHANT, tag: 'merchant', summary: 'Constructor de combos', body: S.ComboInput }),
  merchantHours: e({ method: 'PUT', path: '/merchant/branches/:id/hours', auth: MERCHANT, tag: 'merchant', summary: 'Horarios semanales', body: S.BranchHoursInput }),
  merchantClosure: e({ method: 'POST', path: '/merchant/branches/:id/closures', auth: MERCHANT, tag: 'merchant', summary: 'Cierre especial', body: S.ClosureInput }),
  merchantPause: e({ method: 'POST', path: '/merchant/branches/:id/pause', auth: MERCHANT, tag: 'merchant', summary: 'Pausar/reanudar sucursal', body: S.PauseInput }),
  merchantReport: e({ method: 'GET', path: '/merchant/branches/:id/report', auth: MERCHANT, tag: 'merchant', summary: 'Ventas, comisiones, cancelaciones' }),
  merchantExport: e({ method: 'GET', path: '/merchant/branches/:id/export.csv', auth: MERCHANT, tag: 'merchant', summary: 'Exportación CSV con zona horaria y filtros' }),
  merchantOperators: e({ method: 'POST', path: '/merchant/branches/:id/operators', auth: ['merchant_owner'], tag: 'merchant', summary: 'Invitar operador con cuenta propia', body: S.OperatorInput }),
  merchantTicket: e({ method: 'GET', path: '/merchant/orders/:id/ticket', auth: MERCHANT, tag: 'merchant', summary: 'Comanda imprimible' }),

  // Repartidor
  courierApply: e({ method: 'POST', path: '/courier/applications', auth: 'session', tag: 'courier', summary: 'Postulación de repartidor', body: S.CourierApplicationInput }),
  courierMe: e({ method: 'GET', path: '/courier/me', auth: ['courier'], tag: 'courier', summary: 'Perfil, estado y entrega activa' }),
  courierAvailability: e({ method: 'PUT', path: '/courier/availability', auth: ['courier'], tag: 'courier', summary: 'Disponibilidad', body: S.AvailabilityInput }),
  courierLocation: e({ method: 'POST', path: '/courier/location', auth: ['courier'], tag: 'courier', summary: 'Reportar ubicación con precisión y timestamp', body: S.LocationInput }),
  courierOffers: e({ method: 'GET', path: '/courier/offers', auth: ['courier'], tag: 'courier', summary: 'Ofertas vigentes (sin datos personales)' }),
  courierAcceptOffer: e({ method: 'POST', path: '/courier/offers/:id/accept', auth: ['courier'], tag: 'courier', summary: 'Aceptar oferta (atómico)' }),
  courierRejectOffer: e({ method: 'POST', path: '/courier/offers/:id/reject', auth: ['courier'], tag: 'courier', summary: 'Rechazar oferta' }),
  courierDelivery: e({ method: 'GET', path: '/courier/deliveries/current', auth: ['courier'], tag: 'courier', summary: 'Entrega asignada' }),
  courierHeading: e({ method: 'POST', path: '/courier/deliveries/:orderId/heading-to-store', auth: ['courier'], tag: 'courier', summary: 'En camino al comercio' }),
  courierPickup: e({ method: 'POST', path: '/courier/deliveries/:orderId/pickup', auth: ['courier'], tag: 'courier', summary: 'Confirmar recojo', body: S.PickupInput }),
  courierDepart: e({ method: 'POST', path: '/courier/deliveries/:orderId/depart', auth: ['courier'], tag: 'courier', summary: 'En camino al cliente' }),
  courierArrive: e({ method: 'POST', path: '/courier/deliveries/:orderId/arrive', auth: ['courier'], tag: 'courier', summary: 'En destino' }),
  courierAgeCheck: e({ method: 'POST', path: '/courier/deliveries/:orderId/age-check', auth: ['courier'], tag: 'courier', summary: 'Comprobación presencial de edad', body: S.AgeCheckInput }),
  courierDeliver: e({ method: 'POST', path: '/courier/deliveries/:orderId/deliver', auth: ['courier'], tag: 'courier', summary: 'Confirmar entrega con código', body: S.DeliverInput }),
  courierFail: e({ method: 'POST', path: '/courier/deliveries/:orderId/fail', auth: ['courier'], tag: 'courier', summary: 'Entrega fallida', body: S.FailDeliveryInput }),
  courierRelease: e({ method: 'POST', path: '/courier/deliveries/:orderId/release', auth: ['courier'], tag: 'courier', summary: 'Liberar asignación antes del recojo (con motivo)', body: S.ReasonInput }),
  courierEarnings: e({ method: 'GET', path: '/courier/earnings', auth: ['courier'], tag: 'courier', summary: 'Ganancias, propinas, efectivo por rendir' }),
  courierHistory: e({ method: 'GET', path: '/courier/history', auth: ['courier'], tag: 'courier', summary: 'Historial de entregas propias' }),

  // Admin
  adminDashboard: e({ method: 'GET', path: '/admin/dashboard', auth: [...ADMIN_OPS, 'finance'], tag: 'admin', summary: 'Indicadores documentados' }),
  adminOrders: e({ method: 'GET', path: '/admin/orders', auth: [...ADMIN_OPS, 'finance'], tag: 'admin', summary: 'Pedidos activos con filtros' }),
  adminOrder: e({ method: 'GET', path: '/admin/orders/:id', auth: [...ADMIN_OPS, 'finance'], tag: 'admin', summary: 'Detalle completo' }),
  adminAssign: e({ method: 'POST', path: '/admin/orders/:id/assign', auth: ['admin', 'city_dispatcher'], tag: 'admin', summary: 'Asignación manual supervisada', body: S.AssignInput }),
  adminUnassign: e({ method: 'POST', path: '/admin/orders/:id/unassign', auth: ['admin', 'city_dispatcher'], tag: 'admin', summary: 'Reasignar (libera repartidor)', body: S.ReasonInput }),
  adminCancel: e({ method: 'POST', path: '/admin/orders/:id/cancel', auth: ['admin', 'support_agent', 'city_dispatcher'], tag: 'admin', summary: 'Cancelación supervisada', body: S.ReasonInput }),
  adminCouriers: e({ method: 'GET', path: '/admin/couriers', auth: ADMIN_OPS, tag: 'admin', summary: 'Repartidores' }),
  adminReviewCourier: e({ method: 'POST', path: '/admin/couriers/:id/review', auth: ['admin', 'city_dispatcher'], tag: 'admin', summary: 'Aprobar/rechazar repartidor', body: S.ReviewInput }),
  adminMerchants: e({ method: 'GET', path: '/admin/merchants', auth: ADMIN_OPS, tag: 'admin', summary: 'Comercios' }),
  adminReviewMerchant: e({ method: 'POST', path: '/admin/merchants/:id/review', auth: ['admin'], tag: 'admin', summary: 'Aprobar/rechazar comercio', body: S.ReviewInput }),
  adminReviewAlcoholPermit: e({ method: 'POST', path: '/admin/branches/:id/alcohol-permit', auth: ['admin'], tag: 'admin', summary: 'Revisión de habilitación para alcohol', body: S.ReviewInput }),
  adminAgeQueue: e({ method: 'GET', path: '/admin/age-verifications', auth: ['admin', 'support_agent'], tag: 'admin', summary: 'Cola de verificación de edad' }),
  adminAgeDecide: e({ method: 'POST', path: '/admin/age-verifications/:id/decide', auth: ['admin'], tag: 'admin', summary: 'Decidir verificación', body: S.AgeVerificationDecisionInput }),
  adminCityPatch: e({ method: 'PATCH', path: '/admin/cities/:id', auth: ['admin'], tag: 'admin', summary: 'Pausa operativa / alcohol', body: S.CityPatchInput }),
  adminZoneVersion: e({ method: 'POST', path: '/admin/zones/:id/versions', auth: ['admin'], tag: 'admin', summary: 'Nueva versión del polígono', body: S.ZoneVersionInput }),
  adminZoneSuspend: e({ method: 'POST', path: '/admin/zones/:id/suspensions', auth: ['admin', 'city_dispatcher'], tag: 'admin', summary: 'Suspender zona', body: S.ZoneSuspensionInput }),
  adminFeeRule: e({ method: 'POST', path: '/admin/fee-rules', auth: ['admin'], tag: 'admin', summary: 'Tarifa de reparto', body: S.FeeRuleInput }),
  adminFeeRules: e({ method: 'GET', path: '/admin/fee-rules', auth: ['admin', 'city_dispatcher'], tag: 'admin', summary: 'Tarifas' }),
  adminAlcoholRules: e({ method: 'GET', path: '/admin/alcohol-rules', auth: ['admin'], tag: 'admin', summary: 'Reglas de alcohol' }),
  adminAlcoholRule: e({ method: 'POST', path: '/admin/alcohol-rules', auth: ['admin'], tag: 'admin', summary: 'Ventana de venta con fuente', body: S.AlcoholRuleInput }),
  adminAlcoholBlackout: e({ method: 'POST', path: '/admin/alcohol-blackouts', auth: ['admin'], tag: 'admin', summary: 'Prohibición temporal', body: S.AlcoholBlackoutInput }),
  adminCoupons: e({ method: 'GET', path: '/admin/coupons', auth: ['admin', 'finance'], tag: 'admin', summary: 'Cupones' }),
  adminCreateCoupon: e({ method: 'POST', path: '/admin/coupons', auth: ['admin'], tag: 'admin', summary: 'Crear cupón', body: S.CouponInput }),
  adminCommission: e({ method: 'POST', path: '/admin/commissions', auth: ['admin', 'finance'], tag: 'admin', summary: 'Comisión por comercio y vigencia', body: S.CommissionInput }),
  adminTraining: e({ method: 'POST', path: '/admin/couriers/:id/training', auth: ['admin'], tag: 'admin', summary: 'Registrar capacitación (documentos, rechazo, privacidad, soporte, venta responsable)' }),
  adminConfirmRefund: e({ method: 'POST', path: '/admin/refunds/:id/confirm-manual', auth: ['finance'], tag: 'admin', summary: 'Confirmar reembolso manual (efectivo/transferencia)', body: S.ManualRefundConfirmInput }),
  adminRefunds: e({ method: 'GET', path: '/admin/refunds', auth: ['finance', 'admin', 'support_agent'], tag: 'admin', summary: 'Reembolsos (filtrable por estado)' }),
  adminApproveSettlement: e({ method: 'POST', path: '/admin/settlements/:id/approve', auth: ['finance'], tag: 'admin', summary: 'Aprobar liquidación (persona distinta de quien la generó)', body: S.ReasonInput }),
  adminExecuteSettlement: e({ method: 'POST', path: '/admin/settlements/:id/execute', auth: ['finance'], tag: 'admin', summary: 'Registrar ejecución externa con referencia bancaria', body: S.SettlementExecuteInput }),
  adminVoidSettlement: e({ method: 'POST', path: '/admin/settlements/:id/void', auth: ['finance'], tag: 'admin', summary: 'Anular liquidación no ejecutada (libera sus movimientos)', body: S.ReasonInput }),
  adminCourierCash: e({ method: 'GET', path: '/admin/couriers/:id/cash', auth: ['finance', 'admin', 'city_dispatcher'], tag: 'admin', summary: 'Efectivo por rendir del repartidor' }),
  adminCashRemittance: e({ method: 'POST', path: '/admin/couriers/:id/cash-remittance', auth: ['finance'], tag: 'admin', summary: 'Registrar rendición de efectivo', body: S.CashRemittanceInput }),
  adminRefund: e({ method: 'POST', path: '/admin/payments/:id/refunds', auth: ['admin', 'finance', 'support_agent'], tag: 'admin', summary: 'Solicitar reembolso', body: S.RefundInput, idempotent: true }),
  adminConfirmManual: e({ method: 'POST', path: '/admin/payments/:id/confirm-manual', auth: ['finance'], tag: 'admin', summary: 'Conciliar transferencia manual', body: S.ManualPaymentConfirmInput }),
  adminReconcile: e({ method: 'POST', path: '/admin/payments/reconcile', auth: ['admin', 'finance'], tag: 'admin', summary: 'Ejecutar conciliación de pendientes' }),
  adminSettlements: e({ method: 'GET', path: '/admin/settlements', auth: ['finance', 'admin'], tag: 'admin', summary: 'Liquidaciones' }),
  adminCreateSettlement: e({ method: 'POST', path: '/admin/settlements', auth: ['finance'], tag: 'admin', summary: 'Generar liquidación reproducible', body: S.SettlementInput, idempotent: true }),
  adminSettlement: e({ method: 'GET', path: '/admin/settlements/:id', auth: ['finance', 'admin'], tag: 'admin', summary: 'Detalle con movimientos' }),
  adminLedger: e({ method: 'GET', path: '/admin/ledger', auth: ['finance', 'admin'], tag: 'admin', summary: 'Libro de movimientos' }),
  adminIncidents: e({ method: 'GET', path: '/admin/incidents', auth: ADMIN_OPS, tag: 'admin', summary: 'Incidencias' }),
  adminResolveIncident: e({ method: 'POST', path: '/admin/incidents/:id/resolve', auth: ['admin', 'support_agent'], tag: 'admin', summary: 'Resolver incidencia', body: S.IncidentResolveInput }),
  adminComplaints: e({ method: 'GET', path: '/admin/complaints', auth: ['admin', 'support_agent'], tag: 'admin', summary: 'Libro de reclamaciones' }),
  adminRespondComplaint: e({ method: 'POST', path: '/admin/complaints/:id/respond', auth: ['admin', 'support_agent'], tag: 'admin', summary: 'Responder reclamación', body: S.ComplaintResponseInput }),
  adminAudit: e({ method: 'GET', path: '/admin/audit', auth: ['admin'], tag: 'admin', summary: 'Auditoría' }),
  adminOutbox: e({ method: 'GET', path: '/admin/outbox', auth: ['admin'], tag: 'admin', summary: 'Eventos y fallos de notificación' }),
  adminUsers: e({ method: 'GET', path: '/admin/users', auth: ['admin'], tag: 'admin', summary: 'Buscar cuenta por correo exacto (para otorgar roles)' }),
  adminRevokeRole: e({ method: 'POST', path: '/admin/roles/:id/revoke', auth: ['admin'], tag: 'admin', summary: 'Revocar membresía', body: S.ReasonInput }),
  adminGrantRole: e({ method: 'POST', path: '/admin/roles', auth: ['admin'], tag: 'admin', summary: 'Otorgar membresía', body: S.RoleGrantInput }),
  adminDataRequests: e({ method: 'GET', path: '/admin/data-requests', auth: ['admin'], tag: 'admin', summary: 'Solicitudes ARCO' }),
  adminProcessDataRequest: e({ method: 'POST', path: '/admin/data-requests/:id/process', auth: ['admin'], tag: 'admin', summary: 'Procesar solicitud ARCO', body: S.ReasonInput }),
  adminExport: e({ method: 'GET', path: '/admin/export/orders.csv', auth: ['admin', 'finance'], tag: 'admin', summary: 'Exportación protegida' }),

  // Reclamaciones (público)
  createComplaint: e({ method: 'POST', path: '/complaints', auth: 'public', tag: 'complaints', summary: 'Registrar reclamo o queja', body: S.ComplaintInput }),
  getComplaint: e({ method: 'GET', path: '/complaints/:number', auth: 'public', tag: 'complaints', summary: 'Consultar constancia (requiere email)' }),

  uploadFile: e({ method: 'POST', path: '/files', auth: 'session', tag: 'files', summary: 'Subir documento o evidencia privada (titularidad verificada, firma de bytes, 5 MB)', body: S.DocumentUploadInput }),
  merchantDocuments: e({ method: 'GET', path: '/merchant/branches/:id/documents', auth: MERCHANT, tag: 'merchant', summary: 'Documentos del comercio y la sucursal' }),
  courierDocuments: e({ method: 'GET', path: '/courier/documents', auth: ['courier'], tag: 'courier', summary: 'Mis documentos' }),
  adminDocuments: e({ method: 'GET', path: '/admin/documents', auth: ['admin'], tag: 'admin', summary: 'Cola de revisión de documentos' }),
  adminReviewDocument: e({ method: 'POST', path: '/admin/documents/:id/review', auth: ['admin'], tag: 'admin', summary: 'Aprobar/rechazar documento con vencimiento', body: S.DocumentReviewInput }),
  banners: e({ method: 'GET', path: '/banners', auth: 'public', tag: 'catalog', summary: 'Banners vigentes (alcohol solo para adultos verificados)' }),
  adminBanners: e({ method: 'GET', path: '/admin/banners', auth: ['admin'], tag: 'admin', summary: 'Banners' }),
  adminCreateBanner: e({ method: 'POST', path: '/admin/banners', auth: ['admin'], tag: 'admin', summary: 'Crear banner con condiciones visibles', body: S.BannerInput }),
  adminPatchBanner: e({ method: 'PATCH', path: '/admin/banners/:id', auth: ['admin'], tag: 'admin', summary: 'Activar/desactivar banner', body: S.BannerPatchInput }),
  fileUrl: e({ method: 'GET', path: '/files/:id/url', auth: 'session', tag: 'files', summary: 'Enlace temporal (5 min)' }),
  signedFile: e({ method: 'GET', path: '/files/signed', auth: 'public', tag: 'files', summary: 'Descarga con firma y vencimiento' }),
  health: e({ method: 'GET', path: '/health', auth: 'public', tag: 'ops', summary: 'Health check' }),
  metrics: e({ method: 'GET', path: '/metrics', auth: ['admin'], tag: 'ops', summary: 'Métricas operativas' }),
} as const;

export type EndpointKey = keyof typeof endpoints;
