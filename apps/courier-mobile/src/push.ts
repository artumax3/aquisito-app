import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { api } from './api';

/**
 * Registro del token de notificaciones push con permiso explícito. Requiere compilación nativa,
 * dispositivo físico y un proyecto EAS (extra.eas.projectId). Si falta algo, no registra nada y
 * devuelve el motivo: las notificaciones internas de la app siguen funcionando.
 */
export async function registerPush(): Promise<string> {
  if (!Device.isDevice) return 'Push no disponible en emulador';
  const projectId = (Constants.expoConfig?.extra as any)?.eas?.projectId ?? (Constants as any).easConfig?.projectId;
  if (!projectId) return 'Push pendiente: falta configurar el proyecto EAS';
  const current = await Notifications.getPermissionsAsync();
  const perm = current.granted ? current : await Notifications.requestPermissionsAsync();
  if (!perm.granted) return 'Permiso de notificaciones denegado';
  if (Platform.OS === 'android') {
    // Canal sin contenido sensible: el servidor envía textos genéricos para la pantalla bloqueada.
    await Notifications.setNotificationChannelAsync('pedidos', { name: 'Pedidos', importance: Notifications.AndroidImportance.HIGH, lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE });
  }
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  const r = await api.call('pushToken', { body: { token, platform: Platform.OS === 'ios' ? 'ios' : 'android' } });
  return r.pushConfigured ? 'Notificaciones activadas' : 'Token registrado; el envío push aún no está configurado en el servidor';
}
