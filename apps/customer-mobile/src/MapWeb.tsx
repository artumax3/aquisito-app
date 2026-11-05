import { useEffect, useMemo, useRef } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import Constants from 'expo-constants';

export interface MapMarker {
  lat: number;
  lng: number;
  label: string;
  color?: string;
}

/**
 * Mapa Leaflet dentro de un WebView (sin SDK nativo de mapas ni llave de Google). Las teselas
 * vienen de extra.mapTileUrl; el valor por defecto (OSM público) es solo para desarrollo.
 * Al tocar el mapa se devuelve el punto con onPick.
 */
const TILE = (Constants.expoConfig?.extra as any)?.mapTileUrl ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export function MapWeb({ center, markers = [], onPick, height = 240 }: { center: { lat: number; lng: number }; markers?: MapMarker[]; onPick?: (p: { lat: number; lng: number }) => void; height?: number }) {
  const ref = useRef<WebView>(null);
  const html = useMemo(
    () => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>html,body,#m{height:100%;margin:0}</style></head><body><div id="m"></div><script>
var map=L.map('m').setView([${center.lat},${center.lng}],15);
L.tileLayer(${JSON.stringify(TILE)},{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(map);
var layer=L.layerGroup().addTo(map);
window.setMarkers=function(list){layer.clearLayers();list.forEach(function(m){L.circleMarker([m.lat,m.lng],{radius:9,color:'#fff',weight:2,fillColor:m.color||'#11613f',fillOpacity:1}).bindTooltip(m.label).addTo(layer);});};
map.on('click',function(e){window.ReactNativeWebView.postMessage(JSON.stringify({lat:e.latlng.lat,lng:e.latlng.lng}));});
</script></body></html>`,
    // El HTML se crea una sola vez por centro inicial; los marcadores se actualizan sin recargar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => {
    ref.current?.injectJavaScript(`window.setMarkers && window.setMarkers(${JSON.stringify(markers)}); true;`);
  }, [JSON.stringify(markers)]);
  return (
    <View style={{ height, borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: '#e2e6e3' }}>
      <WebView
        ref={ref}
        originWhitelist={['*']}
        source={{ html }}
        onLoadEnd={() => ref.current?.injectJavaScript(`window.setMarkers && window.setMarkers(${JSON.stringify(markers)}); true;`)}
        onMessage={(e) => {
          try {
            onPick?.(JSON.parse(e.nativeEvent.data));
          } catch {
            /* ignorar */
          }
        }}
      />
    </View>
  );
}
