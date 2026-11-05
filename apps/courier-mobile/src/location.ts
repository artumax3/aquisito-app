import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { api } from './api';

/**
 * Ubicación del repartidor:
 *  - Primer plano: watchPositionAsync mientras la app está abierta y el repartidor disponible.
 *  - Segundo plano: tarea registrada con TaskManager + servicio en primer plano de Android
 *    (notificación persistente). REQUIERE compilación nativa (expo run:android / EAS) y prueba en
 *    dispositivo real; Expo Go y el bundle JS no demuestran esta capacidad. iOS puede pausar o
 *    limitar las actualizaciones; no se promete rastreo continuo con la app cerrada.
 * Cada envío incluye precisión y timestamp; el servidor descarta posiciones más antiguas.
 */
export const BG_TASK = 'aquisito-courier-location';

async function send(loc: Location.LocationObject) {
  await api.call('courierLocation', {
    body: { lat: loc.coords.latitude, lng: loc.coords.longitude, accuracyM: Math.min(10000, loc.coords.accuracy ?? 9999), recordedAt: new Date(loc.timestamp).toISOString() },
  });
}

TaskManager.defineTask(BG_TASK, async ({ data, error }) => {
  if (error) return;
  const locations = (data as { locations?: Location.LocationObject[] })?.locations ?? [];
  const last = locations[locations.length - 1];
  if (last) await send(last).catch(() => undefined);
});

export async function startForeground(onUpdate: (l: Location.LocationObject) => void, onError: (m: string) => void) {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') {
    onError('Sin permiso de ubicación no puedes recibir ofertas.');
    return null;
  }
  return Location.watchPositionAsync({ accuracy: Location.Accuracy.High, timeInterval: 15000, distanceInterval: 25 }, async (l) => {
    onUpdate(l);
    try {
      await send(l);
    } catch (e: any) {
      onError(e?.message ?? 'No se pudo enviar la ubicación');
    }
  });
}

export async function startBackground(): Promise<string> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return 'Permiso de ubicación denegado';
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== 'granted') return 'Sin permiso "Permitir siempre": solo se comparte con la app abierta';
  if (await Location.hasStartedLocationUpdatesAsync(BG_TASK)) return 'Ubicación en segundo plano activa';
  await Location.startLocationUpdatesAsync(BG_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: 20000,
    distanceInterval: 30,
    pausesUpdatesAutomatically: false,
    foregroundService: { notificationTitle: 'Aquisito: compartiendo ubicación', notificationBody: 'Solo mientras estás disponible o con una entrega activa.', notificationColor: '#0b3d2e' },
  });
  return 'Ubicación en segundo plano activa (verificar en dispositivo real)';
}

export async function stopBackground() {
  if (await Location.hasStartedLocationUpdatesAsync(BG_TASK)) await Location.stopLocationUpdatesAsync(BG_TASK);
}
