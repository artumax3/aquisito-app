'use client';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useState } from 'react';
import type { CityDto } from '@aquisito/contracts';
import { api, errorMessage, prefs, useQuery } from '@/lib/api';
import { ActionButton, ErrorBox, Loading, useSession } from '@/components/ui';

const MapView = dynamic(() => import('@/components/map').then((m) => m.MapView), { ssr: false });

export default function AccountPage() {
  const { me, loading, refresh } = useSession();
  if (loading) return <Loading />;
  return me ? <Profile refresh={refresh} /> : <Auth onDone={refresh} />;
}

function Auth({ onDone }: { onDone: () => Promise<void> }) {
  const [mode, setMode] = useState<'login' | 'register' | 'otp'>('login');
  const [f, setF] = useState({ email: '', password: '', fullName: '', phone: '+51', code: '' });
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [otpSent, setOtpSent] = useState(false);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      if (mode === 'login') await api.call('login', { body: { email: f.email, password: f.password, deviceLabel: 'Navegador web' } });
      else if (mode === 'register') await api.call('register', { body: { email: f.email, password: f.password, fullName: f.fullName } });
      else if (!otpSent) {
        const r = await api.call('otpRequest', { body: { phone: f.phone } });
        setOtpSent(true);
        setInfo(r.simulated ? 'Entorno de desarrollo: el SMS no se envía; el código queda en storage/dev-outbox/sms.log del servidor.' : 'Te enviamos un código por SMS.');
        return;
      } else await api.call('otpVerify', { body: { phone: f.phone, code: f.code, fullName: f.fullName || undefined, deviceLabel: 'Navegador web' } });
      await onDone();
    } catch (e2) {
      setErr(errorMessage(e2));
    }
  }
  return (
    <section className="col" style={{ marginTop: 16, maxWidth: 440 }}>
      <h1>{mode === 'register' ? 'Crear cuenta' : 'Ingresar'}</h1>
      <div className="tabs">
        <button className={`chip light ${mode === 'login' ? 'active' : ''}`} onClick={() => setMode('login')}>Correo</button>
        <button className={`chip light ${mode === 'otp' ? 'active' : ''}`} onClick={() => setMode('otp')}>Teléfono (SMS)</button>
        <button className={`chip light ${mode === 'register' ? 'active' : ''}`} onClick={() => setMode('register')}>Crear cuenta</button>
      </div>
      <form className="card col" onSubmit={submit}>
        {mode !== 'otp' && <label>Correo<input type="email" autoComplete="email" required value={f.email} onChange={set('email')} /></label>}
        {mode !== 'otp' && <label>Contraseña<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'register' ? 10 : 1} value={f.password} onChange={set('password')} /></label>}
        {mode === 'register' && <label>Nombre completo<input required value={f.fullName} onChange={set('fullName')} /></label>}
        {mode === 'otp' && <label>Teléfono<input inputMode="tel" value={f.phone} onChange={set('phone')} /></label>}
        {mode === 'otp' && otpSent && <label>Código de 6 dígitos<input inputMode="numeric" value={f.code} onChange={set('code')} /></label>}
        {mode === 'otp' && otpSent && <label>Nombre (solo si es tu primera vez)<input value={f.fullName} onChange={set('fullName')} /></label>}
        {err && <div className="alert error">{err}</div>}
        {info && <div className="alert info small">{info}</div>}
        <button className="btn">{mode === 'otp' && !otpSent ? 'Enviar código' : 'Continuar'}</button>
        {mode === 'register' && <p className="muted small">Al crear tu cuenta aceptas los <Link href="/legal">términos y la política de privacidad (borradores en revisión)</Link>.</p>}
      </form>
    </section>
  );
}

function Profile({ refresh }: { refresh: () => Promise<void> }) {
  const { me } = useSession();
  const cities = useQuery<CityDto[]>('cities');
  const addresses = useQuery<any[]>('addresses');
  const sessions = useQuery<any[]>('sessions');
  const consents = useQuery<any[]>('consents');
  const notifs = useQuery<any[]>('notifications');
  const age = useQuery<any>('myAgeVerification');
  const dataReqs = useQuery<any[]>('dataRequests');
  const favs = useQuery<any[]>('favorites');
  const [mfa, setMfa] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!me) return null;
  const staffSensitive = me.memberships.some((m) => ['admin', 'finance'].includes(m.role));

  return (
    <section className="col" style={{ marginTop: 12 }}>
      <h1>Hola, {me.fullName}</h1>
      <span className="muted">{me.email ?? me.phone} {me.isDemo && <span className="badge warn">cuenta de demostración</span>}</span>
      {err && <div className="alert error">{err}</div>}

      {(staffSensitive || me.mfaEnabled) && (
        <div className="card col">
          <h2>Verificación en dos pasos</h2>
          {me.mfaVerified ? <span className="alert ok">Sesión verificada con TOTP.</span> : (
            <>
              {!me.mfaEnabled && !mfa && <ActionButton onClick={async () => setMfa(await api.call('mfaSetup'))}>Configurar app autenticadora</ActionButton>}
              {mfa && <div className="alert info small">Agrega este secreto en tu app autenticadora: <code>{mfa.secret}</code></div>}
              <div className="row">
                <input inputMode="numeric" placeholder="Código de 6 dígitos" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} style={{ maxWidth: 180 }} />
                <ActionButton onClick={async () => { await api.call('mfaVerify', { body: { code: mfaCode } }); await refresh(); }}>Verificar</ActionButton>
              </div>
              <span className="muted small">Requerido para operaciones de administración y finanzas.</span>
            </>
          )}
        </div>
      )}

      <AddressBook cities={cities.data ?? []} addresses={addresses} />

      <div className="card col">
        <h2>Mayoría de edad</h2>
        <p className="muted small">Necesaria solo para ver y comprar bebidas alcohólicas. Una fecha declarada no habilita la compra: una persona del equipo revisa tu solicitud. No nos conectamos con RENIEC y no guardamos foto de tu documento.</p>
        <span>Estado: <strong>{({ none: 'Sin verificar', declared: 'Edad declarada (no verificada)', pending: 'Verificación pendiente', verified: 'Verificada', rejected: 'Rechazada', revoked: 'Revocada (requiere nueva revisión)' } as any)[me.ageStatus]}</strong></span>
        {['none', 'declared', 'rejected', 'revoked'].includes(me.ageStatus) && <AgeForm onDone={async () => { await refresh(); age.reload(); }} />}
      </div>

      <div className="card col">
        <h2>Favoritos</h2>
        {(favs.data ?? []).length ? favs.data!.map((f) => <div key={f.branch_id} className="row"><Link href={`/tienda/${f.branch_id}`}>{f.name}</Link><button className="btn sm ghost" onClick={async () => { await api.call('removeFavorite', { params: { branchId: f.branch_id } }); favs.reload(); }}>Quitar</button></div>) : <span className="muted">Aún no tienes favoritos.</span>}
      </div>

      <div className="card col">
        <h2>Notificaciones</h2>
        {(notifs.data ?? []).slice(0, 10).map((n) => (
          <div key={n.id} className="row small" style={{ justifyContent: 'space-between' }}>
            <span>{n.read_at ? '' : '● '}<strong>{n.title}</strong> — {n.body}</span>
            {!n.read_at && <button className="btn sm ghost" onClick={async () => { await api.call('readNotification', { params: { id: n.id } }); notifs.reload(); }}>Marcar leída</button>}
          </div>
        ))}
        {!notifs.data?.length && <span className="muted">Sin notificaciones.</span>}
      </div>

      <div className="card col">
        <h2>Privacidad y consentimientos</h2>
        {[['marketing', 'Recibir promociones'], ['marketing_alcohol', 'Promociones de bebidas alcohólicas (solo adultos verificados)'], ['location_tracking', 'Usar mi ubicación para sugerir ciudad']].map(([p, l]) => {
          const cur = consents.data?.find((c) => c.purpose === p);
          return (
            <label key={p} className="check">
              <input type="checkbox" checked={!!cur?.granted} onChange={async (e) => { try { await api.call('setConsent', { body: { purpose: p as any, granted: e.target.checked, policyVersion: 'borrador-0.1' } }); consents.reload(); } catch (x) { setErr(errorMessage(x)); } }} /> {l}
            </label>
          );
        })}
        <h3>Derechos sobre tus datos (Ley N.° 29733)</h3>
        <div className="row">
          {[['access', 'Acceso'], ['rectification', 'Rectificación'], ['opposition', 'Oposición'], ['account_deletion', 'Eliminar mi cuenta']].map(([k, l]) => (
            <ActionButton key={k} className="sm ghost" confirm={k === 'account_deletion' ? 'Se anonimizarán tus datos personales. Pedidos y movimientos se conservan por obligaciones legales. ¿Continuar?' : undefined} onClick={async () => { await api.call('dataRequest', { body: { kind: k as any } }); dataReqs.reload(); }}>{l}</ActionButton>
          ))}
        </div>
        {(dataReqs.data ?? []).map((d) => <span key={d.id} className="small muted">{d.kind}: {d.status} · respuesta hasta {new Date(d.due_at).toLocaleDateString('es-PE')}</span>)}
      </div>

      <div className="card col">
        <h2>Sesiones y dispositivos</h2>
        {(sessions.data ?? []).map((s) => (
          <div key={s.id} className="row small" style={{ justifyContent: 'space-between' }}>
            <span>{s.deviceLabel ?? 'Dispositivo'} {s.current && <span className="badge">actual</span>} · último uso {new Date(s.lastSeenAt).toLocaleString('es-PE', { timeZone: 'America/Lima' })}</span>
            {!s.current && <button className="btn sm ghost" onClick={async () => { await api.call('revokeSession', { params: { id: s.id } }); sessions.reload(); }}>Revocar</button>}
          </div>
        ))}
        <ActionButton className="ghost" onClick={async () => { await api.call('logout'); await refresh(); }}>Cerrar sesión</ActionButton>
      </div>
      <div className="row small">
        <Link href="/reclamaciones">Libro de Reclamaciones</Link>
        <Link href="/legal">Términos y privacidad (borradores)</Link>
        <Link href="/comercio/alta">¿Tienes un negocio? Regístralo</Link>
        <Link href="/repartidor/postular">Quiero repartir</Link>
      </div>
    </section>
  );
}

function AgeForm({ onDone }: { onDone: () => Promise<void> }) {
  const [f, setF] = useState({ documentType: 'dni', documentLast4: '', fullNameOnDocument: '', birthDate: '', consent: false });
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="col" onSubmit={async (e) => { e.preventDefault(); try { await api.call('requestAgeVerification', { body: { ...f, consent: true, documentType: f.documentType as any } }); await onDone(); } catch (x) { setErr(errorMessage(x)); } }}>
      <select value={f.documentType} onChange={(e) => setF({ ...f, documentType: e.target.value })}>
        <option value="dni">DNI</option><option value="carne_extranjeria">Carné de extranjería</option><option value="pasaporte">Pasaporte</option>
      </select>
      <input placeholder="Últimos 4 caracteres del documento" maxLength={4} value={f.documentLast4} onChange={(e) => setF({ ...f, documentLast4: e.target.value.toUpperCase() })} />
      <input placeholder="Nombre tal como figura en el documento" value={f.fullNameOnDocument} onChange={(e) => setF({ ...f, fullNameOnDocument: e.target.value })} />
      <label>Fecha de nacimiento<input type="date" value={f.birthDate} onChange={(e) => setF({ ...f, birthDate: e.target.value })} /></label>
      <label className="check"><input type="checkbox" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} /> Autorizo el tratamiento de estos datos solo para verificar mi mayoría de edad (política borrador 0.1).</label>
      {err && <div className="alert error">{err}</div>}
      <button className="btn" disabled={!f.consent}>Solicitar verificación</button>
    </form>
  );
}

function AddressBook({ cities, addresses }: { cities: CityDto[]; addresses: ReturnType<typeof useQuery<any[]>> }) {
  const [cityId, setCityId] = useState(prefs.get('city') ?? '');
  const city = cities.find((c) => c.id === cityId);
  const [pt, setPt] = useState<{ lat: number; lng: number } | null>(null);
  const [f, setF] = useState({ label: 'Casa', line1: '', number: '', reference: '', instructions: '' });
  const [res, setRes] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  return (
    <div className="card col" id="direcciones">
      <h2>Direcciones</h2>
      {addresses.error ? <ErrorBox error={addresses.error} /> : null}
      {(addresses.data ?? []).map((a) => (
        <div key={a.id} className="row small" style={{ justifyContent: 'space-between' }}>
          <span><strong>{a.label}</strong> · {a.line1} {a.number ?? ''} · {cities.find((c) => c.id === a.cityId)?.name} {a.inCoverage ? <span className="badge">en cobertura</span> : <span className="badge warn">fuera de cobertura</span>}</span>
          <button className="btn sm ghost" onClick={async () => { await api.call('deleteAddress', { params: { id: a.id } }); addresses.reload(); }}>Eliminar</button>
        </div>
      ))}
      <details>
        <summary><strong>Agregar dirección</strong></summary>
        <div className="col">
          <select value={cityId} onChange={(e) => { setCityId(e.target.value); setPt(null); setConfirmed(false); }}>
            <option value="">Ciudad</option>
            {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input placeholder="Etiqueta (Casa, Trabajo)" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
          <input placeholder="Calle / jirón / avenida" value={f.line1} onChange={(e) => setF({ ...f, line1: e.target.value })} />
          <input placeholder="Número (si existe)" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} />
          <input placeholder="Referencia (frente a…, color de la puerta)" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
          <input placeholder="Instrucciones de acceso" value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} />
          {city && (
            <>
              <span className="muted small">Toca el mapa para marcar el punto exacto de entrega. La dirección escrita por sí sola no garantiza precisión.</span>
              <MapView center={city.center} pick={pt} onPick={(p) => { setPt(p); setConfirmed(false); }} />
              {pt && <label className="check"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> Confirmo que el punto marcado es el lugar de entrega</label>}
            </>
          )}
          <ActionButton disabled={!city || !pt || !confirmed || f.line1.length < 3} onClick={async () => {
            const r = await api.call('addAddress', { body: { cityId, ...f, number: f.number || undefined, reference: f.reference || undefined, instructions: f.instructions || undefined, lat: pt!.lat, lng: pt!.lng, pointConfirmed: true } });
            setRes(r.inCoverage ? `Dirección guardada (${r.zoneName}).` : `Dirección guardada, pero está fuera de cobertura: ${r.coverageMessage}`);
            setPt(null);
            setConfirmed(false);
            addresses.reload();
          }}>Guardar dirección</ActionButton>
          {res && <div className="alert info small">{res}</div>}
        </div>
      </details>
    </div>
  );
}
