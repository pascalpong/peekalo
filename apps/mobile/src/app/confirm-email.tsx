import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { cancelEmailConfirmation, completeEmailConfirmation, emailConfirmationRevision, subscribeEmailConfirmation } from '../lib/auth-confirmation';
import { SharingError } from '../lib/sharing-client';
import { colors, Screen, tokens } from '../components/ui';

export default function ConfirmEmailScreen() {
  const [stage, setStage] = useState<'checking' | 'done' | 'invalid'>('checking');
  const [error, setError] = useState('');
  const operation = useRef<AbortController | null>(null);
  const attempt = useRef(0);
  useFocusEffect(useCallback(() => {
    let active = true;
    const start = () => {
      operation.current?.abort();
      const controller = new AbortController();
      operation.current = controller;
      attempt.current = emailConfirmationRevision();
      setStage('checking'); setError('');
      void completeEmailConfirmation(attempt.current, controller.signal).then(() => {
        if (active && !controller.signal.aborted) setStage('done');
      }, failure => {
        if (active && !controller.signal.aborted) {
          setStage('invalid');
          setError(failure instanceof SharingError ? failure.message : 'This confirmation link is unavailable. Request another email from Sign in.');
        }
      });
    };
    const unsubscribe = subscribeEmailConfirmation(start);
    start();
    return () => { active = false; unsubscribe(); operation.current?.abort(); cancelEmailConfirmation(attempt.current); };
  }, []));
  return <Screen bottomSafe>
    <Text style={styles.title}>{stage === 'done' ? 'Email confirmed.' : 'Your email.'}</Text>
    {stage === 'checking' && <View style={styles.loading}><ActivityIndicator color={colors.text} /><Text style={styles.body}>Checking your confirmation link…</Text></View>}
    {stage === 'done' && <Text accessibilityLiveRegion="polite" style={styles.body}>Return to Profile and sign in to choose your username. Your existing sign-in stays as it was.</Text>}
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    <Pressable accessibilityRole="button" onPress={() => { operation.current?.abort(); cancelEmailConfirmation(attempt.current); router.replace('/(tabs)/profile'); }} style={styles.action}><Text style={styles.actionText}>Return to Profile</Text></Pressable>
  </Screen>;
}
const styles = StyleSheet.create({
  title: { fontFamily: tokens.font.display, fontSize: 38, color: colors.text, marginTop: 24, marginBottom: 24 },
  body: { color: colors.muted, fontSize: 15, lineHeight: 23, flexShrink: 1 },
  loading: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  error: { backgroundColor: colors.dangerSurface, color: colors.danger, padding: 16, borderRadius: 14, lineHeight: 22 },
  action: { backgroundColor: colors.accent, borderRadius: 28, padding: 18, minHeight: 54, alignItems: 'center', marginTop: 24 },
  actionText: { color: colors.onAccent, fontSize: 14, fontWeight: '600' },
});
