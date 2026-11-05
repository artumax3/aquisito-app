import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, RefreshControl, ScrollView, Switch, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import { ApiError, formatPEN, LABELS, newIdempotencyKey, ALCOHOL_LEGAL_NOTICES } from '@aquisito/api-client';
import type { CartDto, CityDto, MeDto, OrderDto, ProductDto, QuoteDto, StoreDetailDto, StoreSummaryDto, TrackingDto } from '@aquisito/contracts';
import { api, tokenStore } from './api';
import { Badge, Banner, Btn, C, Card, errorText, Field, H, P, s } from './ui';
import { registerPush } from './push';
import { MapWeb } from './MapWeb';
import { Modal } from 'react-native';

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
  const banners = useLoad<any[]>(async () => (cityId ? api.call('banners', { query: { cityId } }) : []), [cityId]);
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
      {banners.data?.map((b) => (
        <Card key={b.id}>
          <Text style={{ fontWeight: '800' }}>{b.title}{b.containsAlcohol ? ' · 18+' : ''}</Text>
          <P>{b.body}</P>
          <P muted>Condiciones: {b.conditions}</P>
          {b.linkBranchId && <Btn kind="secondary" title="Ver comercio" onPress={() => go({ name: 'store', id: b.linkBranchId })} />}
        </Card>
      ))}
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
  const [sheet, setSheet] = useState<ProductDto | null>(null);
  if (store.loading) return <View style={s.content}><P>Cargando…</P></View>;
  if (store.error) return <View style={s.content}><Banner tone="bad" text={store.error} /></View>;
  const st = store.data!;
  return (
    <ScrollView contentContainerStyle={s.content}>
      <H>{st.name}</H>
      <Badge text={st.isOpen ? 'Abierto' : `Cerrado · ${st.closedReason}`} tone={st.isOpen ? 'ok' : 'warn'} />
      {st.restrictedContentHidden && <Banner text="Hay productos solo para adultos verificados. Solicita tu verificación en Cuenta." />}
      {st.products.some((p) => p.containsAlcohol) && ALCOHOL_LEGAL_NOTICES.map((n) => <Text key={n} style={s.legal}>{n}</Text>)}
      {msg && <Banner text={msg} />}
      {st.products.map((p) => (
        <Card key={p.id}>
          <Text style={{ fontWeight: '700' }}>{p.name} {p.containsAlcohol ? '· 18+' : ''}</Text>
          <P muted>{p.description}</P>
          {p.combo && <P muted>Incluye: {p.combo.components.map((c) => `${c.quantity} × ${c.label}`).join(' + ')}{p.combo.savingsCents > 0 ? ` · ahorro ${formatPEN(p.combo.savingsCents)} vs. ${formatPEN(p.combo.referencePriceCents)}` : ''}</P>}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ fontWeight: '800' }}>{formatPEN(p.variants[0]?.priceCents ?? 0)}</Text>
            {p.available ? <Btn title="Elegir" onPress={() => setSheet(p)} /> : <Badge tone="bad" text="Agotado" />}
          </View>
        </Card>
      ))}
      <Btn kind="secondary" title="Ver carrito" onPress={() => go({ name: 'cart' })} />
      {sheet && <ProductSheet product={sheet} storeId={id} onClose={() => setSheet(null)} onAdded={(m) => { setSheet(null); setMsg(m); }} />}
    </ScrollView>
  );
}

/** Selección explícita de presentación, adicionales y opciones de combo: nada se elige en silencio. */
function ProductSheet({ product, storeId, onClose, onAdded }: { product: ProductDto; storeId: string; onClose: () => void; onAdded: (msg: string) => void }) {
  const [variantId, setVariantId] = useState(product.variants[0]?.id);
  const [mods, setMods] = useState<string[]>([]);
  const [combo, setCombo] = useState<Record<string, string>>(() => Object.fromEntries((product.combo?.components ?? []).filter((c) => c.options.length === 1).map((c) => [c.id, c.options[0].variantId])));
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState('');
  const [replaceAsk, setReplaceAsk] = useState(false);
  const variant = product.variants.find((v) => v.id === variantId)!;
  const modCost = product.modifierGroups.flatMap((g) => g.options).filter((o) => mods.includes(o.id)).reduce((a, o) => a + o.priceCents, 0);
  const missingGroup = product.modifierGroups.find((g) => mods.filter((m) => g.options.some((o) => o.id === m)).length < g.minSelect);
  const missingCombo = (product.combo?.components ?? []).find((c) => !combo[c.id]);
  async function add(replace: boolean) {
    const cart = await api.call('cart');
    const keep = cart.branchId === storeId ? cart.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, modifierOptionIds: l.modifierOptionIds, comboSelections: l.comboSelections, notes: l.notes ?? undefined })) : [];
    try {
      await api.call('putCart', { body: { branchId: storeId, replaceOtherBranch: replace, items: [...keep, { variantId, quantity: qty, modifierOptionIds: mods, comboSelections: combo, notes: notes || undefined }] } });
      onAdded(`${product.name} agregado al carrito`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CART_OTHER_BRANCH') { setReplaceAsk(true); return; }
      throw e;
    }
  }
  const toggle = (gId: string, oId: string, max: number) => {
    const g = product.modifierGroups.find((x) => x.id === gId)!;
    const inGroup = mods.filter((m) => g.options.some((o) => o.id === m));
    if (mods.includes(oId)) setMods(mods.filter((m) => m !== oId));
    else if (inGroup.length < max) setMods([...mods, oId]);
    else if (max === 1) setMods([...mods.filter((m) => !inGroup.includes(m)), oId]);
  };
  return (
    <Modal animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' }}>
        <ScrollView style={{ maxHeight: '88%', backgroundColor: '#fff', borderTopLeftRadius: 16, borderTopRightRadius: 16 }} contentContainerStyle={s.content}>
          <H>{product.name}</H>
          {product.variants.length > 1 && <Text style={s.label}>Presentación</Text>}
          {product.variants.length > 1 && product.variants.map((v) => (
            <Pressable key={v.id} onPress={() => setVariantId(v.id)} accessibilityRole="radio" accessibilityState={{ checked: variantId === v.id }}>
              <P>{variantId === v.id ? '● ' : '○ '}{v.name} · {formatPEN(v.priceCents)}</P>
            </Pressable>
          ))}
          {product.modifierGroups.map((g) => (
            <View key={g.id} style={{ gap: 4 }}>
              <Text style={s.label}>{g.name} {g.minSelect > 0 ? '(obligatorio)' : '(opcional)'} · máx. {g.maxSelect}</Text>
              {g.options.map((o) => (
                <Pressable key={o.id} onPress={() => toggle(g.id, o.id, g.maxSelect)} accessibilityRole="checkbox" accessibilityState={{ checked: mods.includes(o.id) }}>
                  <P>{mods.includes(o.id) ? '☑ ' : '☐ '}{o.name} {o.priceCents ? `(+${formatPEN(o.priceCents)})` : '(sin costo)'}</P>
                </Pressable>
              ))}
            </View>
          ))}
          {product.combo?.components.map((c) => (
            <View key={c.id} style={{ gap: 4 }}>
              <Text style={s.label}>{c.quantity} × {c.label}</Text>
              {c.options.map((o) => (
                <Pressable key={o.variantId} onPress={() => setCombo({ ...combo, [c.id]: o.variantId })} accessibilityRole="radio" accessibilityState={{ checked: combo[c.id] === o.variantId }}>
                  <P>{combo[c.id] === o.variantId ? '● ' : '○ '}{o.name}</P>
                </Pressable>
              ))}
            </View>
          ))}
          <Field label="Nota para el comercio (no cambia cantidades ni precio)" value={notes} onChangeText={setNotes} maxLength={200} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
            <Btn kind="secondary" title="−" onPress={() => setQty(Math.max(1, qty - 1))} />
            <Text style={{ fontSize: 18, fontWeight: '800' }}>{qty}</Text>
            <Btn kind="secondary" title="+" onPress={() => setQty(Math.min(50, qty + 1))} />
          </View>
          {missingGroup && <Banner tone="warn" text={`Elige al menos ${missingGroup.minSelect} en "${missingGroup.name}"`} />}
          {missingCombo && <Banner tone="warn" text={`Elige una opción para "${missingCombo.label}"`} />}
          {replaceAsk ? (
            <>
              <Banner tone="warn" text="Tu carrito tiene productos de otro comercio. Un pedido solo puede ser de una sucursal." />
              <Btn kind="danger" title="Reemplazar carrito" onPress={() => add(true)} />
            </>
          ) : (
            <Btn title={`Agregar · ${formatPEN((variant.priceCents + modCost) * qty)}`} disabled={!!missingGroup || !!missingCombo} onPress={() => add(false)} />
          )}
          <P muted>El precio final lo confirma el servidor al cotizar.</P>
          <Btn kind="secondary" title="Cerrar" onPress={onClose} />
        </ScrollView>
      </View>
    </Modal>
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
  const payCfg = useLoad<any>(() => api.call('paymentsConfig'));
  const mobilePay = (m: 'card' | 'wallet' | 'cash') => m === 'cash' || !!payCfg.data?.[m]?.mobileCheckout;
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
        {(['cash', 'card', 'wallet'] as const).map((m) => (
          <Pressable key={m} disabled={!mobilePay(m)} onPress={() => setMethod(m)}>
            <Text style={{ color: mobilePay(m) ? C.ink900 : C.ink600 }}>{method === m ? '● ' : '○ '}{m === 'cash' ? 'Efectivo contra entrega' : m === 'card' ? 'Tarjeta' : 'Billetera móvil (Yape/Plin)'}{!mobilePay(m) ? ' — disponible en la web por ahora' : payCfg.data?.[m]?.simulator ? ' (simulador de desarrollo)' : ''}</Text>
          </Pressable>
        ))}
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
            if (method !== 'cash') await api.call('startPayment', { body: { orderId: o.id }, idempotencyKey: `pay-${o.id}` });
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
      {o.paymentStatus === 'pendiente' && o.commercialStatus === 'pendiente_confirmacion' && (
        <Card>
          <Banner tone="warn" text="Pago pendiente: se confirmará solo cuando el proveedor confirme el cobro." />
          {o.latestPaymentId && <DevPay paymentId={o.latestPaymentId} onDone={order.reload} />}
        </Card>
      )}
      {tracking?.available && tracking.lat != null && (
        <Card>
          <P>Repartidor: {o.courier?.name ?? '—'}</P>
          <P muted>Última ubicación {new Date(tracking.recordedAt!).toLocaleTimeString('es-PE')} {tracking.stale ? '(desactualizada)' : ''}</P>
          <MapWeb center={{ lat: tracking.lat, lng: tracking.lng! }} markers={[{ lat: tracking.lat, lng: tracking.lng!, label: 'Repartidor', color: '#f59e0b' }, ...(o.address ? [{ lat: o.address.lat, lng: o.address.lng, label: 'Tu dirección' }] : [])]} />
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
        {cityId && <P muted>Toca el mapa para marcar el punto exacto de entrega (o usa tu ubicación).</P>}
        {cityId && <MapWeb key={cityId} center={pt ?? cities.data!.find((c) => c.id === cityId)!.center} markers={pt ? [{ lat: pt.lat, lng: pt.lng, label: 'Punto de entrega', color: '#c2410c' }] : []} onPick={(p) => { setPt({ ...p, acc: 0 }); setConfirmed(false); }} height={260} />}
        {pt && (
          <>
            <P muted>Punto: {pt.lat.toFixed(5)}, {pt.lng.toFixed(5)}{pt.acc ? ` (±${Math.round(pt.acc)} m)` : ' (marcado en el mapa)'}</P>
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
      <AgeVerification me={me} refresh={refresh} />
      <Card>
        <H>Notificaciones</H>
        <Btn kind="secondary" title="Activar notificaciones" onPress={async () => setMsg(await registerPush())} />
      </Card>
      <Btn kind="danger" title="Cerrar sesión" onPress={onLogout} />
    </ScrollView>
  );
}

function AgeVerification({ me, refresh }: { me: MeDto; refresh: () => Promise<void> }) {
  const [docType, setDocType] = useState<'dni' | 'carne_extranjeria' | 'pasaporte'>('dni');
  const [last4, setLast4] = useState('');
  const [name, setName] = useState('');
  const [birth, setBirth] = useState('');
  const [consent, setConsent] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!['none', 'declared', 'rejected', 'revoked'].includes(me.ageStatus)) return null;
  return (
    <Card>
      <H>Verificar mayoría de edad</H>
      <P muted>Solo para comprar bebidas alcohólicas. Una persona del equipo revisa tu solicitud; no guardamos foto de tu documento ni nos conectamos con RENIEC.</P>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {(['dni', 'carne_extranjeria', 'pasaporte'] as const).map((d) => <Pressable key={d} onPress={() => setDocType(d)}><Badge text={`${docType === d ? '● ' : ''}${d === 'dni' ? 'DNI' : d === 'pasaporte' ? 'Pasaporte' : 'Carné de extranjería'}`} /></Pressable>)}
      </View>
      <Field label="Últimos 4 caracteres del documento" autoCapitalize="characters" maxLength={4} value={last4} onChangeText={(t) => setLast4(t.toUpperCase())} />
      <Field label="Nombre como figura en el documento" value={name} onChangeText={setName} />
      <Field label="Fecha de nacimiento (AAAA-MM-DD)" value={birth} onChangeText={setBirth} keyboardType="numbers-and-punctuation" />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Switch value={consent} onValueChange={setConsent} /><P>Autorizo usar estos datos solo para verificar mi edad</P></View>
      <Btn title="Solicitar verificación" disabled={!consent} onPress={async () => { await api.call('requestAgeVerification', { body: { documentType: docType, documentLast4: last4, fullNameOnDocument: name, birthDate: birth, consent: true } }); setMsg('Solicitud enviada; te avisaremos el resultado.'); await refresh(); }} />
      {msg && <Banner text={msg} />}
    </Card>
  );
}

/** Botones del simulador de pagos: solo aparecen si el pago usa el proveedor "sandbox" (desarrollo). */
function DevPay({ paymentId, onDone }: { paymentId: string; onDone: () => void }) {
  const p = useLoad<any>(() => api.call('payment', { params: { id: paymentId } }), [paymentId]);
  if (!p.data?.simulated) return null;
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontWeight: '800', color: '#8a4b06' }}>SIMULADOR DE PAGOS — SOLO DESARROLLO</Text>
      <Btn title="Simular pago aprobado" onPress={async () => { await api.call('simulatePayment', { params: { id: paymentId }, body: { outcome: 'paid' } }); onDone(); }} />
      <Btn kind="danger" title="Simular rechazo" onPress={async () => { await api.call('simulatePayment', { params: { id: paymentId }, body: { outcome: 'failed' } }); onDone(); }} />
    </View>
  );
}
