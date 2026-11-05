'use client';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { ProductDto, StoreDetailDto } from '@aquisito/contracts';
import { api, ApiError, errorMessage, useQuery } from '@/lib/api';
import { AlcoholNotices, ErrorBox, Loading, Money, useSession } from '@/components/ui';

const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

export default function StorePage() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const router = useRouter();
  const { me } = useSession();
  const store = useQuery<StoreDetailDto>('store', { params: { id }, query: { lat: sp.get('lat') ?? undefined, lng: sp.get('lng') ?? undefined } }, [me?.id]);
  const [open, setOpen] = useState<ProductDto | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const groups = useMemo(() => {
    const g = new Map<string, ProductDto[]>();
    for (const p of store.data?.products ?? []) g.set(p.categoryName, [...(g.get(p.categoryName) ?? []), p]);
    return [...g.entries()];
  }, [store.data]);

  if (store.loading) return <Loading lines={4} />;
  if (store.error) return <ErrorBox error={store.error} onRetry={store.reload} />;
  const s = store.data!;
  const hasAlcohol = s.products.some((p) => p.containsAlcohol);

  return (
    <section>
      <h1>{s.name}</h1>
      <div className="row muted small">
        {s.isOpen ? <span className="badge">Abierto</span> : <span className="badge closed">Cerrado · {s.closedReason}</span>}
        <span>{s.address}</span>
        {s.etaMinutes && <span>· {s.etaMinutes.min}–{s.etaMinutes.max} min estimados</span>}
        {s.deliveryFeeCents != null && <span>· Envío <Money cents={s.deliveryFeeCents} className="" />{s.distanceMethod === 'approx_haversine' ? ' (distancia aproximada)' : ''}</span>}
        <button className="btn sm ghost" onClick={async () => { if (!me) return router.push('/cuenta'); await api.call('addFavorite', { params: { branchId: s.id } }); setMsg('Agregado a favoritos'); }}>☆ Favorito</button>
      </div>
      <details className="small muted" style={{ margin: '6px 0' }}>
        <summary>Horario</summary>
        {s.hours.map((h, i) => <div key={i}>{DAYS[h.weekday]} {h.opens}–{h.closes}</div>)}
      </details>
      {msg && <div className="alert ok">{msg}</div>}
      {s.restrictedContentHidden && (
        <div className="alert info">Este comercio tiene productos solo para adultos verificados. {me ? 'Solicita tu verificación de edad en Cuenta.' : 'Inicia sesión y verifica tu mayoría de edad para verlos.'}</div>
      )}
      {hasAlcohol && <AlcoholNotices />}
      {groups.map(([name, items]) => (
        <div key={name} className="card" style={{ marginTop: 12 }}>
          <h2>{name}</h2>
          {items.map((p) => (
            <div key={p.id} className="product">
              <div className="col" style={{ gap: 2 }}>
                <strong>{p.name} {p.containsAlcohol && <span className="badge adult">18+</span>}</strong>
                <span className="muted small">{p.description}</span>
                {p.combo && (
                  <span className="small">
                    Incluye: {p.combo.components.map((c) => `${c.quantity} × ${c.label}`).join(' + ')}
                    {p.combo.savingsCents > 0 && <> · Por separado <span className="strike"><Money cents={p.combo.referencePriceCents} className="" /></span> (ahorro <Money cents={p.combo.savingsCents} className="" />)</>}
                    {p.combo.conditions.map((c) => <span key={c} className="muted"> · {c}</span>)}
                  </span>
                )}
                {p.variants[0]?.available !== null && p.variants[0]?.available !== undefined && p.variants[0].available <= 5 && p.variants[0].available > 0 && <span className="small" style={{ color: 'var(--mango-800)' }}>Quedan {p.variants[0].available}</span>}
              </div>
              <div className="col" style={{ alignItems: 'flex-end', gap: 4 }}>
                <Money cents={p.variants[0]?.priceCents ?? 0} />
                {p.available ? (
                  <button className="btn sm" disabled={!s.isOpen && false} onClick={() => (me ? setOpen(p) : router.push('/cuenta'))} aria-label={`Agregar ${p.name}`}>Agregar</button>
                ) : (
                  <span className="badge closed">Agotado</span>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
      {!s.isOpen && <p className="alert warn" style={{ marginTop: 12 }}>El comercio está cerrado ahora. Puedes armar tu carrito y programar el pedido en una franja disponible.</p>}
      {open && <ProductModal product={open} storeId={s.id} onClose={() => setOpen(null)} onAdded={() => { setOpen(null); setMsg('Producto agregado al carrito'); }} />}
    </section>
  );
}

function ProductModal({ product, storeId, onClose, onAdded }: { product: ProductDto; storeId: string; onClose: () => void; onAdded: () => void }) {
  const [variantId, setVariantId] = useState(product.variants[0]?.id);
  const [qty, setQty] = useState(1);
  const [mods, setMods] = useState<string[]>([]);
  const [combo, setCombo] = useState<Record<string, string>>(() => Object.fromEntries((product.combo?.components ?? []).filter((c) => c.options.length === 1).map((c) => [c.id, c.options[0].variantId])));
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const variant = product.variants.find((v) => v.id === variantId)!;
  const modCost = product.modifierGroups.flatMap((g) => g.options).filter((o) => mods.includes(o.id)).reduce((s, o) => s + o.priceCents, 0);

  async function add(replace = false) {
    setBusy(true);
    setErr(null);
    try {
      const cart = await api.call('cart');
      const keep = cart.branchId === storeId ? cart.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, modifierOptionIds: l.modifierOptionIds, comboSelections: l.comboSelections, notes: l.notes ?? undefined })) : [];
      await api.call('putCart', { body: { branchId: storeId, replaceOtherBranch: replace, items: [...keep, { variantId, quantity: qty, modifierOptionIds: mods, comboSelections: combo, notes: notes || undefined }] } });
      onAdded();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CART_OTHER_BRANCH') {
        if (window.confirm('Tu carrito tiene productos de otro comercio. Un pedido solo puede tener productos de una sucursal. ¿Reemplazar el carrito?')) return add(true);
      } else setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={product.name} onClick={(e) => e.stopPropagation()}>
        <h2>{product.name}</h2>
        <p className="muted">{product.description}</p>
        {product.variants.length > 1 && (
          <label>Presentación
            <select value={variantId} onChange={(e) => setVariantId(e.target.value)}>
              {product.variants.map((v) => <option key={v.id} value={v.id}>{v.name} · S/ {(v.priceCents / 100).toFixed(2)}</option>)}
            </select>
          </label>
        )}
        {product.modifierGroups.map((g) => (
          <fieldset key={g.id} style={{ border: '1px solid var(--line)', borderRadius: 10, marginTop: 8 }}>
            <legend className="small">{g.name} {g.minSelect > 0 ? '(obligatorio)' : '(opcional)'} · máx. {g.maxSelect}</legend>
            {g.options.map((o) => (
              <label key={o.id} className="check">
                <input type="checkbox" checked={mods.includes(o.id)} onChange={(e) => setMods(e.target.checked ? [...mods, o.id] : mods.filter((m) => m !== o.id))} />
                {o.name} {o.priceCents ? `(+S/ ${(o.priceCents / 100).toFixed(2)})` : '(sin costo)'}
              </label>
            ))}
          </fieldset>
        ))}
        {product.combo?.components.map((c) => (
          <label key={c.id} style={{ marginTop: 8 }}>{c.quantity} × {c.label}
            {c.options.length > 1 ? (
              <select value={combo[c.id] ?? ''} onChange={(e) => setCombo({ ...combo, [c.id]: e.target.value })}>
                <option value="">Elige una opción</option>
                {c.options.map((o) => <option key={o.variantId} value={o.variantId}>{o.name}</option>)}
              </select>
            ) : <span className="muted">{c.options[0]?.name}</span>}
          </label>
        ))}
        <label style={{ marginTop: 8 }}>Nota para el comercio (no cambia cantidades ni precio)
          <input value={notes} maxLength={200} onChange={(e) => setNotes(e.target.value)} placeholder="Ej.: sin cebolla" />
        </label>
        <div className="row" style={{ marginTop: 12, justifyContent: 'space-between' }}>
          <div className="row">
            <button className="btn sm ghost" onClick={() => setQty(Math.max(1, qty - 1))} aria-label="Menos">−</button>
            <strong aria-live="polite">{qty}</strong>
            <button className="btn sm ghost" onClick={() => setQty(Math.min(50, qty + 1))} aria-label="Más">+</button>
          </div>
          <button className="btn" disabled={busy} onClick={() => add()}>{busy ? 'Agregando…' : <>Agregar · <Money cents={(variant.priceCents + modCost) * qty} className="" /></>}</button>
        </div>
        <p className="muted small">El precio final lo confirma el servidor al cotizar.</p>
        {err && <div className="alert error">{err}</div>}
        <button className="btn ghost block" style={{ marginTop: 8 }} onClick={onClose}>Cerrar</button>
      </div>
    </div>
  );
}
