import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as S from '@aquisito/contracts';
import { Auth, AuthCtx, Public, Roles } from './common/auth';
import { BizError, parse } from './common/errors';
import { db } from './db/db';
import * as identity from './modules/identity/identity.service';
import * as geo from './modules/geo/geo.service';
import * as catalog from './modules/catalog/catalog.service';
import * as orders from './modules/orders/orders.service';
import * as payments from './modules/payments/payments.service';
import * as dispatch from './modules/dispatch/dispatch.service';
import * as merchant from './modules/merchant/merchant.service';
import * as admin from './modules/admin/admin.service';
import * as support from './modules/support/support.service';
import * as notifications from './modules/notifications/notifications.service';
import * as documents from './modules/documents/documents.service';
import * as banners from './modules/promotions/banners.service';
import { storage, verifyLocalSignature } from './providers/storage';
import { jobStats } from './jobs';
import { metrics } from './metrics';
import { tx } from './db/db';
import { audit as auditLog } from './common/audit';

const ip = (req: Request) => (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
const isWeb = (req: Request) => req.headers['x-client'] === 'web';

function sessionResponse(req: Request, res: Response, r: { token: string; user: any; mfaRequired: boolean; ttlHours: number }) {
  if (isWeb(req)) {
    identity.setSessionCookies(res, r.token, r.ttlHours);
    return { user: r.user, mfaRequired: r.mfaRequired };
  }
  return { token: r.token, user: r.user, mfaRequired: r.mfaRequired };
}

@Controller()
export class AuthController {
  @Public() @Post('auth/register')
  async register(@Body() b: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return sessionResponse(req, res, await identity.register(parse(S.RegisterInput, b)));
  }
  @Public() @Post('auth/login') @HttpCode(200)
  async login(@Body() b: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return sessionResponse(req, res, await identity.login(parse(S.LoginInput, b), ip(req)));
  }
  @Public() @Post('auth/otp/request') @HttpCode(200)
  otpRequest(@Body() b: unknown, @Req() req: Request) {
    return identity.requestOtp(parse(S.OtpRequestInput, b).phone, ip(req));
  }
  @Public() @Post('auth/otp/verify') @HttpCode(200)
  async otpVerify(@Body() b: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return sessionResponse(req, res, await identity.verifyOtp(parse(S.OtpVerifyInput, b)));
  }
  @Post('auth/mfa/setup') mfaSetup(@Auth() a: AuthCtx) { return identity.mfaSetup(a); }
  @Post('auth/mfa/verify') @HttpCode(200) mfaVerify(@Auth() a: AuthCtx, @Body() b: unknown) { return identity.mfaVerify(a, parse(S.MfaVerifyInput, b).code); }
  @Post('auth/logout') @HttpCode(200)
  async logout(@Auth() a: AuthCtx, @Res({ passthrough: true }) res: Response) {
    await identity.revokeSession(a, a.sessionId);
    identity.clearSessionCookies(res);
    return { loggedOut: true };
  }
  @Get('auth/sessions') sessions(@Auth() a: AuthCtx) { return identity.listSessions(a); }
  @Delete('auth/sessions/:id') revoke(@Auth() a: AuthCtx, @Param('id') id: string) { return identity.revokeSession(a, id); }
  @Public() @Post('auth/password/reset-request') @HttpCode(200)
  resetReq(@Body() b: unknown) { return identity.passwordResetRequest(parse(S.PasswordResetRequestInput, b).email); }
  @Public() @Post('auth/password/reset') @HttpCode(200)
  reset(@Body() b: unknown) { const i = parse(S.PasswordResetInput, b); return identity.passwordReset(i.token, i.password); }
}

@Controller()
export class MeController {
  @Get('me') me(@Auth() a: AuthCtx) { return identity.buildMe(a.userId, a.sessionId); }
  @Patch('me') update(@Auth() a: AuthCtx, @Body() b: unknown) { return identity.updateMe(a, parse(S.UpdateMeInput, b)); }
  @Get('me/addresses')
  async addresses(@Auth() a: AuthCtx) {
    const rows = await db.q(`SELECT *, ST_Y(location) AS lat, ST_X(location) AS lng FROM addresses WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`, [a.userId]);
    return Promise.all(rows.map(async (r) => {
      const c = await geo.checkCoverage(r.city_id, r.lat, r.lng);
      return { id: r.id, cityId: r.city_id, label: r.label, line1: r.line1, number: r.number, reference: r.reference, instructions: r.instructions, lat: r.lat, lng: r.lng, inCoverage: c.inCoverage, zoneName: c.zoneName, coverageMessage: c.reason };
    }));
  }
  @Post('me/addresses')
  async addAddress(@Auth() a: AuthCtx, @Body() b: unknown) {
    const i = parse(S.AddressInput, b);
    const c = await geo.checkCoverage(i.cityId, i.lat, i.lng);
    const r = await db.one(
      `INSERT INTO addresses(user_id, city_id, jurisdiction_id, label, line1, number, reference, instructions, location, point_confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, ST_SetSRID(ST_MakePoint($9,$10),4326), now()) RETURNING id`,
      [a.userId, i.cityId, c.jurisdictionId, i.label, i.line1, i.number ?? null, i.reference ?? null, i.instructions ?? null, i.lng, i.lat],
    );
    return { id: r.id, inCoverage: c.inCoverage, coverageMessage: c.reason, zoneName: c.zoneName };
  }
  @Delete('me/addresses/:id')
  async delAddress(@Auth() a: AuthCtx, @Param('id') id: string) {
    const r = await db.q(`UPDATE addresses SET deleted_at = now() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id`, [id, a.userId]);
    if (!r.length) throw new BizError('NOT_FOUND', 'Dirección no encontrada', 404);
    return { deleted: true };
  }
  @Get('me/consents') consents(@Auth() a: AuthCtx) { return identity.listConsents(a); }
  @Post('me/consents') setConsent(@Auth() a: AuthCtx, @Body() b: unknown) { return identity.setConsent(a, parse(S.ConsentInput, b)); }
  @Post('me/data-requests') dataReq(@Auth() a: AuthCtx, @Body() b: unknown) { return identity.createDataRequest(a, parse(S.DataRequestInput, b)); }
  @Get('me/data-requests') dataReqs(@Auth() a: AuthCtx) { return db.q(`SELECT id, kind, status, due_at, resolution, created_at, resolved_at FROM data_requests WHERE user_id = $1 ORDER BY created_at DESC`, [a.userId]); }
  @Get('me/favorites')
  async favorites(@Auth() a: AuthCtx) {
    return db.q(`SELECT f.branch_id, b.name, b.city_id FROM favorites f JOIN branches b ON b.id = f.branch_id WHERE f.user_id = $1 ORDER BY f.created_at DESC`, [a.userId]);
  }
  @Post('me/favorites/:branchId')
  async addFav(@Auth() a: AuthCtx, @Param('branchId') id: string) {
    const b = await db.maybe(`SELECT id FROM branches WHERE id = $1 AND status = 'active'`, [id]);
    if (!b) throw new BizError('NOT_FOUND', 'Comercio no encontrado', 404);
    await db.q(`INSERT INTO favorites(user_id, branch_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [a.userId, id]);
    return { favorite: true };
  }
  @Delete('me/favorites/:branchId')
  async delFav(@Auth() a: AuthCtx, @Param('branchId') id: string) {
    await db.q(`DELETE FROM favorites WHERE user_id = $1 AND branch_id = $2`, [a.userId, id]);
    return { favorite: false };
  }
  @Post('me/push-tokens')
  pushToken(@Auth() a: AuthCtx, @Body() b: any) {
    if (typeof b?.token !== 'string' || !['android', 'ios', 'web'].includes(b?.platform)) throw new BizError('VALIDATION', 'Token inválido', 400);
    return notifications.registerPushToken(a, b.token.slice(0, 300), b.platform);
  }
  @Get('notifications') notifs(@Auth() a: AuthCtx) { return notifications.listNotifications(a); }
  @Post('notifications/:id/read') @HttpCode(200) read(@Auth() a: AuthCtx, @Param('id') id: string) { return notifications.markRead(a, id); }
  @Get('realtime') realtime(@Auth() a: AuthCtx, @Res() res: Response) { return notifications.subscribe(a, res); }
}

@Controller()
export class CatalogController {
  @Public() @Get('cities') cities() { return geo.listCities(); }
  @Public() @Get('cities/suggest')
  suggest(@Query('lat') lat: string, @Query('lng') lng: string) { return geo.suggestCity(Number(lat), Number(lng)); }
  @Public() @Get('cities/:id/zones') zones(@Param('id') id: string) { return geo.cityZones(id); }
  @Public() @Post('coverage/check') @HttpCode(200)
  coverage(@Body() b: unknown) { const i = parse(S.CoverageCheckInput, b); return geo.checkCoverage(i.cityId, i.lat, i.lng); }
  @Public() @Get('stores')
  stores(@Req() req: any, @Query() q: unknown) { return catalog.listStores(req.auth, parse(S.StoreListQuery, q)); }
  @Public() @Get('stores/:id')
  store(@Req() req: any, @Param('id') id: string, @Query('lat') lat?: string, @Query('lng') lng?: string) {
    return catalog.storeDetail(req.auth, id, lat && lng ? { lat: Number(lat), lng: Number(lng) } : undefined);
  }
  @Public() @Get('stores/:id/slots') slots(@Param('id') id: string) { return orders.listSlots(id); }
  @Public() @Get('banners') banners(@Req() req: any, @Query('cityId') cityId: string) { return banners.activeBanners(req.auth, cityId); }
  @Public() @Get('products/:id') product(@Req() req: any, @Param('id') id: string) { return catalog.productDetail(req.auth, id); }
  @Public() @Get('search') search(@Req() req: any, @Query('cityId') cityId: string, @Query('q') q: string) { return catalog.search(req.auth, cityId, q); }
}

@Controller()
export class OrdersController {
  @Get('cart') cart(@Auth() a: AuthCtx) { return orders.getCart(a); }
  @Put('cart') putCart(@Auth() a: AuthCtx, @Body() b: unknown) { return orders.putCart(a, parse(S.PutCartInput, b)); }
  @Delete('cart') clear(@Auth() a: AuthCtx) { return orders.clearCart(a); }
  @Post('checkout/quotes') quote(@Auth() a: AuthCtx, @Body() b: unknown) { return orders.createQuote(a, parse(S.QuoteInput, b)); }
  @Post('orders')
  async create(@Auth() a: AuthCtx, @Body() b: unknown, @Headers('idempotency-key') key: string, @Res({ passthrough: true }) res: Response) {
    const r = await orders.createOrder(a, parse(S.CreateOrderInput, b), key);
    res.status(r.replayed ? 200 : 201);
    res.setHeader('Idempotent-Replayed', String(r.replayed));
    return r.order;
  }
  @Get('orders') list(@Auth() a: AuthCtx) { return orders.listOrders(a); }
  @Get('orders/:id') get(@Auth() a: AuthCtx, @Param('id') id: string) { return orders.getOrder(a, id); }
  @Post('orders/:id/cancel') @HttpCode(200) cancel(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return orders.cancelByCustomer(a, id, parse(S.CancelOrderInput, b).reason); }
  @Post('orders/:id/reorder') @HttpCode(200) reorder(@Auth() a: AuthCtx, @Param('id') id: string) { return orders.reorder(a, id); }
  @Get('orders/:id/delivery-code') code(@Auth() a: AuthCtx, @Param('id') id: string) { return orders.deliveryCode(a, id); }
  @Get('orders/:id/tracking') tracking(@Auth() a: AuthCtx, @Param('id') id: string) { return orders.tracking(a, id); }
  @Get('orders/:id/messages') msgs(@Auth() a: AuthCtx, @Param('id') id: string) { return support.messages(a, id); }
  @Post('orders/:id/messages') send(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return support.sendMessage(a, id, parse(S.MessageInput, b).body); }
  @Post('orders/:id/incidents') incident(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return support.reportIncident(a, id, parse(S.IncidentInput, b)); }
  @Post('orders/:id/rating') rate(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return support.rate(a, id, parse(S.RatingInput, b)); }
  @Post('orders/:id/substitutions/:sid/respond') @HttpCode(200)
  subst(@Auth() a: AuthCtx, @Param('id') id: string, @Param('sid') sid: string, @Body() b: unknown) { return merchant.respondSubstitution(a, id, sid, parse(S.SubstitutionResponseInput, b).accept); }

  @Post('payments') pay(@Auth() a: AuthCtx, @Body() b: unknown, @Headers('idempotency-key') key: string) { return payments.startPayment(a, parse(S.StartPaymentInput, b), key); }
  @Public() @Get('payments/config') paymentsConfig() { return payments.publicPaymentsConfig(); }
  @Get('payments/:id') payment(@Auth() a: AuthCtx, @Param('id') id: string) { return payments.getPayment(a, id); }
  @Public() @Post('webhooks/payments/:provider') @HttpCode(200)
  webhook(@Param('provider') provider: string, @Req() req: Request & { rawBody?: Buffer }) {
    return payments.handleWebhook(provider, req.headers as any, req.rawBody?.toString('utf8') ?? '');
  }
  @Post('dev/payments/:id/simulate') @HttpCode(200)
  simulate(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return payments.simulate(a, id, parse(S.SimulatePaymentInput, b).outcome); }

  @Post('age-verifications') ageReq(@Auth() a: AuthCtx, @Body() b: unknown) { return support.requestAgeVerification(a, parse(S.AgeVerificationInput, b)); }
  @Get('age-verifications/me') ageMe(@Auth() a: AuthCtx) { return support.myAgeVerification(a); }

  @Public() @Post('complaints') complaint(@Req() req: any, @Body() b: unknown) { return support.createComplaint(req.auth, parse(S.ComplaintInput, b)); }
  @Public() @Get('complaints/:number') getComplaint(@Param('number') n: string, @Query('email') email: string) { return support.getComplaint(n, email); }
}

const MERCHANT = ['merchant_owner', 'branch_operator'] as const;

@Controller('merchant')
export class MerchantController {
  @Post('applications') apply(@Auth() a: AuthCtx, @Body() b: unknown) { return merchant.apply(a, parse(S.MerchantApplicationInput, b)); }
  @Roles(...MERCHANT) @Get('branches') branches(@Auth() a: AuthCtx) { return merchant.myBranches(a); }
  @Roles(...MERCHANT) @Get('branches/:id/orders') inbox(@Auth() a: AuthCtx, @Param('id') id: string, @Query('scope') scope: string) { return merchant.inbox(a, id, scope); }
  @Roles(...MERCHANT) @Post('orders/:id/accept') @HttpCode(200) accept(@Auth() a: AuthCtx, @Param('id') id: string) { return merchant.accept(a, id); }
  @Roles(...MERCHANT) @Post('orders/:id/reject') @HttpCode(200) reject(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return merchant.reject(a, id, parse(S.RejectOrderInput, b).reason); }
  @Roles(...MERCHANT) @Post('orders/:id/start') @HttpCode(200) start(@Auth() a: AuthCtx, @Param('id') id: string) { return merchant.startPrep(a, id); }
  @Roles(...MERCHANT) @Post('orders/:id/ready') @HttpCode(200) ready(@Auth() a: AuthCtx, @Param('id') id: string) { return merchant.ready(a, id); }
  @Roles(...MERCHANT) @Post('orders/:id/eta') @HttpCode(200) eta(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return merchant.setEta(a, id, parse(S.EtaInput, b).prepMinutes); }
  @Roles(...MERCHANT) @Post('orders/:id/substitutions') subst(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return merchant.proposeSubstitution(a, id, parse(S.SubstitutionProposalInput, b)); }
  @Roles(...MERCHANT) @Post('orders/:id/return-inspection') @HttpCode(200) ret(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return merchant.returnInspection(a, id, parse(S.ReturnInspectionInput, b)); }
  @Roles(...MERCHANT) @Get('orders/:id/ticket')
  async ticket(@Auth() a: AuthCtx, @Param('id') id: string, @Res() res: Response) { res.type('text/plain; charset=utf-8').send(await merchant.ticket(a, id)); }
  @Roles(...MERCHANT) @Get('branches/:id/catalog') catalog(@Auth() a: AuthCtx, @Param('id') id: string) { return merchant.catalog(a, id); }
  @Roles(...MERCHANT) @Post('branches/:id/products') product(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return merchant.createProduct(a, id, parse(S.ProductInput, b)); }
  @Roles(...MERCHANT) @Patch('products/:id') patch(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return merchant.patchProduct(a, id, parse(S.ProductPatchInput, b)); }
  @Roles(...MERCHANT) @Post('skus/:id/adjust') @HttpCode(200) stock(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return merchant.stockAdjust(a, id, parse(S.StockAdjustInput, b)); }
  @Roles(...MERCHANT) @Post('branches/:id/combos') combo(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return merchant.createCombo(a, id, parse(S.ComboInput, b)); }
  @Roles(...MERCHANT) @Put('branches/:id/hours') hours(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return merchant.setHours(a, id, parse(S.BranchHoursInput, b).hours); }
  @Roles(...MERCHANT) @Post('branches/:id/closures') closure(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return merchant.addClosure(a, id, parse(S.ClosureInput, b)); }
  @Roles(...MERCHANT) @Post('branches/:id/pause') @HttpCode(200) pause(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return merchant.pause(a, id, parse(S.PauseInput, b)); }
  @Roles(...MERCHANT) @Get('branches/:id/report') report(@Auth() a: AuthCtx, @Param('id') id: string, @Query('from') f?: string, @Query('to') t?: string) { return merchant.report(a, id, f, t); }
  @Roles(...MERCHANT) @Get('branches/:id/export.csv')
  async exp(@Auth() a: AuthCtx, @Param('id') id: string, @Res() res: Response, @Query('from') f?: string, @Query('to') t?: string) {
    res.type('text/csv; charset=utf-8').setHeader('Cache-Control', 'private, no-store');
    res.send(await merchant.exportCsv(a, id, f, t));
  }
  @Roles(...MERCHANT) @Get('branches/:id/documents') docs(@Auth() a: AuthCtx, @Param('id') id: string) { return documents.listFor(a, 'branch', id); }
  @Roles('merchant_owner') @Post('branches/:id/operators') op(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return merchant.addOperator(a, id, parse(S.OperatorInput, b).email); }
}

@Controller('courier')
export class CourierController {
  @Post('applications') apply(@Auth() a: AuthCtx, @Body() b: unknown) { return support.courierApply(a, parse(S.CourierApplicationInput, b)); }
  @Roles('courier') @Get('me') me(@Auth() a: AuthCtx) { return support.courierMe(a); }
  @Roles('courier') @Put('availability') avail(@Auth() a: AuthCtx, @Body() b: unknown) { return dispatch.setAvailability(a, parse(S.AvailabilityInput, b).available); }
  @Roles('courier') @Post('location') @HttpCode(200) loc(@Auth() a: AuthCtx, @Body() b: unknown) { return dispatch.updateLocation(a, parse(S.LocationInput, b)); }
  @Roles('courier') @Get('offers') offers(@Auth() a: AuthCtx) { return dispatch.listOffers(a); }
  @Roles('courier') @Post('offers/:id/accept') @HttpCode(200) accept(@Auth() a: AuthCtx, @Param('id') id: string) { return dispatch.acceptOffer(a, id); }
  @Roles('courier') @Post('offers/:id/reject') @HttpCode(200) reject(@Auth() a: AuthCtx, @Param('id') id: string) { return dispatch.rejectOffer(a, id); }
  @Roles('courier') @Get('deliveries/current') current(@Auth() a: AuthCtx) { return dispatch.currentDelivery(a).then((d) => d ?? { none: true }); }
  @Roles('courier') @Post('deliveries/:orderId/heading-to-store') @HttpCode(200) heading(@Auth() a: AuthCtx, @Param('orderId') id: string) { return dispatch.headingToStore(a, id); }
  @Roles('courier') @Post('deliveries/:orderId/release') @HttpCode(200) release(@Auth() a: AuthCtx, @Param('orderId') id: string, @Body() b: unknown) { return dispatch.unassign(a, id, parse(S.ReasonInput, b).reason, 'courier'); }
  @Roles('courier') @Post('deliveries/:orderId/pickup') @HttpCode(200) pickup(@Auth() a: AuthCtx, @Param('orderId') id: string, @Body() b: unknown) { return dispatch.pickup(a, id, parse(S.PickupInput, b)); }
  @Roles('courier') @Post('deliveries/:orderId/depart') @HttpCode(200) depart(@Auth() a: AuthCtx, @Param('orderId') id: string) { return dispatch.depart(a, id); }
  @Roles('courier') @Post('deliveries/:orderId/arrive') @HttpCode(200) arrive(@Auth() a: AuthCtx, @Param('orderId') id: string) { return dispatch.arrive(a, id); }
  @Roles('courier') @Post('deliveries/:orderId/age-check') @HttpCode(200) age(@Auth() a: AuthCtx, @Param('orderId') id: string, @Body() b: unknown) { return dispatch.ageCheck(a, id, parse(S.AgeCheckInput, b)); }
  @Roles('courier') @Post('deliveries/:orderId/deliver') @HttpCode(200) deliver(@Auth() a: AuthCtx, @Param('orderId') id: string, @Body() b: unknown) { return dispatch.deliver(a, id, parse(S.DeliverInput, b)); }
  @Roles('courier') @Post('deliveries/:orderId/fail') @HttpCode(200) fail(@Auth() a: AuthCtx, @Param('orderId') id: string, @Body() b: unknown) { return dispatch.failDelivery(a, id, parse(S.FailDeliveryInput, b)); }
  @Roles('courier') @Get('earnings') earnings(@Auth() a: AuthCtx) { return dispatch.earnings(a); }
  @Roles('courier') @Get('documents') docs(@Auth() a: AuthCtx) { return documents.listFor(a, 'courier', a.userId); }
  @Roles('courier') @Get('history') history(@Auth() a: AuthCtx) { return dispatch.history(a); }
}

const OPS = ['admin', 'city_dispatcher', 'support_agent'] as const;

@Controller('admin')
export class AdminController {
  @Roles(...OPS, 'finance') @Get('dashboard') dash(@Auth() a: AuthCtx, @Query() q: any) { return admin.dashboard(a, q); }
  @Roles(...OPS, 'finance') @Get('orders') orders(@Auth() a: AuthCtx, @Query() q: any) { return admin.listOrders(a, q); }
  @Roles(...OPS, 'finance') @Get('orders/:id') order(@Auth() a: AuthCtx, @Param('id') id: string) { return admin.orderDetail(a, id); }
  @Roles('admin', 'city_dispatcher') @Post('orders/:id/assign') @HttpCode(200) assign(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { const i = parse(S.AssignInput, b); return dispatch.manualAssign(a, id, i.courierId, i.reason); }
  @Roles('admin', 'city_dispatcher') @Post('orders/:id/unassign') @HttpCode(200) unassign(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return dispatch.unassign(a, id, parse(S.ReasonInput, b).reason); }
  @Roles('admin', 'support_agent', 'city_dispatcher') @Post('orders/:id/cancel') @HttpCode(200) cancel(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return admin.cancelOrder(a, id, parse(S.ReasonInput, b).reason); }
  @Roles(...OPS) @Get('couriers') couriers(@Auth() a: AuthCtx) { return admin.couriers(a); }
  @Roles('admin', 'city_dispatcher') @Post('couriers/:id/review') @HttpCode(200) reviewCourier(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return admin.reviewCourier(a, id, parse(S.ReviewInput, b)); }
  @Roles('admin') @Post('couriers/:id/training') @HttpCode(200)
  training(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: any) {
    const topics = Array.isArray(b?.topics) ? b.topics.filter((t: unknown) => ['documentos', 'rechazo', 'privacidad', 'soporte', 'venta_responsable'].includes(t as string)) : [];
    return admin.recordTraining(a, id, topics);
  }
  @Roles(...OPS) @Get('merchants') merchants(@Auth() a: AuthCtx) { return admin.merchants(a); }
  @Roles('admin') @Post('merchants/:id/review') @HttpCode(200) reviewMerchant(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return admin.reviewMerchant(a, id, parse(S.ReviewInput, b)); }
  @Roles('admin') @Post('branches/:id/alcohol-permit') @HttpCode(200) permit(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return admin.reviewAlcoholPermit(a, id, parse(S.ReviewInput, b)); }
  @Roles('admin', 'support_agent') @Get('age-verifications') ageQ(@Auth() a: AuthCtx) { return admin.ageQueue(a); }
  @Roles('admin') @Post('age-verifications/:id/decide') @HttpCode(200) ageD(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return admin.ageDecide(a, id, parse(S.AgeVerificationDecisionInput, b)); }
  @Roles('admin') @Patch('cities/:id') city(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return admin.patchCity(a, id, parse(S.CityPatchInput, b)); }
  @Roles('admin') @Post('zones/:id/versions') zoneV(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return admin.newZoneVersion(a, id, parse(S.ZoneVersionInput, b)); }
  @Roles('admin', 'city_dispatcher') @Post('zones/:id/suspensions') zoneS(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return admin.suspendZone(a, id, parse(S.ZoneSuspensionInput, b)); }
  @Roles('admin') @Post('fee-rules') fee(@Auth() a: AuthCtx, @Body() b: unknown) { return admin.createFeeRule(a, parse(S.FeeRuleInput, b)); }
  @Roles('admin', 'city_dispatcher') @Get('fee-rules') fees() { return admin.feeRules(); }
  @Roles('admin') @Get('alcohol-rules') arules() { return admin.alcoholRules(); }
  @Roles('admin') @Post('alcohol-rules') arule(@Auth() a: AuthCtx, @Body() b: unknown) { return admin.createAlcoholRule(a, parse(S.AlcoholRuleInput, b)); }
  @Roles('admin') @Post('alcohol-blackouts') blackout(@Auth() a: AuthCtx, @Body() b: unknown) { return admin.createBlackout(a, parse(S.AlcoholBlackoutInput, b)); }
  @Roles('admin', 'finance') @Get('coupons') coupons() { return admin.coupons(); }
  @Roles('admin') @Post('coupons') coupon(@Auth() a: AuthCtx, @Body() b: unknown) { return admin.createCoupon(a, parse(S.CouponInput, b)); }
  @Roles('admin', 'finance') @Post('commissions') commission(@Auth() a: AuthCtx, @Body() b: unknown) { return admin.setCommission(a, parse(S.CommissionInput, b)); }
  @Roles('admin', 'finance', 'support_agent') @Post('payments/:id/refunds') refund(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown, @Headers('idempotency-key') key: string) { return admin.refund(a, id, parse(S.RefundInput, b), key); }
  @Roles('finance') @Post('payments/:id/confirm-manual') @HttpCode(200) manual(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return payments.confirmManualPayment(a, id, parse(S.ManualPaymentConfirmInput, b)); }
  @Roles('finance') @Post('refunds/:id/confirm-manual') @HttpCode(200)
  manualRefund(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return admin.confirmManualRefund(a, id, parse(S.ManualRefundConfirmInput, b).reference); }
  @Roles('finance', 'admin', 'support_agent') @Get('refunds') refundsList(@Query('status') st?: string) { return admin.refunds(st); }
  @Roles('finance') @Post('settlements/:id/approve') @HttpCode(200) approveS(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return admin.approveSettlement(a, id, parse(S.ReasonInput, b).reason); }
  @Roles('finance') @Post('settlements/:id/execute') @HttpCode(200) executeS(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return admin.executeSettlement(a, id, parse(S.SettlementExecuteInput, b)); }
  @Roles('finance') @Post('settlements/:id/void') @HttpCode(200) voidS(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return admin.voidSettlement(a, id, parse(S.ReasonInput, b).reason); }
  @Roles('finance', 'admin', 'city_dispatcher') @Get('couriers/:id/cash') cash(@Auth() a: AuthCtx, @Param('id') id: string) { return admin.courierCash(a, id); }
  @Roles('finance') @Post('couriers/:id/cash-remittance') @HttpCode(200) remit(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return admin.cashRemittance(a, id, parse(S.CashRemittanceInput, b)); }
  @Roles('admin', 'finance') @Post('payments/reconcile') @HttpCode(200) reconcile() { return payments.reconcilePending(0); }
  @Roles('finance', 'admin') @Get('settlements') settlements() { return admin.settlements(); }
  @Roles('finance') @Post('settlements') settle(@Auth() a: AuthCtx, @Body() b: unknown) { return admin.createSettlement(a, parse(S.SettlementInput, b)); }
  @Roles('finance', 'admin') @Get('settlements/:id') settlement(@Auth() a: AuthCtx, @Param('id') id: string) { return admin.settlementDetail(a, id); }
  @Roles('finance', 'admin') @Get('ledger') ledger(@Query() q: any) { return admin.ledger(q); }
  @Roles(...OPS) @Get('incidents') incidents(@Auth() a: AuthCtx) { return admin.incidents(a); }
  @Roles('admin', 'support_agent') @Post('incidents/:id/resolve') @HttpCode(200) resolve(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return admin.resolveIncident(a, id, parse(S.IncidentResolveInput, b)); }
  @Roles('admin', 'support_agent') @Get('complaints') complaints() { return support.listComplaints(); }
  @Roles('admin', 'support_agent') @Post('complaints/:id/respond') @HttpCode(200) respond(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return support.respondComplaint(a, id, parse(S.ComplaintResponseInput, b).response); }
  @Roles('admin') @Get('documents') documents() { return documents.reviewQueue(); }
  @Roles('admin') @Post('documents/:id/review') @HttpCode(200) reviewDoc(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return documents.review(a, id, parse(S.DocumentReviewInput, b)); }
  @Roles('admin') @Get('banners') banners() { return banners.listAll(); }
  @Roles('admin') @Post('banners') banner(@Auth() a: AuthCtx, @Body() b: unknown) { return banners.create(a, parse(S.BannerInput, b)); }
  @Roles('admin') @Patch('banners/:id') bannerPatch(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { const i = parse(S.BannerPatchInput, b); return banners.setActive(a, id, i.active, i.reason); }
  @Roles('admin') @Get('audit') audit() { return admin.auditLog(); }
  @Roles('admin') @Get('outbox') outbox() { return admin.outbox(); }
  @Roles('admin') @Get('users') user(@Query('email') email: string) { return admin.findUser(email); }
  @Roles('admin') @Post('roles/:id/revoke') @HttpCode(200) revokeRole(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return admin.revokeRole(a, id, parse(S.ReasonInput, b).reason); }
  @Roles('admin') @Post('roles') role(@Auth() a: AuthCtx, @Body() b: unknown) { return admin.grantRole(a, parse(S.RoleGrantInput, b)); }
  @Roles('admin') @Get('data-requests') dr() { return admin.dataRequests(); }
  @Roles('admin') @Post('data-requests/:id/process') @HttpCode(200) drp(@Auth() a: AuthCtx, @Param('id') id: string, @Body() b: unknown) { return admin.processDataRequest(a, id, parse(S.ReasonInput, b).reason); }
  @Roles('admin', 'finance') @Get('export/orders.csv')
  async export(@Auth() a: AuthCtx, @Query() q: any, @Res() res: Response) {
    res.type('text/csv; charset=utf-8').setHeader('Cache-Control', 'private, no-store');
    res.send(await admin.exportOrdersCsv(a, q));
  }
}

@Controller()
export class OpsController {
  @Public() @Get('health')
  async health() {
    const r = await db.one(`SELECT 1 AS ok, postgis_version() AS postgis`);
    return { status: 'ok', db: r.ok === 1, postgis: r.postgis, jobs: { lastRunAt: jobStats.lastRunAt, runs: jobStats.runs } };
  }
  @Roles('admin') @Get('metrics')
  async metrics() {
    const g = await db.one(
      `SELECT (SELECT count(*) FROM outbox_events WHERE processed_at IS NULL AND dead_at IS NULL)::int AS outbox_pending,
              (SELECT count(*) FROM outbox_events WHERE dead_at IS NOT NULL)::int AS outbox_dead,
              (SELECT count(*) FROM payments WHERE status = 'en_conciliacion')::int AS payments_uncertain,
              (SELECT count(*) FROM payments WHERE status = 'fallido' AND created_at > now() - interval '1 hour')::int AS payment_failures_1h,
              (SELECT count(*) FROM inventory_reservations WHERE status = 'active' AND expires_at < now())::int AS reservations_expired_unreleased,
              (SELECT count(*) FROM orders WHERE commercial_status IN ('confirmado','aceptado_comercio','en_preparacion','listo_para_recojo') AND created_at < now() - interval '2 hours')::int AS stuck_orders`,
    );
    return { gauges: g, http: metrics.snapshot(), jobs: jobStats };
  }

  /** Subida de documentos/evidencias privados: titularidad verificada, tipo por firma de bytes, 5 MB. */
  @Post('files')
  upload(@Auth() a: AuthCtx, @Body() b: unknown) {
    return documents.upload(a, parse(S.DocumentUploadInput, b));
  }

  @Get('files/:id/url')
  async fileUrl(@Auth() a: AuthCtx, @Param('id') id: string) {
    const d = await db.maybe(`SELECT * FROM documents WHERE id = $1`, [id]);
    const staff = a.roles.has('admin') || a.roles.has('support_agent');
    if (!d || (d.uploaded_by !== a.userId && !staff)) throw new BizError('NOT_FOUND', 'Archivo no encontrado', 404);
    if (staff && d.uploaded_by !== a.userId) await tx((t) => auditLog(t, a, 'document.viewed', 'document', id, null));
    return { url: await storage().signedUrl(d.storage_key, 5), expiresInMinutes: 5 };
  }

  @Public() @Get('files/signed')
  async signed(@Query('key') key: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) {
    if (!verifyLocalSignature(key, Number(exp), sig)) throw new BizError('NOT_FOUND', 'Enlace vencido o inválido', 404);
    const d = await db.one(`SELECT content_type FROM documents WHERE storage_key = $1`, [key]);
    res.setHeader('Cache-Control', 'private, no-store');
    res.type(d.content_type).send(await storage().read(key));
  }
}
