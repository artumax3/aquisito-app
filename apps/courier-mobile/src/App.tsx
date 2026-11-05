import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Pressable, RefreshControl, ScrollView, Switch, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import type * as Location from 'expo-location';
import { ALCOHOL_LEGAL_NOTICES, formatPEN, LABELS } from '@aquisito/api-client';
import type { CourierDeliveryDto, MeDto, OfferDto } from '@aquisito/contracts';
import { api, tokenStore } from './api';
import { startBackground, startForeground, stopBackground } from './location';
import { Badge, Banner, Btn, C, Card, Field, H, P, s } from './ui';
import { registerPush } from './push';
import { MapWeb } from './MapWeb';

export default function App() {
  const [me, setMe] = useState<MeDto | null>(null);
  const [booting, setBooting] = useState(true);
  const refresh = useCallback(async () => {
    try {
      setMe((await tokenStore.get()) ? await api.call('me') : null);
    } catch {
      setMe(null);
    } finally {
      setBooting(false);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  if (booting) return <View style={s.screen} />;
  if (!me) return <Login onDone={refresh} />;
  return <Courier me={me} onLogout={async () => { await stopBackground(); await api.call('logout').catch(() => undefined); await tokenStore.clear(); setMe(null); }} />;
}

function Login({ onDone }: { onDone: () => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  return (
    <ScrollView style={s.screen} contentContainerStyle={[s.content, { paddingTop: 64 }]}>
      <Text style={[s.brand, { color: C.selva900, fontSize: 28 }]}>aquisito · repartidor</Text>
      <Card>
        <Field label="Correo" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
        <Field label="Contraseña" secureTextEntry value={password} onChangeText={setPassword} />
        <Btn title="Ingresar" onPress={async () => { const r = await api.call('login', { body: { email, password, deviceLabel: 'App repartidor' } }); await tokenStore.set(r.token); await onDone(); }} />
      </Card>
    </ScrollView>
  );
}

function Courier({ me, onLogout }: { me: MeDto; onLogout: () => Promise<void> }) {
  const [profile, setProfile] = useState<any>(null);
  const [offers, setOffers] = useState<OfferDto[]>([]);
  const [delivery, setDelivery] = useState<CourierDeliveryDto | null>(null);
  const [earn, setEarn] = useState<any>(null);
  const [loc, setLoc] = useState<Location.LocationObject | null>(null);
  const [locMsg, setLocMsg] = useState<string | null>(null);
  const [bgMsg, setBgMsg] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(false);
  const watcher = useRef<{ remove: () => void } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = await api.call('courierMe');
      setProfile(p);
      const d = await api.call('courierDelivery');
      setDelivery('none' in d ? null : d);
      setOffers(await api.call('courierOffers'));
      setEarn(await api.call('courierEarnings'));
      setOffline(false);
    } catch (e: any) {
      if (e?.code === 'NETWORK') setOffline(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
    const h = setInterval(load, 8000); // sondeo; la verdad siempre viene del servidor
    return () => clearInterval(h);
  }, [load]);

  useEffect(() => {
    if (!profile?.available) {
      watcher.current?.remove();
      watcher.current = null;
      return;
    }
    (async () => {
      watcher.current = await startForeground(setLoc, setLocMsg);
    })();
    return () => watcher.current?.remove();
  }, [profile?.available]);

  if (!profile) return <View style={s.content}><P>{offline ? 'Sin conexión' : 'Cargando…'}</P></View>;
  return (
    <View style={s.screen}>
      <StatusBar style="light" />
      <View style={s.header}><Text style={s.brand}>{me.fullName.split(' ')[0]} · {profile.cityName}</Text></View>
      <ScrollView contentContainerStyle={s.content} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}>
        {offline && <Banner tone="bad" text="Sin conexión. Nada se confirma hasta que el servidor lo valide; no entregues pedidos con alcohol sin conexión." />}
        {profile.status !== 'approved' && <Banner tone="warn" text={`Cuenta ${profile.status === 'pending' ? 'en revisión' : profile.status}.`} />}
        {profile.status === 'approved' && (
          <Card>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ fontWeight: '800', fontSize: 16 }}>{profile.available ? '🟢 Disponible' : '⚪ Desconectado'}</Text>
              <Switch value={profile.available} onValueChange={async (v) => { await api.call('courierAvailability', { body: { available: v } }); if (!v) await stopBackground(); load(); }} />
            </View>
            {loc && <P muted>Ubicación {new Date(loc.timestamp).toLocaleTimeString('es-PE')} ±{Math.round(loc.coords.accuracy ?? 0)} m</P>}
            {locMsg && <Banner tone="warn" text={locMsg} />}
            {profile.available && <Btn kind="secondary" title="Activar ubicación en segundo plano" onPress={async () => setBgMsg(await startBackground())} />}
            <Btn kind="secondary" title="Activar avisos de ofertas (push)" onPress={async () => setBgMsg(await registerPush())} />
            {bgMsg && <P muted>{bgMsg}</P>}
          </Card>
        )}
        {delivery ? <Active d={delivery} reload={load} /> : (
          <>
            <H>Ofertas</H>
            {!offers.length && <P muted>Sin ofertas por ahora.</P>}
            {offers.map((o) => (
              <Card key={o.id}>
                <Text style={{ fontWeight: '800' }}>{o.branchName} → {o.destinationArea}</Text>
                <P>{(o.estimatedDistanceMeters / 1000).toFixed(1)} km · pago estimado {formatPEN(o.estimatedPayCents)}</P>
                {o.containsAlcohol && <Badge tone="adult" text="Contiene alcohol: verificación presencial" />}
                {o.cashToCollectCents ? <P>Cobrar en efectivo: {formatPEN(o.cashToCollectCents)}</P> : null}
                <P muted>Vence {new Date(o.expiresAt).toLocaleTimeString('es-PE')}</P>
                <Btn title="Aceptar" onPress={async () => { await api.call('courierAcceptOffer', { params: { id: o.id } }); load(); }} />
                <Btn kind="secondary" title="Rechazar" onPress={async () => { await api.call('courierRejectOffer', { params: { id: o.id } }); load(); }} />
              </Card>
            ))}
          </>
        )}
        {earn && (
          <Card>
            <H>Ingresos</H>
            <P>Reparto {formatPEN(earn.deliveryPayCents)} · Propinas {formatPEN(earn.tipsCents)}</P>
            <P>Efectivo por rendir {formatPEN(earn.cashHeldCents)}</P>
            <P muted>{earn.note}</P>
          </Card>
        )}
        <Btn kind="danger" title="Cerrar sesión" onPress={onLogout} />
      </ScrollView>
    </View>
  );
}

function Active({ d, reload }: { d: CourierDeliveryDto; reload: () => void }) {
  const [pickup, setPickup] = useState('');
  const [code, setCode] = useState('');
  const [cash, setCash] = useState('');
  const [match, setMatch] = useState(false);
  const st = d.deliveryStatus;
  const nav = (lat: number, lng: number) => Linking.openURL(`geo:${lat},${lng}?q=${lat},${lng}`).catch(() => Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`));
  const act = (fn: () => Promise<unknown>) => async () => { await fn(); reload(); };
  return (
    <Card>
      <H>Pedido #{d.orderNumber}</H>
      <Badge text={(LABELS.delivery as any)[st]} tone="warn" />
      <Banner tone="warn" text="Opera con el vehículo detenido." />
      <MapWeb center={{ lat: d.branch.lat, lng: d.branch.lng }} markers={[{ lat: d.branch.lat, lng: d.branch.lng, label: d.branch.name }, { lat: d.customer.lat, lng: d.customer.lng, label: 'Cliente', color: '#c2410c' }]} height={220} />
      <P>Recoger: {d.branch.name} · {d.branch.address}</P>
      <Btn kind="secondary" title="Navegar al comercio" onPress={() => nav(d.branch.lat, d.branch.lng)} />
      <P>Entregar: {d.customer.name} · {d.customer.address} {d.customer.reference ? `(${d.customer.reference})` : ''}</P>
      <Btn kind="secondary" title="Navegar al cliente" onPress={() => nav(d.customer.lat, d.customer.lng)} />
      {d.cashToCollectCents ? <Banner text={`Cobrar ${formatPEN(d.cashToCollectCents)} en efectivo`} /> : null}
      {d.containsAlcohol && ALCOHOL_LEGAL_NOTICES.map((n) => <Text key={n} style={s.legal}>{n}</Text>)}
      {st === 'asignado' && <Btn title="Voy al comercio" onPress={act(() => api.call('courierHeading', { params: { orderId: d.orderId } }))} />}
      {['asignado', 'en_camino_al_comercio'].includes(st) && (
        <>
          <Field label="Código de recojo" keyboardType="number-pad" value={pickup} onChangeText={setPickup} />
          <Btn title={`Confirmar recojo (${d.packages} paquete/s)`} disabled={!pickup} onPress={act(() => api.call('courierPickup', { params: { orderId: d.orderId }, body: { pickupCode: pickup, packages: d.packages } }))} />
        </>
      )}
      {st === 'recogido' && <Btn title="En camino al cliente" onPress={act(() => api.call('courierDepart', { params: { orderId: d.orderId } }))} />}
      {st === 'en_camino_al_cliente' && <Btn title="Llegué al destino" onPress={act(() => api.call('courierArrive', { params: { orderId: d.orderId } }))} />}
      {st === 'verificacion_requerida' && !d.ageCheckApproved && (
        <>
          <Banner tone="warn" text="Pide DNI, carné de extranjería o pasaporte. Verifica que la persona es el comprador y tiene 18 años cumplidos. No fotografíes el documento. Nunca dejes el pedido en la puerta ni lo entregues a otra persona." />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Switch value={match} onValueChange={setMatch} /><P>Coincide con el documento y es mayor de edad</P></View>
          <Btn title="Verificación aprobada (DNI)" disabled={!match} onPress={act(() => api.call('courierAgeCheck', { params: { orderId: d.orderId }, body: { result: 'approved', documentType: 'dni', identityMatchesBuyer: true } }))} />
          <Btn kind="danger" title="Rechazar: no presenta documento" onPress={act(() => api.call('courierAgeCheck', { params: { orderId: d.orderId }, body: { result: 'rejected', rejectionReason: 'no_document', identityMatchesBuyer: false } }))} />
          <Btn kind="danger" title="Rechazar: identidad no coincide" onPress={act(() => api.call('courierAgeCheck', { params: { orderId: d.orderId }, body: { result: 'rejected', rejectionReason: 'identity_mismatch', identityMatchesBuyer: false } }))} />
          <Btn kind="danger" title="Rechazar: menor de edad" onPress={act(() => api.call('courierAgeCheck', { params: { orderId: d.orderId }, body: { result: 'rejected', rejectionReason: 'underage', identityMatchesBuyer: false } }))} />
        </>
      )}
      {(st === 'en_destino' || (st === 'verificacion_requerida' && d.ageCheckApproved)) && (
        <>
          <Field label="Código de entrega (4 dígitos)" keyboardType="number-pad" maxLength={4} value={code} onChangeText={setCode} />
          {d.cashToCollectCents ? <Field label="Efectivo recibido (S/)" keyboardType="decimal-pad" value={cash} onChangeText={setCash} /> : null}
          <Btn title="Confirmar entrega" disabled={code.length !== 4} onPress={act(() => api.call('courierDeliver', { params: { orderId: d.orderId }, body: { deliveryCode: code, cashCollectedCents: cash ? Math.round(Number(cash) * 100) : undefined } }))} />
        </>
      )}
      {['en_camino_al_cliente', 'en_destino'].includes(st) && (
        <>
          <Btn kind="secondary" title="Cliente ausente" onPress={act(() => api.call('courierFail', { params: { orderId: d.orderId }, body: { kind: 'customer_absent', notes: 'Cliente no responde tras espera' } }))} />
          <Btn kind="secondary" title="Accidente o avería" onPress={act(() => api.call('courierFail', { params: { orderId: d.orderId }, body: { kind: 'vehicle_breakdown', notes: 'Reportado desde la app' } }))} />
        </>
      )}
      {st === 'retorno_pendiente' && <Banner text="Devuelve el pedido al comercio; ellos confirmarán la recepción." />}
    </Card>
  );
}

void Pressable;
