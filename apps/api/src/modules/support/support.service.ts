import { db, tx } from '../../db/db';
import { AuthCtx, branchAccess, opsCityScope } from '../../common/auth';
import { BizError } from '../../common/errors';
import { audit, emit } from '../../common/audit';
import { addBusinessDays, LIMA } from '../../common/time';
import { localDate, isAdultOn } from '@aquisito/contracts';
import { emailProvider } from '../../providers/messaging';

/** Acceso a la conversación/incidencias de un pedido: comprador, comercio, repartidor asignado o staff de la ciudad. */
async function orderParticipant(a: AuthCtx, orderId: string): Promise<{ role: string; order: any }> {
  const o = await db.maybe(`SELECT * FROM orders WHERE id = $1`, [orderId]);
  if (!o) throw new BizError('NOT_FOUND', 'Pedido no encontrado', 404);
  if (o.user_id === a.userId) return { role: 'customer', order: o };
  const courier = await db.maybe(`SELECT 1 FROM deliveries WHERE order_id = $1 AND courier_id = $2 AND status = 'active'`, [orderId, a.userId]);
  if (courier) return { role: 'courier', order: o };
  const scope = opsCityScope(a, ['admin', 'support_agent', 'city_dispatcher']);
  if (a.memberships.some((m) => ['admin', 'support_agent', 'city_dispatcher'].includes(m.role)) && (scope === null || scope.includes(o.city_id))) return { role: 'support', order: o };
  try {
    await branchAccess(a, o.branch_id);
    return { role: 'merchant', order: o };
  } catch {
    throw new BizError('NOT_FOUND', 'Pedido no encontrado', 404);
  }
}

export async function messages(a: AuthCtx, orderId: string) {
  await orderParticipant(a, orderId);
  return db.q(`SELECT id, sender_role, body, created_at, sender_user_id = $2 AS mine FROM order_messages WHERE order_id = $1 ORDER BY created_at`, [orderId, a.userId]);
}

export async function sendMessage(a: AuthCtx, orderId: string, body: string) {
  const { role } = await orderParticipant(a, orderId);
  return tx(async (t) => {
    const m = await t.one(`INSERT INTO order_messages(order_id, sender_user_id, sender_role, body) VALUES ($1,$2,$3,$4) RETURNING id, created_at`, [orderId, a.userId, role, body]);
    await emit(t, 'order.message', orderId, { orderId, senderRole: role });
    return m;
  });
}

export async function reportIncident(a: AuthCtx, orderId: string, input: { kind: string; description: string; evidenceFileIds: string[] }) {
  const { role, order } = await orderParticipant(a, orderId);
  if (input.evidenceFileIds.length) {
    const docs = await db.q(`SELECT id FROM documents WHERE id = ANY($1) AND uploaded_by = $2`, [input.evidenceFileIds, a.userId]);
    if (docs.length !== input.evidenceFileIds.length) throw new BizError('INVALID_EVIDENCE', 'Evidencia no válida', 422);
  }
  return tx(async (t) => {
    const i = await t.one(
      `INSERT INTO incidents(order_id, reporter_user_id, reporter_role, kind, description, evidence_document_ids) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, status, created_at`,
      [order.id, a.userId, role, input.kind, input.description, input.evidenceFileIds],
    );
    await emit(t, 'incident.created', order.id, { orderId: order.id, kind: input.kind });
    return i;
  });
}

export async function rate(a: AuthCtx, orderId: string, input: { storeScore: number; courierScore?: number; comment?: string }) {
  const o = await db.maybe(`SELECT commercial_status FROM orders WHERE id = $1 AND user_id = $2`, [orderId, a.userId]);
  if (!o) throw new BizError('NOT_FOUND', 'Pedido no encontrado', 404);
  if (o.commercial_status !== 'completado') throw new BizError('RATING_NOT_ALLOWED', 'Solo se valoran pedidos completados', 409);
  try {
    await db.q(`INSERT INTO ratings(order_id, user_id, store_score, courier_score, comment) VALUES ($1,$2,$3,$4,$5)`, [orderId, a.userId, input.storeScore, input.courierScore ?? null, input.comment ?? null]);
  } catch (e: any) {
    if (e?.code === '23505') throw new BizError('ALREADY_RATED', 'Ya valoraste este pedido', 409);
    throw e;
  }
  return { rated: true };
}

// ---------- Verificación de edad (cliente) ----------
export async function requestAgeVerification(a: AuthCtx, input: { documentType: string; documentLast4: string; fullNameOnDocument: string; birthDate: string }) {
  if (!isAdultOn(input.birthDate, localDate(new Date(), LIMA), 18)) {
    // No se crea solicitud aprobable para menores; se registra el rechazo.
    await db.q(
      `INSERT INTO age_verifications(user_id, status, document_type, document_last4, full_name_on_document, birth_date, method, policy_version, decision_reason, decided_at)
       VALUES ($1,'rejected',$2,$3,$4,$5,'system','politica-edad-0.1','Menor de 18 años según la fecha indicada', now())`,
      [a.userId, input.documentType, input.documentLast4, input.fullNameOnDocument, input.birthDate],
    );
    throw new BizError('UNDERAGE', 'Debes tener 18 años cumplidos', 422);
  }
  try {
    const r = await db.one(
      `INSERT INTO age_verifications(user_id, status, document_type, document_last4, full_name_on_document, birth_date, policy_version) VALUES ($1,'pending',$2,$3,$4,$5,'politica-edad-0.1') RETURNING id, status, created_at`,
      [a.userId, input.documentType, input.documentLast4, input.fullNameOnDocument, input.birthDate],
    );
    await db.q(`INSERT INTO consents(user_id, purpose, granted, policy_version) VALUES ($1,'age_verification',true,'politica-edad-0.1')`, [a.userId]);
    return { ...r, note: 'Tu solicitud será revisada por una persona del equipo según el procedimiento documentado. No se conecta con RENIEC ni se guarda foto de tu documento.' };
  } catch (e: any) {
    if (e?.code === '23505') throw new BizError('ALREADY_PENDING', 'Ya tienes una solicitud pendiente', 409);
    throw e;
  }
}

export async function myAgeVerification(a: AuthCtx) {
  const v = await db.maybe(`SELECT status, method, decided_at, decision_reason, created_at FROM age_verifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [a.userId]);
  return v ?? { status: 'none' };
}

// ---------- Repartidor: postulación ----------
export async function courierApply(a: AuthCtx, input: { cityId: string; birthDate: string; vehicleType: string; vehiclePlate?: string }) {
  if (!isAdultOn(input.birthDate, localDate(new Date(), LIMA), 18)) throw new BizError('UNDERAGE', 'Debes tener 18 años cumplidos para repartir', 422);
  if (['moto', 'mototaxi', 'auto'].includes(input.vehicleType) && !input.vehiclePlate) throw new BizError('PLATE_REQUIRED', 'Indica la placa del vehículo', 422);
  return tx(async (t) => {
    const exists = await t.maybe(`SELECT status FROM couriers WHERE user_id = $1`, [a.userId]);
    if (exists) throw new BizError('ALREADY_APPLIED', 'Ya enviaste tu postulación', 409);
    await t.q(`INSERT INTO couriers(user_id, city_id, birth_date, vehicle_type, vehicle_plate, terms_accepted_at) VALUES ($1,$2,$3,$4,$5, now())`, [a.userId, input.cityId, input.birthDate, input.vehicleType, input.vehiclePlate ?? null]);
    await t.q(`INSERT INTO memberships(user_id, role, city_id) VALUES ($1,'courier',$2) ON CONFLICT DO NOTHING`, [a.userId, input.cityId]);
    await t.q(`INSERT INTO consents(user_id, purpose, granted, policy_version) VALUES ($1,'courier_terms',true,'borrador-0.1'),($1,'location_tracking',true,'borrador-0.1')`, [a.userId]);
    return { status: 'pending', note: 'Tu identidad, vehículo y documentos se revisan manualmente. La activación requiere aprobación administrativa.' };
  });
}

export async function courierMe(a: AuthCtx) {
  const c = await db.maybe(`SELECT c.*, ci.name AS city_name FROM couriers c JOIN cities ci ON ci.id = c.city_id WHERE user_id = $1`, [a.userId]);
  if (!c) throw new BizError('NOT_FOUND', 'Sin perfil de repartidor', 404);
  return { status: c.status, cityId: c.city_id, cityName: c.city_name, vehicleType: c.vehicle_type, available: c.available, alcoholTrained: !!c.alcohol_training_at, identityReview: c.identity_review };
}

// ---------- Libro de Reclamaciones ----------
export async function createComplaint(a: AuthCtx | null, input: any) {
  if (input.orderId && a) {
    const o = await db.maybe(`SELECT 1 FROM orders WHERE id = $1 AND user_id = $2`, [input.orderId, a.userId]);
    if (!o) throw new BizError('NOT_FOUND', 'Pedido no encontrado', 404);
  } else if (input.orderId && !a) input.orderId = undefined;
  if (input.isMinor && !input.guardianName) throw new BizError('GUARDIAN_REQUIRED', 'Si eres menor de edad, indica los datos de tu padre, madre o apoderado', 422);
  // Plazo configurable: Indecopi indica 15 días hábiles improrrogables (verificar vigencia).
  const due = await addBusinessDays(new Date(), 15);
  const c = await tx(async (t) => {
    const year = Number(localDate(new Date(), LIMA).slice(0, 4));
    const seq = await t.one(
      `INSERT INTO complaint_counters(year, last_seq) VALUES ($1, 1) ON CONFLICT (year) DO UPDATE SET last_seq = complaint_counters.last_seq + 1 RETURNING last_seq`,
      [year],
    );
    const number = `${year}-${String(seq.last_seq).padStart(6, '0')}`;
    const r = await t.one(
      `INSERT INTO complaints(year, seq, number, consumer_name, consumer_doc_type, consumer_doc_number, consumer_email, consumer_phone, consumer_address, is_minor, guardian_name, kind, good_type, order_id, amount_cents, detail, request, due_date, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [year, seq.last_seq, number, input.consumerName, input.consumerDocType, input.consumerDocNumber, input.consumerEmail, input.consumerPhone ?? null, input.consumerAddress ?? null, input.isMinor, input.guardianName ?? null, input.kind, input.goodType, input.orderId ?? null, input.amountCents ?? null, input.detail, input.request, localDate(due, LIMA), a?.userId ?? null],
    );
    await emit(t, 'complaint.created', null, { complaintId: r.id });
    return r;
  });
  const copy = complaintCopy(c);
  const mail = emailProvider();
  if (mail) await mail.send(c.consumer_email, `Constancia de ${c.kind} N.° ${c.number}`, copy.text);
  return { ...copy, emailSent: !!mail && mail.name !== 'console', emailSimulated: mail?.name === 'console' };
}

function complaintCopy(c: any) {
  const text = [
    `LIBRO DE RECLAMACIONES VIRTUAL · Aquisito (nombre provisional; datos del proveedor por completar)`,
    `Hoja N.° ${c.number} · Fecha de registro: ${new Date(c.created_at).toLocaleString('es-PE', { timeZone: LIMA })}`,
    `Consumidor: ${c.consumer_name} · ${c.consumer_doc_type.toUpperCase()} ${c.consumer_doc_number}`,
    `Tipo: ${c.kind.toUpperCase()} · Bien contratado: ${c.good_type}${c.amount_cents ? ` · Monto: S/ ${(c.amount_cents / 100).toFixed(2)}` : ''}`,
    `Detalle: ${c.detail}`,
    `Pedido del consumidor: ${c.request}`,
    `Fecha máxima de respuesta: ${c.due_date} (15 días hábiles; plazo a verificar con la normativa vigente)`,
    c.response ? `Respuesta (${new Date(c.responded_at).toLocaleDateString('es-PE', { timeZone: LIMA })}): ${c.response}` : 'Respuesta: pendiente',
  ].join('\n');
  return { number: c.number, kind: c.kind, createdAt: c.created_at, dueDate: c.due_date, status: c.response ? 'responded' : 'pending', response: c.response, text };
}

export async function getComplaint(number: string, email: string) {
  const c = await db.maybe(`SELECT * FROM complaints WHERE number = $1 AND consumer_email = $2`, [number, email ?? '']);
  if (!c) throw new BizError('NOT_FOUND', 'Reclamación no encontrada', 404);
  return complaintCopy(c);
}

export const listComplaints = () => db.q(`SELECT id, number, kind, consumer_name, created_at, due_date, responded_at, (response IS NOT NULL) AS responded FROM complaints ORDER BY (response IS NULL) DESC, due_date`);

export async function respondComplaint(a: AuthCtx, id: string, response: string) {
  return tx(async (t) => {
    const c = await t.maybe(`SELECT * FROM complaints WHERE id = $1 FOR UPDATE`, [id]);
    if (!c) throw new BizError('NOT_FOUND', 'Reclamación no encontrada', 404);
    if (c.response) throw new BizError('ALREADY_RESPONDED', 'Ya fue respondida', 409);
    const r = await t.one(`UPDATE complaints SET response = $2, responded_at = now(), responded_by = $3 WHERE id = $1 RETURNING *`, [id, response, a.userId]);
    await audit(t, a, 'complaint.responded', 'complaint', id, null);
    return complaintCopy(r);
  });
}
