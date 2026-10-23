import { Stack, useFocusEffect, router } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { cancelPasswordRecovery, passwordRecoveryRevision, preparePasswordRecovery, subscribePasswordRecovery, updateRecoveredPassword } from '../lib/auth-recovery';
import { SharingError } from '../lib/sharing-client';
import { colors, Screen, tokens } from '../components/ui';

export default function ResetPasswordScreen() {
  const [stage, setStage] = useState<'checking' | 'ready' | 'saving' | 'done' | 'invalid'>('checking');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const operation = useRef<AbortController | null>(null);
  const attempt = useRef(0);
  const saving = useRef(false);

  useFocusEffect(useCallback(() => {
    let active = true;
    const start = () => {
      operation.current?.abort();
      const controller = new AbortController();
      operation.current = controller;
      const id = passwordRecoveryRevision();
      attempt.current = id;
      saving.current = false;
      setPassword(''); setConfirmation(''); setError(''); setStage('checking');
      void preparePasswordRecovery(id, controller.signal).then(() => {
        if (active && !controller.signal.aborted) setStage('ready');
      }, failure => {
        if (active && !controller.signal.aborted) {
          setStage('invalid');
          setError(failure instanceof SharingError ? failure.message : 'This reset link is unavailable. Request a new email from Sign in.');
        }
      });
    };
    const unsubscribe = subscribePasswordRecovery(start);
    const back = BackHandler.addEventListener('hardwareBackPress', () => saving.current);
    start();
    return () => {
      active = false;
      unsubscribe();
      back.remove();
      operation.current?.abort();
      cancelPasswordRecovery(attempt.current);
      saving.current = false;
    };
  }, []));

  const leave = () => {
    if (saving.current) return;
    operation.current?.abort();
    cancelPasswordRecovery(attempt.current);
    setPassword(''); setConfirmation('');
    router.replace('/(tabs)/profile');
  };
  const save = () => {
    if (saving.current || stage !== 'ready') return;
    if (password.length < 8) { setError('Use at least 8 characters for your new password.'); return; }
    if (password !== confirmation) { setError('Your passwords do not match.'); return; }
    const controller = operation.current;
    if (!controller || controller.signal.aborted) return;
    saving.current = true;
    setError(''); setStage('saving');
    void updateRecoveredPassword(attempt.current, password, controller.signal).then(() => {
      if (!controller.signal.aborted) {
        setPassword(''); setConfirmation(''); setStage('done');
      }
    }, failure => {
      if (!controller.signal.aborted) {
        setStage(failure instanceof SharingError && failure.code === 'invalid_recovery' ? 'invalid' : 'ready');
        setError(failure instanceof SharingError ? failure.message : 'Your password could not be updated. Please try again.');
      }
    }).finally(() => { if (!controller.signal.aborted) saving.current = false; });
  };

  const disabled = stage !== 'ready' || password.length < 8 || !confirmation;
  return <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
    <Stack.Screen options={{ gestureEnabled: stage !== 'saving' }} />
    <Screen bottomSafe>
      <Text style={styles.title}>A fresh start.</Text>
      {stage === 'checking' && <View style={styles.loading}><ActivityIndicator color={colors.text} /><Text style={styles.body}>Checking your reset link… The free test server may take about a minute to wake up.</Text></View>}
      {(stage === 'ready' || stage === 'saving') && <View style={styles.form}>
        <Text style={styles.body}>Choose a new password with at least 8 characters.</Text>
        <TextInput accessibilityLabel="New password" style={styles.input} value={password} onChangeText={setPassword} placeholder="New password" placeholderTextColor={colors.muted} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="new-password" editable={stage === 'ready'} />
        <TextInput accessibilityLabel="Confirm new password" style={styles.input} value={confirmation} onChangeText={setConfirmation} placeholder="Confirm new password" placeholderTextColor={colors.muted} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="new-password" editable={stage === 'ready'} />
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={!!disabled} onPress={save} style={[styles.action, !!disabled && styles.dim]}><Text style={styles.actionText}>{stage === 'saving' ? 'Updating password…' : 'Update password'}</Text></Pressable>
      </View>}
      {stage === 'saving' && <Text accessibilityLiveRegion="polite" style={styles.body}>Updating your password. Please keep this screen open.</Text>}
      {stage === 'done' && <Text accessibilityLiveRegion="polite" style={styles.body}>Password updated. Sign in with your new password.</Text>}
      {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      <Pressable accessibilityRole="button" disabled={stage === 'saving'} accessibilityState={{ disabled: stage === 'saving' }} onPress={leave} style={[styles.action, styles.secondary, stage === 'saving' && styles.dim]}><Text style={styles.secondaryText}>{stage === 'done' || stage === 'invalid' ? 'Return to Profile' : 'Cancel password reset'}</Text></Pressable>
    </Screen>
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 }, title: { fontFamily: tokens.font.display, fontSize: 38, color: colors.text, marginTop: 24 },
  body: { color: colors.muted, fontSize: 15, lineHeight: 23, flexShrink: 1 },
  loading: { flexDirection: 'row', gap: 12, alignItems: 'center', marginVertical: 24 }, form: { gap: 16, marginVertical: 24 },
  input: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 14, minHeight: 52, padding: 16, color: colors.text, fontSize: 16 },
  action: { backgroundColor: colors.accent, borderRadius: 28, padding: 18, minHeight: 54, alignItems: 'center', marginTop: 16 },
  actionText: { color: colors.onAccent, fontSize: 14, fontWeight: '600' }, secondary: { backgroundColor: colors.surface }, secondaryText: { color: colors.text, fontSize: 14 }, dim: { opacity: 0.5 },
  error: { backgroundColor: colors.dangerSurface, color: colors.danger, padding: 16, borderRadius: 14, marginTop: 16, lineHeight: 22 },
});
