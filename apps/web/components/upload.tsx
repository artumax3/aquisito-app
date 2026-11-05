'use client';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';

const KIND_LABELS: Record<string, string> = {
  ruc: 'Ficha RUC',
  licencia_funcionamiento: 'Licencia de funcionamiento',
  representante_legal: 'Vigencia de poder / representante',
  cuenta_liquidacion: 'Constancia de cuenta para liquidación',
  autorizacion_alcohol: 'Autorización para venta de alcohol',
  certificado_defensa_civil: 'Certificado de Defensa Civil / ITSE',
  documento_identidad: 'Documento de identidad',
  licencia_conducir: 'Licencia de conducir',
  soat: 'SOAT',
  tarjeta_propiedad: 'Tarjeta de propiedad del vehículo',
  otro: 'Otro',
};
export const kindLabel = (k: string) => KIND_LABELS[k] ?? k;

function toBase64(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] ?? '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
}

/** Sube un documento privado (PDF/JPG/PNG/WEBP, máx. 5 MB). La revisión es manual y no constituye validación oficial. */
export function DocumentUploader({ ownerType, ownerId, kinds, onDone }: { ownerType: 'merchant' | 'branch' | 'courier'; ownerId?: string; kinds: string[]; onDone: () => void }) {
  const [kind, setKind] = useState(kinds[0]);
  const [expires, setExpires] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="col">
      <div className="row">
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ maxWidth: 300 }} aria-label="Tipo de documento">
          {kinds.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
        </select>
        <label className="small" style={{ maxWidth: 200 }}>Vence (si aplica)<input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></label>
      </div>
      <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Archivo" />
      <button className="btn sm" disabled={!file || busy} onClick={async () => {
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) return setMsg({ ok: false, text: 'El archivo supera 5 MB' });
        setBusy(true);
        setMsg(null);
        try {
          await api.call('uploadFile', { body: { ownerType, ownerId, kind, expiresAt: expires || undefined, contentBase64: await toBase64(file) } });
          setMsg({ ok: true, text: 'Documento enviado a revisión' });
          setFile(null);
          onDone();
        } catch (e) {
          setMsg({ ok: false, text: errorMessage(e) });
        } finally {
          setBusy(false);
        }
      }}>{busy ? 'Subiendo…' : 'Subir documento'}</button>
      {msg && <span className={`alert ${msg.ok ? 'ok' : 'error'} small`}>{msg.text}</span>}
      <span className="muted small">Se guarda en almacenamiento privado; solo el personal autorizado lo ve mediante enlaces temporales.</span>
    </div>
  );
}

export function DocumentList({ docs }: { docs: any[] }) {
  if (!docs.length) return <span className="muted small">Sin documentos.</span>;
  return (
    <div className="col" style={{ gap: 4 }}>
      {docs.map((d) => (
        <div key={d.id} className="row small" style={{ justifyContent: 'space-between' }}>
          <span>{kindLabel(d.kind)} {d.expiresAt ? `· vence ${d.expiresAt}` : ''} {d.reviewReason ? `· ${d.reviewReason}` : ''}</span>
          <span className={`badge ${d.status === 'approved' ? '' : d.status === 'pending' ? 'warn' : 'danger'}`}>{{ pending: 'en revisión', approved: 'aprobado', rejected: 'rechazado', expired: 'vencido' }[d.status as string] ?? d.status}</span>
        </div>
      ))}
    </div>
  );
}
