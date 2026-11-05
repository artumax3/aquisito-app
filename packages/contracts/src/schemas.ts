import { z } from 'zod';
import {
  ACCEPTED_ID_DOCUMENTS,
  AGE_CHECK_REJECTION_REASONS,
  CATEGORY_KINDS,
  INCIDENT_KINDS,
  PAYMENT_METHODS,
  PRODUCT_KINDS,
  ROLES,
} from './enums';

const id = z.uuid();
const cents = z.number().int().min(0).max(100_000_000);
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Formato HH:MM');
const phone = z.string().regex(/^\+51\d{9}$/, 'Teléfono peruano en formato +51XXXXXXXXX');

// ---------- Auth ----------
export const RegisterInput = z.object({
  email: z.email().max(200),
  password: z.string().min(10).max(200),
  fullName: z.string().min(2).max(120),
  phone: phone.optional(),
});
export const LoginInput = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
  deviceLabel: z.string().max(80).optional(),
});
export const OtpRequestInput = z.object({ phone });
export const OtpVerifyInput = z.object({
  phone,
  code: z.string().regex(/^\d{6}$/),
  fullName: z.string().min(2).max(120).optional(),
  deviceLabel: z.string().max(80).optional(),
});
export const MfaVerifyInput = z.object({ code: z.string().regex(/^\d{6}$/) });
export const PasswordResetRequestInput = z.object({ email: z.email() });
export const PasswordResetInput = z.object({ token: z.string().min(20).max(200), password: z.string().min(10).max(200) });

export const UpdateMeInput = z.object({
  fullName: z.string().min(2).max(120).optional(),
  phone: phone.optional(),
  /** Fecha de nacimiento DECLARADA. No habilita alcohol; solo una verificación aprobada lo hace. */
  birthDate: isoDate.optional(),
});

export const AddressInput = z.object({
  cityId: id,
  label: z.string().min(1).max(40),
  line1: z.string().min(3).max(200),
  number: z.string().max(20).optional(),
  reference: z.string().max(200).optional(),
  instructions: z.string().max(300).optional(),
  lat,
  lng,
  /** El usuario confirmó el punto en el mapa. Obligatorio para cotizar. */
  pointConfirmed: z.literal(true),
});

export const ConsentInput = z.object({
  purpose: z.enum(['marketing', 'marketing_alcohol', 'location_tracking', 'terms', 'privacy']),
  granted: z.boolean(),
  policyVersion: z.string().max(20),
});

export const DataRequestInput = z.object({
  kind: z.enum(['access', 'rectification', 'cancellation', 'opposition', 'account_deletion']),
  detail: z.string().max(1000).optional(),
});

// ---------- Cobertura ----------
export const CoverageCheckInput = z.object({ cityId: id, lat, lng, branchId: id.optional() });

// ---------- Catálogo / búsqueda ----------
export const StoreListQuery = z.object({
  cityId: id,
  q: z.string().max(80).optional(),
  open: z.enum(['true', 'false']).optional(),
  categoryKind: z.enum(CATEGORY_KINDS).optional(),
  sort: z.enum(['eta', 'fee', 'name']).optional(),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
});

// ---------- Carrito ----------
export const CartItemInput = z.object({
  variantId: id,
  quantity: z.number().int().min(1).max(50),
  modifierOptionIds: z.array(id).max(20).default([]),
  /** Para combos con opciones: componentId -> variantId elegido. */
  comboSelections: z.record(z.string(), id).default({}),
  notes: z.string().max(200).optional(),
});
export const PutCartInput = z.object({
  branchId: id,
  items: z.array(CartItemInput).max(60),
  /** Debe ser true para reemplazar un carrito de otra sucursal. */
  replaceOtherBranch: z.boolean().default(false),
});

// ---------- Checkout ----------
export const QuoteInput = z.object({
  addressId: id,
  paymentMethod: z.enum(PAYMENT_METHODS),
  tipCents: cents.max(10_000).default(0),
  couponCode: z.string().max(40).optional(),
  /** ISO del inicio de franja para pedidos programados. */
  scheduledSlotStart: z.iso.datetime().optional(),
});

export const CreateOrderInput = z.object({
  quoteId: id,
  /** El cliente debe aceptar explícitamente la versión de la cotización. */
  quoteVersion: z.number().int().min(1),
  cashChangeForCents: cents.optional(),
  invoice: z
    .object({
      type: z.enum(['boleta', 'factura']),
      docType: z.enum(['dni', 'ruc', 'ce', 'pasaporte']).optional(),
      docNumber: z.string().max(20).optional(),
      name: z.string().max(150).optional(),
    })
    .default({ type: 'boleta' }),
  contactPhone: phone.optional(),
  /** Requerido si el pedido contiene alcohol: acepta exhibir documento y política de retorno. */
  alcoholTermsAccepted: z.boolean().default(false),
});

export const CancelOrderInput = z.object({ reason: z.string().min(3).max(300) });
export const MessageInput = z.object({ body: z.string().min(1).max(1000) });
export const IncidentInput = z.object({
  kind: z.enum(INCIDENT_KINDS),
  description: z.string().min(3).max(2000),
  evidenceFileIds: z.array(id).max(5).default([]),
});
export const RatingInput = z.object({
  storeScore: z.number().int().min(1).max(5),
  courierScore: z.number().int().min(1).max(5).optional(),
  comment: z.string().max(500).optional(),
});
export const SubstitutionResponseInput = z.object({ accept: z.boolean() });

// ---------- Pagos ----------
export const StartPaymentInput = z.object({
  orderId: id,
  /** Token del checkout alojado/tokenización del proveedor. Nunca el número de tarjeta. */
  providerToken: z.string().max(200).optional(),
});
export const SimulatePaymentInput = z.object({
  outcome: z.enum(['paid', 'failed', 'uncertain', 'paid_late']),
});
export const RefundInput = z.object({
  amountCents: cents.min(1),
  reason: z.string().min(3).max(300),
  concept: z.enum(['products', 'delivery', 'tip', 'service', 'mixed']).default('mixed'),
});
export const ManualPaymentConfirmInput = z.object({
  bankReference: z.string().min(3).max(80),
  amountCents: cents.min(1),
  reason: z.string().min(3).max(300),
});

// ---------- Verificación de edad ----------
export const AgeVerificationInput = z.object({
  documentType: z.enum(ACCEPTED_ID_DOCUMENTS),
  /** Solo últimos 4 dígitos como referencia; no se guarda número completo ni foto por defecto. */
  documentLast4: z.string().regex(/^[0-9A-Z]{4}$/),
  fullNameOnDocument: z.string().min(2).max(120),
  birthDate: isoDate,
  consent: z.literal(true),
});
export const AgeVerificationDecisionInput = z.object({
  decision: z.enum(['verified', 'rejected', 'revoked']),
  reason: z.string().min(3).max(300),
  /** Procedimiento seguido por el revisor (videollamada, presencial, proveedor). */
  method: z.enum(['manual_video', 'manual_in_person', 'provider']),
});

// ---------- Comercio ----------
export const MerchantApplicationInput = z.object({
  tradeName: z.string().min(2).max(120),
  legalName: z.string().min(2).max(160).optional(),
  ruc: z.string().regex(/^(10|15|17|20)\d{9}$/).optional(),
  contactPhone: phone,
  settlementAccount: z.string().max(60).optional(),
  branch: z.object({
    cityId: id,
    name: z.string().min(2).max(120),
    address: z.string().min(3).max(200),
    lat,
    lng,
  }),
});
export const RejectOrderInput = z.object({ reason: z.string().min(3).max(300) });
export const EtaInput = z.object({ prepMinutes: z.number().int().min(1).max(240) });
export const SubstitutionProposalInput = z.object({
  orderLineId: id,
  kind: z.enum(['remove', 'substitute']),
  substituteVariantId: id.optional(),
  note: z.string().max(200).optional(),
});
export const ProductInput = z.object({
  categoryId: id,
  name: z.string().min(2).max(120),
  description: z.string().max(500).default(''),
  kind: z.enum(PRODUCT_KINDS).exclude(['combo']),
  imageUrl: z.string().max(300).optional(),
  containsAlcohol: z.boolean().default(false),
  minimumAge: z.number().int().min(18).max(21).optional(),
  variants: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        priceCents: cents.min(1),
        /** Para productos con inventario físico: unidad inequívoca y stock inicial. */
        unit: z.string().max(20).optional(),
        initialStock: z.number().int().min(0).optional(),
      }),
    )
    .min(1)
    .max(20),
});
export const ProductPatchInput = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(500).optional(),
  active: z.boolean().optional(),
  priceByVariant: z.record(z.string(), cents.min(1)).optional(),
});
export const StockAdjustInput = z.object({
  delta: z.number().int().min(-100000).max(100000),
  reason: z.string().min(3).max(200),
});
export const ComboInput = z.object({
  categoryId: id,
  name: z.string().min(2).max(120),
  description: z.string().max(500).default(''),
  imageUrl: z.string().max(300).optional(),
  priceCents: cents.min(1),
  validFrom: z.iso.datetime().optional(),
  validTo: z.iso.datetime().optional(),
  dailyStart: hhmm.optional(),
  dailyEnd: hhmm.optional(),
  quotaTotal: z.number().int().min(1).optional(),
  perCustomerLimit: z.number().int().min(1).optional(),
  discountFundedBy: z.enum(['merchant', 'platform']).default('merchant'),
  components: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        quantity: z.number().int().min(1).max(24),
        eligibleVariantIds: z.array(id).min(1).max(10),
      }),
    )
    .min(1)
    .max(10),
});
export const BranchHoursInput = z.object({
  hours: z.array(z.object({ weekday: z.number().int().min(0).max(6), opens: hhmm, closes: hhmm })).max(21),
});
export const ClosureInput = z.object({
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  reason: z.string().min(3).max(200),
});
export const PauseInput = z.object({ paused: z.boolean(), reason: z.string().min(3).max(200) });
export const OperatorInput = z.object({ email: z.email() });
export const ReturnInspectionInput = z.object({
  restockSellable: z.boolean(),
  notes: z.string().min(3).max(300),
});

// ---------- Repartidor ----------
export const CourierApplicationInput = z.object({
  cityId: id,
  birthDate: isoDate,
  vehicleType: z.enum(['bicicleta', 'moto', 'mototaxi', 'auto', 'a_pie']),
  vehiclePlate: z.string().max(12).optional(),
  termsAccepted: z.literal(true),
});
export const AvailabilityInput = z.object({ available: z.boolean() });
export const LocationInput = z.object({
  lat,
  lng,
  accuracyM: z.number().min(0).max(10000),
  recordedAt: z.iso.datetime(),
});
export const PickupInput = z.object({ pickupCode: z.string().min(4).max(8), packages: z.number().int().min(1).max(20) });
export const AgeCheckInput = z.object({
  result: z.enum(['approved', 'rejected']),
  documentType: z.enum(ACCEPTED_ID_DOCUMENTS).optional(),
  rejectionReason: z.enum(AGE_CHECK_REJECTION_REASONS).optional(),
  notes: z.string().max(300).optional(),
  /** El repartidor confirma que la persona coincide con el documento y con el comprador. */
  identityMatchesBuyer: z.boolean(),
});
export const DeliverInput = z.object({
  deliveryCode: z.string().regex(/^\d{4}$/),
  cashCollectedCents: cents.optional(),
});
export const FailDeliveryInput = z.object({
  kind: z.enum(['customer_absent', 'wrong_address', 'accident', 'vehicle_breakdown']),
  notes: z.string().min(3).max(300),
});

// ---------- Admin ----------
export const AssignInput = z.object({ courierId: id, reason: z.string().min(3).max(200) });
export const ReasonInput = z.object({ reason: z.string().min(3).max(300) });
export const ReviewInput = z.object({ approve: z.boolean(), reason: z.string().min(3).max(300) });
export const CityPatchInput = z.object({
  status: z.enum(['active', 'paused']).optional(),
  alcoholEnabled: z.boolean().optional(),
  reason: z.string().min(3).max(300),
});
export const ZoneVersionInput = z.object({
  /** GeoJSON Polygon o MultiPolygon en WGS84. */
  geometry: z.object({ type: z.enum(['Polygon', 'MultiPolygon']), coordinates: z.array(z.any()) }),
  reason: z.string().min(3).max(300),
});
export const ZoneSuspensionInput = z.object({
  reason: z.enum(['lluvia', 'bloqueo_vial', 'falta_capacidad', 'otro']),
  detail: z.string().max(300).optional(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
});
export const FeeRuleInput = z.object({
  cityId: id,
  zoneId: id.optional(),
  branchId: id.optional(),
  baseFeeCents: cents,
  includedMeters: z.number().int().min(0).max(50000),
  perKmCents: cents,
  minOrderCents: cents,
  surchargeCents: cents.default(0),
  surchargeLabel: z.string().max(80).optional(),
  maxDistanceMeters: z.number().int().min(100).max(60000),
  reason: z.string().min(3).max(300),
});
export const AlcoholRuleInput = z.object({
  jurisdictionId: id,
  weekday: z.number().int().min(0).max(6),
  start: hhmm,
  end: hhmm,
  source: z.string().min(3).max(300),
  sourceReviewedAt: isoDate,
  responsible: z.string().min(2).max(120),
  validated: z.boolean(),
});
export const AlcoholBlackoutInput = z.object({
  jurisdictionId: id,
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  reason: z.string().min(3).max(300),
  source: z.string().min(3).max(300),
});
export const CouponInput = z.object({
  code: z.string().regex(/^[A-Z0-9_-]{3,40}$/),
  cityId: id.optional(),
  merchantId: id.optional(),
  categoryKind: z.enum(CATEGORY_KINDS).optional(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  minSubtotalCents: cents.default(0),
  discountType: z.enum(['percent', 'fixed', 'free_delivery']),
  value: z.number().int().min(0).max(100000),
  maxDiscountCents: cents.optional(),
  budgetCents: cents.min(1),
  maxUses: z.number().int().min(1),
  perUserLimit: z.number().int().min(1).default(1),
  fundedBy: z.enum(['platform', 'merchant']),
  stackable: z.boolean().default(false),
});
export const SettlementInput = z.object({
  partyType: z.enum(['merchant', 'courier']),
  partyId: id,
  periodStart: z.iso.datetime(),
  periodEnd: z.iso.datetime(),
});
export const CommissionInput = z.object({
  merchantId: id,
  percentBp: z.number().int().min(0).max(5000),
  validFrom: z.iso.datetime(),
  reason: z.string().min(3).max(300),
});
export const RoleGrantInput = z.object({
  userId: id,
  role: z.enum(ROLES),
  cityId: id.optional(),
  merchantId: id.optional(),
  branchId: id.optional(),
  reason: z.string().min(3).max(300),
});
export const IncidentResolveInput = z.object({
  resolution: z.string().min(3).max(1000),
  refundCents: cents.default(0),
  refundConcept: z.enum(['products', 'delivery', 'tip', 'service', 'mixed']).default('mixed'),
});

// ---------- Libro de reclamaciones ----------
export const ComplaintInput = z.object({
  consumerName: z.string().min(2).max(150),
  consumerDocType: z.enum(['dni', 'ce', 'pasaporte', 'ruc']),
  consumerDocNumber: z.string().min(6).max(20),
  consumerEmail: z.email(),
  consumerPhone: z.string().max(20).optional(),
  consumerAddress: z.string().max(200).optional(),
  isMinor: z.boolean().default(false),
  guardianName: z.string().max(150).optional(),
  kind: z.enum(['reclamo', 'queja']),
  goodType: z.enum(['producto', 'servicio']),
  orderId: id.optional(),
  amountCents: cents.optional(),
  detail: z.string().min(10).max(4000),
  request: z.string().min(3).max(2000),
});
export const ComplaintResponseInput = z.object({ response: z.string().min(10).max(4000) });

export type RegisterInput = z.infer<typeof RegisterInput>;
export type LoginInput = z.infer<typeof LoginInput>;
export type AddressInput = z.infer<typeof AddressInput>;
export type PutCartInput = z.infer<typeof PutCartInput>;
export type CartItemInput = z.infer<typeof CartItemInput>;
export type QuoteInput = z.infer<typeof QuoteInput>;
export type CreateOrderInput = z.infer<typeof CreateOrderInput>;
export type ProductInput = z.infer<typeof ProductInput>;
export type ComboInput = z.infer<typeof ComboInput>;
export type CouponInput = z.infer<typeof CouponInput>;
export type ComplaintInput = z.infer<typeof ComplaintInput>;
