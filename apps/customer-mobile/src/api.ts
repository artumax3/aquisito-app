import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { createClient } from '@aquisito/api-client';

/** Token de sesión en almacenamiento seguro del sistema (Keystore/Keychain), nunca en AsyncStorage. */
const KEY = 'aq_session_token';
export const tokenStore = {
  get: () => SecureStore.getItemAsync(KEY),
  set: (t: string) => SecureStore.setItemAsync(KEY, t),
  clear: () => SecureStore.deleteItemAsync(KEY),
};

export const API_URL: string = process.env.EXPO_PUBLIC_API_URL ?? (Constants.expoConfig?.extra as any)?.apiUrl ?? 'http://10.0.2.2:4000';
export const api = createClient({ baseUrl: API_URL, mode: 'bearer', getToken: tokenStore.get });
