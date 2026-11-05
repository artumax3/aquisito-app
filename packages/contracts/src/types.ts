import type {
  AgeStatus,
  CommercialStatus,
  DeliveryStatus,
  PaymentMethod,
  PaymentStatus,
  ProductKind,
  Role,
} from './enums';

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
  correlationId: string;
}

export interface Membership {
  id: string;
  role: Role;
  cityId: string | null;
  merchantId: string | null;
  branchId: string | null;
}

export interface MeDto {
  id: string;
  email: string | null;
  phone: string | null;
  fullName: string;
  declaredBirthDate: string | null;
  ageStatus: AgeStatus;
  memberships: Membership[];
  mfaEnabled: boolean;
  mfaVerified: boolean;
  isDemo: boolean;
}

export interface AuthResult {
  token: string;
  user: MeDto;
  mfaRequired: boolean;
}

export interface CityDto {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  status: 'active' | 'paused';
  pauseReason: string | null;
  center: { lat: number; lng: number };
}

export interface AddressDto {
  id: string;
  cityId: string;
  label: string;
  line1: string;
  number: string | null;
  reference: string | null;
  instructions: string | null;
  lat: number;
  lng: number;
  inCoverage: boolean;
  zoneName: string | null;
}

export interface StoreSummaryDto {
  id: string;
  merchantId: string;
  name: string;
  merchantName: string;
  cityId: string;
  categoryKinds: string[];
  isOpen: boolean;
  closedReason: string | null;
  prepMinutes: number;
  etaMinutes: { min: number; max: number } | null;
  deliveryFeeCents: number | null;
  distanceMethod: 'route' | 'approx_haversine' | null;
  minOrderCents: number | null;
  rating: number | null;
  imageUrl: string | null;
  isDemo: boolean;
  acceptsCash: boolean;
}

export interface ModifierOptionDto {
  id: string;
  name: string;
  priceCents: number;
}
export interface ModifierGroupDto {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: ModifierOptionDto[];
}
export interface VariantDto {
  id: string;
  name: string;
  priceCents: number;
  available: number | null; // null = sin control de inventario (plato preparado)
  unit: string | null;
}
export interface ComboComponentDto {
  id: string;
  label: string;
  quantity: number;
  options: { variantId: string; name: string; unitPriceCents: number }[];
}
export interface ProductDto {
  id: string;
  branchId: string;
  categoryId: string;
  categoryName: string;
  name: string;
  description: string;
  imageUrl: string | null;
  kind: ProductKind;
  containsAlcohol: boolean;
  minimumAge: number | null;
  variants: VariantDto[];
  modifierGroups: ModifierGroupDto[];
  combo: {
    components: ComboComponentDto[];
    referencePriceCents: number;
    savingsCents: number;
    conditions: string[];
  } | null;
  available: boolean;
}

export interface StoreDetailDto extends StoreSummaryDto {
  address: string;
  hours: { weekday: number; opens: string; closes: string }[];
  products: ProductDto[];
  restrictedContentHidden: boolean;
  sellsAlcohol: boolean;
}

export interface CartLineDto {
  index: number;
  productId: string;
  variantId: string;
  name: string;
  variantName: string;
  quantity: number;
  unitPriceCents: number;
  modifiersCents: number;
  lineTotalCents: number;
  modifierOptionIds: string[];
  comboSelections: Record<string, string>;
  notes: string | null;
  containsAlcohol: boolean;
  problem: string | null;
}
export interface CartDto {
  branchId: string | null;
  branchName: string | null;
  lines: CartLineDto[];
  subtotalCents: number;
  containsAlcohol: boolean;
  problems: string[];
}

export interface QuoteDto {
  id: string;
  version: number;
  expiresAt: string;
  branchId: string;
  addressId: string;
  lines: CartLineDto[];
  subtotalCents: number;
  discountCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  surchargeCents: number;
  surchargeLabel: string | null;
  tipCents: number;
  totalCents: number;
  distanceMeters: number;
  distanceMethod: 'route' | 'approx_haversine';
  etaMinutes: { min: number; max: number };
  paymentMethod: PaymentMethod;
  containsAlcohol: boolean;
  alcoholNotice: string | null;
  couponCode: string | null;
  scheduledSlotStart: string | null;
  breakdown: { label: string; amountCents: number }[];
}

export interface StatusEventDto {
  cycle: 'commercial' | 'delivery' | 'payment';
  from: string | null;
  to: string;
  at: string;
  reason: string | null;
  actorRole: string | null;
}

export interface OrderLineDto {
  id: string;
  name: string;
  variantName: string;
  quantity: number;
  unitPriceCents: number;
  modifiersCents: number;
  discountCents: number;
  lineTotalCents: number;
  containsAlcohol: boolean;
  notes: string | null;
  components: { name: string; quantity: number }[];
  removed: boolean;
}

export interface OrderDto {
  id: string;
  number: number;
  code: string;
  cityId: string;
  branchId: string;
  branchName: string;
  commercialStatus: CommercialStatus;
  deliveryStatus: DeliveryStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod;
  subtotalCents: number;
  discountCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  surchargeCents: number;
  tipCents: number;
  totalCents: number;
  refundedCents: number;
  containsAlcohol: boolean;
  scheduledFor: string | null;
  createdAt: string;
  acceptDeadline: string | null;
  etaAt: string | null;
  address: { line1: string; reference: string | null; lat: number; lng: number } | null;
  courier: { name: string; vehicleType: string } | null;
  lines: OrderLineDto[];
  history: StatusEventDto[];
  version: number;
  latestPaymentId: string | null;
  substitutions: { id: string; orderLineId: string; kind: string; status: string; note: string | null; priceDiffCents: number }[];
  canCancel: boolean;
  canRate: boolean;
  pickupCode?: string;
}

export interface OfferDto {
  id: string;
  orderId: string;
  expiresAt: string;
  branchName: string;
  branchLocation: { lat: number; lng: number };
  /** Solo zona aproximada antes de aceptar. */
  destinationArea: string;
  estimatedDistanceMeters: number;
  estimatedPayCents: number;
  containsAlcohol: boolean;
  cashToCollectCents: number | null;
}

export interface CourierDeliveryDto {
  orderId: string;
  orderNumber: number;
  deliveryStatus: DeliveryStatus;
  commercialStatus: CommercialStatus;
  branch: { name: string; address: string; lat: number; lng: number };
  customer: { name: string; phoneMasked: string | null; address: string; reference: string | null; instructions: string | null; lat: number; lng: number };
  containsAlcohol: boolean;
  cashToCollectCents: number | null;
  cashChangeForCents: number | null;
  packages: number;
  ageCheckApproved: boolean;
}

export interface TrackingDto {
  available: boolean;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  recordedAt: string | null;
  stale: boolean;
}
