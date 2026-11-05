'use client';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';

/** Libro de Reclamaciones virtual: accesible sin iniciar sesión, con constancia y número correlativo. */
export default function ComplaintsPage() {
  const [f, setF] = useState<any>({ consumerName: '', consumerDocType: 'dni', consumerDocNumber: '', consumerEmail: '', consumerPhone: '', consumerAddress: '', isMinor: false, guardianName: '', kind: 'reclamo', goodType: 'servicio', amount: '', detail: '', request: '' });
  const [done, setDone] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lookup, setLookup] = useState({ number: '', email: '' });
  const [found, setFound] = useState<any>(null);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      const { amount, ...rest } = f;
      const body = { ...rest, amountCents: amount ? Math.round(Number(amount) * 100) : undefined, consumerPhone: f.consumerPhone || undefined, consumerAddress: f.consumerAddress || undefined, guardianName: f.guardianName || undefined };
      setDone(await api.call('createComplaint', { body }));
    } catch (x) {
      setErr(errorMessage(x));
    }
  }

  return (
    <section className="col" style={{ marginTop: 12, maxWidth: 720 }}>
      <h1>Libro de Reclamaciones</h1>
      <p className="muted small">Reclamo: disconformidad con los productos o servicios. Queja: malestar con la atención. El plazo de respuesta configurado es de 15 días hábiles (verificar con la normativa vigente de Indecopi). Datos del proveedor (razón social, RUC, dirección) pendientes de definir por el titular del negocio.</p>
      {done ? (
        <div className="card col">
          <div className="alert ok">Registramos tu {done.kind} con el número <strong>{done.number}</strong>. Respuesta a más tardar el {done.dueDate}.</div>
          <pre style={{ whiteSpace: 'pre-wrap' }} className="small">{done.text}</pre>
          <div className="row">
            <button className="btn secondary" onClick={() => window.print()}>Imprimir / guardar constancia</button>
            {done.emailSimulated && <span className="muted small">Entorno de desarrollo: la copia por correo no se envía realmente.</span>}
          </div>
        </div>
      ) : (
        <form className="card col" onSubmit={submit}>
          <h2>1. Identificación del consumidor</h2>
          <label>Nombre completo<input required value={f.consumerName} onChange={set('consumerName')} /></label>
          <div className="row">
            <select value={f.consumerDocType} onChange={set('consumerDocType')} style={{ maxWidth: 160 }}><option value="dni">DNI</option><option value="ce">C.E.</option><option value="pasaporte">Pasaporte</option><option value="ruc">RUC</option></select>
            <input required placeholder="Número de documento" value={f.consumerDocNumber} onChange={set('consumerDocNumber')} style={{ flex: 1 }} />
          </div>
          <label>Correo (para la constancia y la respuesta)<input type="email" required value={f.consumerEmail} onChange={set('consumerEmail')} /></label>
          <label>Teléfono<input value={f.consumerPhone} onChange={set('consumerPhone')} /></label>
          <label>Domicilio<input value={f.consumerAddress} onChange={set('consumerAddress')} /></label>
          <label className="check"><input type="checkbox" checked={f.isMinor} onChange={set('isMinor')} /> Soy menor de edad</label>
          {f.isMinor && <label>Padre, madre o apoderado<input required value={f.guardianName} onChange={set('guardianName')} /></label>}
          <h2>2. Bien contratado</h2>
          <div className="row">
            <select value={f.goodType} onChange={set('goodType')} style={{ maxWidth: 200 }}><option value="servicio">Servicio</option><option value="producto">Producto</option></select>
            <input placeholder="Monto reclamado (S/, opcional)" inputMode="decimal" value={f.amount} onChange={set('amount')} />
          </div>
          <h2>3. Detalle</h2>
          <select value={f.kind} onChange={set('kind')}><option value="reclamo">Reclamo</option><option value="queja">Queja</option></select>
          <label>Detalle<textarea required minLength={10} rows={4} value={f.detail} onChange={set('detail')} /></label>
          <label>Pedido del consumidor<textarea required minLength={3} rows={2} value={f.request} onChange={set('request')} /></label>
          {err && <div className="alert error">{err}</div>}
          <button className="btn">Registrar</button>
        </form>
      )}
      <div className="card col">
        <h2>Consultar una reclamación</h2>
        <div className="row">
          <input placeholder="Número (AAAA-000001)" value={lookup.number} onChange={(e) => setLookup({ ...lookup, number: e.target.value })} />
          <input placeholder="Correo registrado" value={lookup.email} onChange={(e) => setLookup({ ...lookup, email: e.target.value })} />
          <button className="btn secondary" onClick={async () => { try { setFound(await api.call('getComplaint', { params: { number: lookup.number }, query: { email: lookup.email } })); } catch (x) { setFound({ text: errorMessage(x) }); } }}>Consultar</button>
        </div>
        {found && <pre className="small" style={{ whiteSpace: 'pre-wrap' }}>{found.text}</pre>}
      </div>
    </section>
  );
}
