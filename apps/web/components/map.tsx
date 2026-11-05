'use client';
import { useEffect, useRef } from 'react';
import 'leaflet/dist/leaflet.css';

/**
 * Mapa con Leaflet. Las teselas vienen de NEXT_PUBLIC_MAP_TILE_URL; el valor por defecto usa los
 * servidores públicos de OpenStreetMap SOLO para desarrollo (política de uso limitada). Para
 * operación real se debe contratar un proveedor o servidor propio (ver docs/integraciones.md).
 */
const TILE = process.env.NEXT_PUBLIC_MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTR = process.env.NEXT_PUBLIC_MAP_ATTRIBUTION || '&copy; colaboradores de OpenStreetMap';

export interface Marker {
  lat: number;
  lng: number;
  label: string;
  color?: string;
}

export function MapView({ center, markers = [], onPick, pick, height = 260, polygons = [] }: { center: { lat: number; lng: number }; markers?: Marker[]; onPick?: (p: { lat: number; lng: number }) => void; pick?: { lat: number; lng: number } | null; height?: number; polygons?: any[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import('leaflet')).default;
      if (cancelled || !ref.current || mapRef.current) return;
      const m = L.map(ref.current, { zoomControl: true }).setView([center.lat, center.lng], 15);
      L.tileLayer(TILE, { attribution: ATTR, maxZoom: 19 }).addTo(m);
      layerRef.current = L.layerGroup().addTo(m);
      m.on('click', (e: any) => onPickRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
      mapRef.current = m;
      draw(L);
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function draw(Lmod?: any) {
    const L = Lmod ?? (await import('leaflet')).default;
    if (!layerRef.current) return;
    layerRef.current.clearLayers();
    for (const g of polygons) L.geoJSON(g, { style: { color: '#167a4f', weight: 2, fillOpacity: 0.06, dashArray: '4' } }).addTo(layerRef.current);
    const all = [...markers, ...(pick ? [{ ...pick, label: 'Punto de entrega', color: '#c2410c' }] : [])];
    for (const mk of all) {
      L.circleMarker([mk.lat, mk.lng], { radius: 9, color: '#fff', weight: 2, fillColor: mk.color ?? '#11613f', fillOpacity: 1 }).bindTooltip(mk.label).addTo(layerRef.current);
    }
  }
  useEffect(() => {
    draw();
    if (pick && mapRef.current) mapRef.current.panTo([pick.lat, pick.lng]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(markers), JSON.stringify(pick), polygons.length]);

  return <div ref={ref} className="map" style={{ height }} role="application" aria-label="Mapa" />;
}
