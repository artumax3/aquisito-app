import { ReactNode, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, TextInputProps, View } from 'react-native';
import { ApiError, NetworkError } from '@aquisito/api-client';
const tokens = require('@aquisito/config');

export const C = tokens.colors as Record<string, string>;

export function errorText(e: unknown) {
  if (e instanceof ApiError) return e.message;
  if (e instanceof NetworkError) return e.message;
  return 'Ocurrió un error inesperado';
}

export function Btn({ title, onPress, kind = 'primary', disabled }: { title: string; onPress: () => Promise<unknown> | void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bg = kind === 'primary' ? C.selva700 : kind === 'danger' ? C.achiote600 : C.selva100;
  const fg = kind === 'secondary' ? C.selva900 : '#fff';
  return (
    <View style={{ gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        disabled={busy || disabled}
        onPress={async () => {
          setBusy(true);
          setErr(null);
          try {
            await onPress();
          } catch (e) {
            setErr(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
        style={({ pressed }) => [s.btn, { backgroundColor: bg, opacity: busy || disabled ? 0.5 : pressed ? 0.85 : 1 }]}
      >
        {busy ? <ActivityIndicator color={fg} /> : <Text style={[s.btnText, { color: fg }]}>{title}</Text>}
      </Pressable>
      {err ? <Text style={s.error}>{err}</Text> : null}
    </View>
  );
}

export const Card = ({ children }: { children: ReactNode }) => <View style={s.card}>{children}</View>;
export const H = ({ children }: { children: ReactNode }) => <Text style={s.h}>{children}</Text>;
export const P = ({ children, muted }: { children: ReactNode; muted?: boolean }) => <Text style={[s.p, muted && { color: C.ink600 }]}>{children}</Text>;
export const Field = (p: TextInputProps & { label: string }) => (
  <View style={{ gap: 4 }}>
    <Text style={s.label}>{p.label}</Text>
    <TextInput placeholderTextColor="#646d69" {...p} style={s.input} />
  </View>
);
export const Badge = ({ text, tone = 'ok' }: { text: string; tone?: 'ok' | 'warn' | 'bad' | 'adult' }) => (
  <Text style={[s.badge, tone === 'warn' && { backgroundColor: '#fff4dc', color: '#8a4b06' }, tone === 'bad' && { backgroundColor: '#fdecec', color: C.danger }, tone === 'adult' && { backgroundColor: '#2b2b2b', color: '#fff' }]}>{text}</Text>
);
export const Banner = ({ text, tone = 'info' }: { text: string; tone?: 'info' | 'warn' | 'bad' }) => (
  <Text style={[s.banner, tone === 'warn' && { backgroundColor: '#fff4dc', color: '#8a4b06' }, tone === 'bad' && { backgroundColor: '#fdecec', color: C.danger }]}>{text}</Text>
);

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.surface },
  content: { padding: 16, gap: 12, paddingBottom: 96 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#e2e6e3', gap: 8 },
  h: { fontSize: 20, fontWeight: '800', color: C.ink900 },
  p: { fontSize: 15, color: C.ink900 },
  label: { fontWeight: '600', color: C.ink900 },
  input: { borderWidth: 1, borderColor: '#c9d0cc', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, backgroundColor: '#fff', color: C.ink900 },
  btn: { borderRadius: 10, paddingVertical: 13, paddingHorizontal: 16, alignItems: 'center', minHeight: 48, justifyContent: 'center' },
  btnText: { fontWeight: '700', fontSize: 16 },
  error: { color: C.danger, fontSize: 13 },
  badge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: C.selva100, color: C.selva900, fontWeight: '700', fontSize: 12, overflow: 'hidden' },
  banner: { padding: 10, borderRadius: 10, backgroundColor: '#e8efff', color: '#1e3a8a' },
  header: { backgroundColor: C.selva900, paddingTop: 44, paddingBottom: 12, paddingHorizontal: 16 },
  brand: { color: '#fff', fontSize: 22, fontWeight: '800' },
  tabbar: { flexDirection: 'row', borderTopWidth: 1, borderColor: '#e2e6e3', backgroundColor: '#fff' },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  legal: { borderWidth: 2, borderColor: '#1b1f1d', borderRadius: 8, padding: 8, fontWeight: '800' },
});
