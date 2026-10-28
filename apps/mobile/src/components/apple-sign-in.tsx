import * as AppleAuthentication from 'expo-apple-authentication';
import { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';

export function AppleSignIn({ disabled, onPress }: { disabled: boolean; onPress: () => void }) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let active = true;
    if (Platform.OS === 'ios') void AppleAuthentication.isAvailableAsync().then(value => { if (active) setAvailable(value); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  if (!available) return null;
  return <View pointerEvents={disabled ? 'none' : 'auto'} accessibilityElementsHidden={disabled} style={{ opacity: disabled ? 0.5 : 1 }}>
    <AppleAuthentication.AppleAuthenticationButton
      buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
      buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
      cornerRadius={28} style={{ width: '100%', height: 56 }} onPress={onPress} />
  </View>;
}
