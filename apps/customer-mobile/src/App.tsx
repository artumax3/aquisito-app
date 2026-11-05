import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, RefreshControl, ScrollView, Switch, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import { ApiError, formatPEN, LABELS, newIdempotencyKey, ALCOHOL_LEGAL_NOTICES } from '@aquisito/api-client';
import type { CartDto, CityDto, MeDto, OrderDto, ProductDto, QuoteDto, StoreDetailDto, StoreSummaryDto, TrackingDto } from '@aquisito/contracts';
import { api, tokenStore } from './api';
import { Badge, Banner, Btn, C, Card, errorText, Field, H, P, s } from './ui';

type Route = { name: 'home' } | { name: 'store'; id: string } | { name: 'cart' } | { name: 'orders' } | { name: 'order'; id: string } | { name: 'account' };

export default function App() {
  const [me, setMe] = useState<MeDto | null>(null);
  const [booting, setBooting] = useState(true);
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const refreshMe = useCallback(async () => {
    try {
      setMe((await tokenStore.get()) ? await api.call('me') : null);
    } catch {
      setMe(null);
    } finally {
      setBooting(false);
    }
  }, []);
  useEffect(() => {
    refreshMe();
  }, [refreshMe]);

  if (booting) return <View style={s.screen} />;
  if (!me) return <Login onDone={refreshMe} />;
  return (
    <View style={s.screen}>
      <StatusBar style="light" />
      <View style={s.header}><Text style={s.brand}>aqui<Text style={{ color: C.mango500 }}>sito</Text></Text></View>
      <View style={{ flex: 1 }}>
        {route.name === 'home' && <Home go={setRoute} />}
        {route.name === 'store' && <Store id={route.id} go={setRoute} />}
        {route.name === 'cart' && <Cart go={setRoute} />}
        {route.name === 'orders' && <Orders go={setRoute} />}
        {route.name === 'order' && <Order id={route.id} />}
        {route.name === 'account' && <Account me={me} onLogout={async () => { await api.call('logout').catch(() => undefined); await tokenStore.clear(); setMe(null); }} refresh={refreshMe} />}
      </View>
      <View style={s.tabbar}>
        {([['home', 'Inicio'], ['cart', 'Carrito'], ['orders', 'Pedidos'], ['account', 'Cuenta']] as const).map(([n, l]) => (
          <Pressable key={n} style={s.tab} onPress={() => setRoute({ name: n } as Route)} accessibilityRole="tab">
            <Text style={{ fontWeight: '700', color: route.name === n ? C.selva700 : C.ink600 }}>{l}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function Login({ onDone }: { onDone: () => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('+51');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  return (
    <ScrollView style={s.screen} contentContainerStyle={[s.content, { paddingTop: 64 }]}>
      <Text style={[s.brand, { color: C.selva900, fontSize: 30 }]}>aqui<Text style={{ color: C.mango700 }}>sito</Text></Text>
      <P muted>Delivery en Aguaytía y Tingo María (nombre provisional).</P>
      <Card>
        <H>Ingresar con correo</H>
        <Field label="Correo" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
        <Field label="Contraseña" secureTextEntry value={password} onChangeText={setPassword} />
        <Btn title="Ingresar" onPress={async () => { const r = await api.call('login', { body: { email, password, deviceLabel: 'App cliente' } }); await tokenStore.set(r.token); await onDone(); }} />
      </Card>
      <Card>
        <H>O con tu teléfono</H>
        <Field label="Teléfono" keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
        {otpSent && <Field label="Código SMS" keyboardType="number-pad" value={code} onChangeText={setCode} />}
        {otpSent && <Field label="Nombre (primera vez)" value={name} onChangeText={setName} />}
        <Btn kind="secondary" title={otpSent ? 'Verificar código' : 'Enviar código'} onPress={async () => {
          if (!otpSent) { await api.call('otpRequest', { body: { phone } }); setOtpSent(true); return; }
          const r = await api.call('otpVerify', { body: { phone, code, fullName: name || undefined, deviceLabel: 'App cliente' } });
          await tokenStore.set(r.token);
          await onDone();
        }} />
      </Card>
    </ScrollView>
  );
}

function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fn());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, loading, reload };
}

function Home({ go }: { go: (r: Route) => void }) {
  const cities = useLoad<CityDto[]>(() => api.call('cities'));
  const [cityId, setCityId] = useState<string | null>(null);
  const addresses = useLoad<any[]>(() => api.call('addresses'));
  const addr = (addresses.data ?? []).find((a) => a.cityId === cityId && a.inCoverage);
  const stores = useLoad<StoreSummaryDto[]>(async () => (cityId ? api.call('stores', { query: { cityId, lat: addr?.lat, lng: addr?.lng } }) : []), [cityId, addr?.id]);
  return (
    <ScrollView contentContainerStyle={s.content} refreshControl={<RefreshControl refreshing={stores.loading} onRefresh={stores.reload} />}>
      {cities.error && <Banner tone="bad" text={cities.error} />}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {cities.data?.map((c) => (
          <Pressable key={c.id} onPress={() => setCityId(c.id)} style={[s.card, { paddingVertical: 8, backgroundColor: cityId === c.id ? C.selva700 : '#fff' }]}>
            <Text style={{ fontWeight: '700', color: cityId === c.id ? '#fff' : C.ink900 }}>📍 {c.name}</Text>
          </Pressable>
        ))}
      </View>
      {!cityId && <P muted>Elige tu ciudad. No hacemos envíos entre ciudades.</P>}
      {cityId && (addr ? <P muted>Entregar en: {addr.label} · {addr.line1}</P> : <Banner tone="warn" text="Agrega una dirección en esta ciudad desde Cuenta para ver costos exactos." />)}
      {stores.error && <Banner tone="bad" text={stores.error} />}
      {stores.data?.map((st) => (
        <Pressable key={st.id} onPress={() => go({ name: 'store', id: st.id })}>
          <Card>
            <Text style={{ fontWeight: '800', fontSize: 16 }}>{st.name}</Text>
            <Badge text={st.isOpen ? 'Abierto' : `Cerrado · ${st.closedReason ?? ''}`} tone={st.isOpen ? 'ok' : 'warn'} />
            <P muted>
              {st.etaMinutes ? `${st.etaMinutes.min}–${st.etaMinutes.max} min (estimado)` : ''}
              {st.deliveryFeeCents != null ? ` · Envío ${formatPEN(st.deliveryFeeCents)}${st.distanceMethod === 'approx_haversine' ? ' aprox.' : ''}` : ''}
            </P>
          </Card>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function Store({ id, go }: { id: string; go: (r: Route) => void }) {
  const store = useLoad<StoreDetailDto>(() => api.call('store', { params: { id } }), [id]);
  const [msg, setMsg] = useState<string | null>(null);
  async function add(p: ProductDto, replace = false): Promise<void> {
    const comboSelections = Object.fromEntries((p.combo?.components ?? []).map((c) => [c.id, c.options[0]?.variantId]));
    const required = p.modifierGroups.filter((g) => g.minSelect > 0).flatMap((g) => g.options.slice(0, g.minSelect).map((o) => o.id));
    const cart = await api.call('cart');
    const keep = cart.branchId === id ? cart.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, modifierOptionIds: l.modifierOptionIds, comboSelections: l.comboSelections })) : [];
    try {
      await api.call('putCart', { body: { branchId: id, replaceOtherBranch: replace, items: [...keep, { variantId: p.variants[0].id, quantity: 1, modifierOptionIds: required, comboSelections }] } });
      setMsg(`${p.name} agregado al carrito`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CART_OTHER_BRANCH') {
        setMsg('Tu carrito tiene productos de otro comercio. Toca de nuevo "Agregar" con la opción reemplazar.');
        throw e;
      }
      throw e;
    }
  }
  if (store.loading) return <View style={s.content}><P>Cargando…</P></View>;
  if (store.error) return <View style={s.content}><Banner tone="bad" text={store.error} /></View>;
  const st = store.data!;
  return (
    <ScrollView contentContainerStyle={s.content}>
      <H>{st.name}</H>
      <Badge text={st.isOpen ? 'Abierto' : `Cerrado · ${st.closedReason}`} tone={st.isOpen ? 'ok' : 'warn'} />
      {st.restrictedContentHidden && <Banner text="Hay productos solo para adultos verificados. Solicita tu verificación desde la web (Cuenta)." />}
      {st.products.some((p) => p.containsAlcohol) && ALCOHOL_LEGAL_NOTICES.map((n) => <Text key={n} style={s.legal}>{n}</Text>)}
      {msg && <Banner text={msg} />}
      {st.products.map((p) => (
        <Card key={p.id}>
          <Text style={{ fontWeight: '700' }}>{p.name} {p.containsAlcohol ? '· 18+' : ''}</Text>
          <P muted>{p.description}</P>
          {p.combo && <P muted>Incluye: {p.combo.components.map((c) => `${c.quantity} × ${c.label}`).join(' + ')}</P>}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ fontWeight: '800' }}>{formatPEN(p.variants[0]?.priceCents ?? 0)}</Text>
            {p.available ? <Btn title="Agregar" onPress={() => add(p).catch(async (e) => { if (e instanceof ApiError && e.code === 'CART_OTHER_BRANCH') await add(p, true); else throw e; })} /> : <Badge tone="bad" text="Agotado" />}
          </View>
        </Card>
      ))}
      <Btn kind="secondary" title="Ver carrito" onPress={() => go({ name: 'cart' })} />
    </ScrollView>
  );
}

function Cart({ go }: { go: (r: Route) => void }) {
  const cart = useLoad<CartDto>(() => api.call('cart'));
  const addresses = useLoad<any[]>(() => api.call('addresses'));
  const [addressId, setAddressId] = useState<string | null>(null);
  const [method, setMethod] = useState<'card' | 'wallet' | 'cash'>('cash');
  const [quote, setQuote] = useState<QuoteDto | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [terms, setTerms] = useState(false);
  const [idem] = useState(newIdempotencyKey());
  const addr = addressId ?? addresses.data?.find((a) => a.inCoverage)?.id ?? null;
  useEffect(() => {
    (async () => {
      setQuote(null);
      setErr(null);
      if (!addr || !cart.data?.lines.length) return;
      try {
        setQuote(await api.call('quote', { body: { addressId: addr, paymentMethod: method, tipCents: 0 } }));
      } catch (e) {
        setErr(errorText(e));
      }
    })();
  }, [addr, method, cart.data?.subtotalCents]);
  if (!cart.data) return <View style={s.content}><P>{cart.error ?? 'Cargando…'}</P></View>;
  if (!cart.data.lines.length) return <View style={s.content}><P muted>Tu carrito está vacío.</P></View>;
  return (
    <ScrollView contentContainerStyle={s.content}>
      <H>{cart.data.branchName}</H>
      {cart.data.lines.map((l) => <P key={l.index}>{l.quantity} × {l.name} · {formatPEN(l.lineTotalCents)}</P>)}
      <Card>
        <Text style={s.label}>Dirección</Text>
        {(addresses.data ?? []).map((a) => (
          <Pressable key={a.id} onPress={() => setAddressId(a.id)}><Text style={{ fontWeight: addr === a.id ? '800' : '400' }}>{addr === a.id ? '● ' : '○ '}{a.label}: {a.line1} {a.inCoverage ? '' : '(fuera de cobertura)'}</Text></Pressable>
        ))}
        <Text style={s.label}>Pago</Text>
        {(['cash', 'card', 'wallet'] as const).map((m) => <Pressable key={m} onPress={() => setMethod(m)}><Text>{method === m ? '● ' : '○ '}{m === 'cash' ? 'Efectivo contra entrega' : m === 'card' ? 'Tarjeta (checkout del proveedor)' : 'Billetera móvil vía proveedor'}</Text></Pressable>)}
      </Card>
      {err && <Banner tone="bad" text={err} />}
      {quote && (
        <Card>
          {quote.breakdown.map((b) => <P key={b.label}>{b.label}: {formatPEN(b.amountCents)}</P>)}
          <Text style={{ fontWeight: '800', fontSize: 18 }}>Total {formatPEN(quote.totalCents)}</Text>
          <P muted>Estimado {quote.etaMinutes.min}–{quote.etaMinutes.max} min</P>
          {quote.containsAlcohol && (
            <>
              {ALCOHOL_LEGAL_NOTICES.map((n) => <Text key={n} style={s.legal}>{n}</Text>)}
              <P muted>{quote.alcoholNotice}</P>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Switch value={terms} onValueChange={setTerms} /><P>Mostraré mi documento al recibir</P></View>
            </>
          )}
          <Btn title="Confirmar pedido" disabled={quote.containsAlcohol && !terms} onPress={async () => {
            const o = await api.call('createOrder', { idempotencyKey: idem, body: { quoteId: quote.id, quoteVersion: quote.version, alcoholTermsAccepted: terms } });
            if (method !== 'cash') {
              const p = await api.call('startPayment', { body: { orderId: o.id }, idempotencyKey: `pay-${o.id}` });
              if (p.checkoutUrl && !p.simulated) await Linking.openURL(p.checkoutUrl);
            }
            go({ name: 'order', id: o.id });
          }} />
        </Card>
      )}
    </ScrollView>
  );
}

function Orders({ go }: { go: (r: Route) => void }) {
  const orders = useLoad<OrderDto[]>(() => api.call('orders'));
  return (
    <ScrollView contentContainerStyle={s.content} refreshControl={<RefreshControl refreshing={orders.loading} onRefresh={orders.reload} />}>
      <H>Mis pedidos</H>
      {orders.error && <Banner tone="bad" text={orders.error} />}
      {orders.data?.map((o) => (
        <Pressable key={o.id} onPress={() => go({ name: 'order', id: o.id })}>
          <Card>
            <Text style={{ fontWeight: '800' }}>#{o.number} · {o.branchName} · {formatPEN(o.totalCents)}</Text>
            <P muted>{(LABELS.commercial as any)[o.commercialStatus]} · {(LABELS.delivery as any)[o.deliveryStatus]} · {(LABELS.payment as any)[o.paymentStatus]}</P>
          </Card>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function Order({ id }: { id: string }) {
  const order = useLoad<OrderDto>(() => api.call('order', { params: { id } }), [id]);
  const [tracking, setTracking] = useState<TrackingDto | null>(null);
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    // Sin WebSocket nativo en esta versión: sondeo moderado; al recuperar conexión se consulta la verdad del servidor.
    const h = setInterval(async () => {
      order.reload();
      try {
        setTracking(await api.call('tracking', { params: { id } }));
      } catch {
        /* sin conexión: se conserva lo último con su hora */
      }
    }, 10000);
    return () => clearInterval(h);
  }, [id]);
  const o = order.data;
  if (!o) return <View style={s.content}><P>{order.error ?? 'Cargando…'}</P></View>;
  return (
    <ScrollView contentContainerStyle={s.content}>
      <H>Pedido #{o.number}</H>
      <Badge text={(LABELS.commercial as any)[o.commercialStatus]} />
      <Badge text={(LABELS.delivery as any)[o.deliveryStatus]} tone="warn" />
      <Badge text={(LABELS.payment as any)[o.paymentStatus]} tone={o.paymentStatus === 'pagado' ? 'ok' : 'warn'} />
      {o.paymentStatus === 'pendiente' && o.commercialStatus === 'pendiente_confirmacion' && <Banner tone="warn" text="Pago pendiente: se confirmará solo cuando el proveedor confirme el cobro." />}
      {tracking?.available && tracking.lat != null && (
        <Card>
          <P>Repartidor: {o.courier?.name ?? '—'}</P>
          <P muted>Última ubicación {new Date(tracking.recordedAt!).toLocaleTimeString('es-PE')} {tracking.stale ? '(desactualizada)' : ''}</P>
          <Btn kind="secondary" title="Ver en el mapa" onPress={() => Linking.openURL(`https://www.openstreetmap.org/?mlat=${tracking.lat}&mlon=${tracking.lng}#map=17/${tracking.lat}/${tracking.lng}`)} />
        </Card>
      )}
      {['recogido', 'en_camino_al_cliente', 'en_destino', 'verificacion_requerida'].includes(o.deliveryStatus) && (
        <Card>
          <Btn kind="secondary" title="Ver código de entrega" onPress={async () => setCode((await api.call('deliveryCode', { params: { id } })).code)} />
          {code && <Text style={{ fontSize: 30, fontWeight: '800', letterSpacing: 8, textAlign: 'center' }}>{code}</Text>}
          {o.containsAlcohol && <P muted>El código no reemplaza la verificación de tu documento.</P>}
        </Card>
      )}
      <Card>{o.lines.map((l) => <P key={l.id}>{l.quantity} × {l.name} · {formatPEN(l.lineTotalCents)}</P>)}<Text style={{ fontWeight: '800' }}>Total {formatPEN(o.totalCents)}</Text></Card>
      <Card>{o.history.slice().reverse().map((h, i) => <P key={i} muted>{new Date(h.at).toLocaleTimeString('es-PE')} · {(LABELS as any)[h.cycle][h.to] ?? h.to}</P>)}</Card>
      {o.canCancel && <Btn kind="danger" title="Cancelar pedido" onPress={async () => { await api.call('cancelOrder', { params: { id }, body: { reason: 'Cancelado desde la app' } }); order.reload(); }} />}
    </ScrollView>
  );
}

function Account({ me, onLogout, refresh }: { me: MeDto; onLogout: () => Promise<void>; refresh: () => Promise<void> }) {
  const cities = useLoad<CityDto[]>(() => api.call('cities'));
  const [cityId, setCityId] = useState<string | null>(null);
  const [line1, setLine1] = useState('');
  const [reference, setReference] = useState('');
  const [pt, setPt] = useState<{ lat: number; lng: number; acc: number } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <ScrollView contentContainerStyle={s.content}>
      <H>{me.fullName}</H>
      <P muted>{me.email ?? me.phone}</P>
      <P>Mayoría de edad: {me.ageStatus === 'verified' ? 'verificada' : me.ageStatus === 'pending' ? 'pendiente de revisión' : 'no verificada'}</P>
      <Card>
        <H>Nueva dirección</H>
        <View style={{ flexDirection: 'row', gap: 8 }}>{cities.data?.map((c) => <Pressable key={c.id} onPress={() => setCityId(c.id)}><Badge text={`${cityId === c.id ? '● ' : ''}${c.name}`} /></Pressable>)}</View>
        <Field label="Calle y número" value={line1} onChangeText={setLine1} />
        <Field label="Referencia" value={reference} onChangeText={setReference} />
        <Btn kind="secondary" title="Usar mi ubicación actual (pide permiso)" onPress={async () => {
          const perm = await Location.requestForegroundPermissionsAsync();
          if (perm.status !== 'granted') { setMsg('Permiso de ubicación denegado. Puedes registrar la dirección desde la web marcando el punto en el mapa.'); return; }
          const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
          setPt({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy ?? 0 });
          setConfirmed(false);
        }} />
        {pt && (
          <>
            <P muted>Punto: {pt.lat.toFixed(5)}, {pt.lng.toFixed(5)} (±{Math.round(pt.acc)} m)</P>
            <Btn kind="secondary" title="Revisar el punto en el mapa" onPress={() => Linking.openURL(`https://www.openstreetmap.org/?mlat=${pt.lat}&mlon=${pt.lng}#map=18/${pt.lat}/${pt.lng}`)} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Switch value={confirmed} onValueChange={setConfirmed} /><P>Confirmo que este es el punto de entrega</P></View>
          </>
        )}
        <Btn title="Guardar dirección" disabled={!cityId || !pt || !confirmed || line1.length < 3} onPress={async () => {
          const r = await api.call('addAddress', { body: { cityId: cityId!, label: 'Casa', line1, reference: reference || undefined, lat: pt!.lat, lng: pt!.lng, pointConfirmed: true } });
          setMsg(r.inCoverage ? 'Dirección guardada' : `Guardada, pero fuera de cobertura: ${r.coverageMessage}`);
          await refresh();
        }} />
        {msg && <Banner text={msg} />}
      </Card>
      <Btn kind="danger" title="Cerrar sesión" onPress={onLogout} />
    </ScrollView>
  );
}
