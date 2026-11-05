import { db, tx } from '../../db/db';
import { AuthCtx, branchAccess } from '../../common/auth';
import { BizError } from '../../common/errors';
import { audit, emit } from '../../common/audit';
import { randomToken } from '../../common/crypto';
import { LIMA } from '../../common/time';
import { localDate } from '@aquisito/contracts';
import { sniffContentType, storage } from '../../providers/storage';

export const DOCUMENT_KINDS = {
  merchant: ['ruc', 'licencia_funcionamiento', 'representante_legal', 'cuenta_liquidacion', 'otro'],
  branch: ['licencia_funcionamiento', 'autorizacion_alcohol', 'certificado_defensa_civil', 'otro'],
  courier: ['documento_identidad', 'licencia_conducir', 'soat', 'tarjeta_propiedad', 'otro'],
  incident: ['evidencia'],
} as const;
export type OwnerType = keyof typeof DOCUMENT_KINDS;

/**
 * Comprueba que quien sube puede adjuntar documentos a ese titular. Sin esta verificación un
 * usuario podría asociar archivos a comercios, repartidores o pedidos ajenos.
 */
async function assertOwnership(a: AuthCtx, ownerType: OwnerType, ownerId: string) {
  if (ownerType === 'courier') {
    if (ownerId !== a.userId) throw new BizError('NOT_FOUND', 'Titular no encontrado', 404);
    const c = await db.maybe(`SELECT 1 FROM couriers WHERE user_id = $1`, [a.userId]);
    if (!c) throw new BizError('NOT_COURIER', 'Primero envía tu postulación de repartidor', 409);
    return;
  }
  if (ownerType === 'merchant') {
    if (!a.memberships.some((m) => m.role === 'merchant_owner' && m.merchant_id === ownerId)) throw new BizError('NOT_FOUND', 'Titular no encontrado', 404);
    return;
  }
  if (ownerType === 'branch') {
    const { isOwner } = await branchAccess(a, ownerId);
    if (!isOwner) throw new BizError('FORBIDDEN', 'Solo el propietario sube documentos de la sucursal', 403);
    return;
  }
  // incident: evidencia de un pedido propio (cliente), de una entrega asignada o de su sucursal.
  const o = await db.maybe(`SELECT user_id, branch_id FROM orders WHERE id = $1`, [ownerId]);
  if (!o) throw new BizError('NOT_FOUND', 'Pedido no encontrado', 404);
  if (o.user_id === a.userId) return;
  if (await db.maybe(`SELECT 1 FROM deliveries WHERE order_id = $1 AND courier_id = $2`, [ownerId, a.userId])) return;
  await branchAccess(a, o.branch_id);
}

export async function upload(a: AuthCtx, input: { ownerType: string; ownerId?: string; kind?: string; contentBase64: string; expiresAt?: string }) {
  const ownerType = input.ownerType as OwnerType;
  if (!(ownerType in DOCUMENT_KINDS)) throw new BizError('VALIDATION', 'Tipo de titular inválido', 400);
  const ownerId = input.ownerId ?? (ownerType === 'courier' ? a.userId : '');
  if (!/^[0-9a-f-]{36}$/.test(ownerId)) throw new BizError('VALIDATION', 'Titular requerido', 400);
  const kind = input.kind ?? (ownerType === 'incident' ? 'evidencia' : '');
  if (!(DOCUMENT_KINDS[ownerType] as readonly string[]).includes(kind)) throw new BizError('VALIDATION', 'Tipo de documento inválido', 400);
  if (input.expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(input.expiresAt)) throw new BizError('VALIDATION', 'Fecha de vencimiento inválida', 400);
  await assertOwnership(a, ownerType, ownerId);
  if (typeof input.contentBase64 !== 'string') throw new BizError('VALIDATION', 'Archivo requerido', 400);
  const buf = Buffer.from(input.contentBase64, 'base64');
  if (buf.length === 0 || buf.length > 5 * 1024 * 1024) throw new BizError('FILE_SIZE', 'Archivo vacío o mayor a 5 MB', 413);
  const type = sniffContentType(buf);
  if (!type) throw new BizError('FILE_TYPE', 'Solo JPG, PNG, WEBP o PDF', 415);
  const key = `${ownerType}/${ownerId}/${randomToken(12)}`;
  await storage().put(key, buf, type);
  const d = await db.one(
    `INSERT INTO documents(owner_type, owner_id, kind, storage_key, content_type, size_bytes, uploaded_by, expires_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, status`,
    [ownerType, ownerId, kind, key, type, buf.length, a.userId, input.expiresAt ?? null, ownerType === 'incident' ? 'approved' : 'pending'],
  );
  return { id: d.id, status: d.status, contentType: type, size: buf.length };
}

const dto = (d: any) => ({ id: d.id, ownerType: d.owner_type, ownerId: d.owner_id, kind: d.kind, status: d.status, expiresAt: d.expires_at, reviewReason: d.review_reason, createdAt: d.created_at, contentType: d.content_type });

export async function listFor(a: AuthCtx, ownerType: 'branch' | 'courier', ownerId: string) {
  if (ownerType === 'branch') {
    const { merchantId } = await branchAccess(a, ownerId);
    const rows = await db.q(`SELECT * FROM documents WHERE (owner_type = 'branch' AND owner_id = $1) OR (owner_type = 'merchant' AND owner_id = $2) ORDER BY created_at DESC`, [ownerId, merchantId]);
    return rows.map(dto);
  }
  return (await db.q(`SELECT * FROM documents WHERE owner_type = 'courier' AND owner_id = $1 ORDER BY created_at DESC`, [a.userId])).map(dto);
}

export async function reviewQueue() {
  const rows = await db.q(
    `SELECT d.*, coalesce(m.trade_name, b.name, u.full_name) AS owner_name FROM documents d
     LEFT JOIN merchants m ON d.owner_type = 'merchant' AND m.id = d.owner_id
     LEFT JOIN branches b ON d.owner_type = 'branch' AND b.id = d.owner_id
     LEFT JOIN users u ON d.owner_type = 'courier' AND u.id = d.owner_id
     WHERE d.owner_type <> 'incident' ORDER BY (d.status = 'pending') DESC, d.created_at DESC LIMIT 200`,
  );
  return rows.map((r) => ({ ...dto(r), ownerName: r.owner_name }));
}

export async function review(a: AuthCtx, id: string, input: { approve: boolean; reason: string; expiresAt?: string }) {
  return tx(async (t) => {
    const d = await t.maybe(`SELECT * FROM documents WHERE id = $1 FOR UPDATE`, [id]);
    if (!d || d.owner_type === 'incident') throw new BizError('NOT_FOUND', 'Documento no encontrado', 404);
    const expires = input.expiresAt ?? d.expires_at;
    if (input.approve && expires && expires < localDate(new Date(), LIMA)) throw new BizError('DOCUMENT_EXPIRED', 'El documento ya está vencido', 422);
    await t.q(`UPDATE documents SET status = $2, review_reason = $3, reviewed_by = $4, reviewed_at = now(), expires_at = $5 WHERE id = $1`, [id, input.approve ? 'approved' : 'rejected', input.reason, a.userId, expires]);
    await audit(t, a, input.approve ? 'document.approved' : 'document.rejected', 'document', id, input.reason, { kind: d.kind, ownerType: d.owner_type });
    // Revisión manual: no constituye validación oficial ante la entidad emisora.
    return { status: input.approve ? 'approved' : 'rejected', expiresAt: expires };
  });
}

/** Documento vigente de autorización para alcohol de la sucursal (requisito para habilitarla). */
export async function validAlcoholPermitDocument(t: { maybe: typeof db.maybe }, branchId: string) {
  return t.maybe(
    `SELECT id, expires_at FROM documents WHERE owner_type = 'branch' AND owner_id = $1 AND kind = 'autorizacion_alcohol' AND status = 'approved'
       AND (expires_at IS NULL OR expires_at >= (now() AT TIME ZONE 'America/Lima')::date) ORDER BY expires_at DESC NULLS FIRST LIMIT 1`,
    [branchId],
  );
}

/**
 * Job diario: marca documentos vencidos y suspende la habilitación de alcohol de sucursales cuyo
 * permiso venció o ya no tiene documento vigente. Queda en auditoría.
 */
export async function expireDocuments(): Promise<{ documents: number; permits: number }> {
  return tx(async (t) => {
    const docs = await t.q(
      `UPDATE documents SET status = 'expired' WHERE status = 'approved' AND expires_at IS NOT NULL AND expires_at < (now() AT TIME ZONE 'America/Lima')::date RETURNING id, owner_type, owner_id, kind`,
    );
    const permits = await t.q(
      `UPDATE branches b SET alcohol_permit_status = 'expired'
       WHERE alcohol_permit_status = 'approved' AND (
         (alcohol_permit_expires_at IS NOT NULL AND alcohol_permit_expires_at < (now() AT TIME ZONE 'America/Lima')::date)
         OR EXISTS (SELECT 1 FROM documents d WHERE d.owner_type = 'branch' AND d.owner_id = b.id AND d.kind = 'autorizacion_alcohol' AND d.status = 'expired')
           AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.owner_type = 'branch' AND d.owner_id = b.id AND d.kind = 'autorizacion_alcohol' AND d.status = 'approved'))
       RETURNING id`,
    );
    for (const d of docs) await audit(t, null, 'document.expired', 'document', d.id, 'Vencimiento automático', { kind: d.kind });
    for (const b of permits) {
      await audit(t, null, 'branch.alcohol_permit_expired', 'branch', b.id, 'Permiso o documento de alcohol vencido');
      await emit(t, 'branch.alcohol_permit_expired', null, { branchId: b.id });
    }
    return { documents: docs.length, permits: permits.length };
  });
}
