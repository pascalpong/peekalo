import Feather from '@expo/vector-icons/Feather';
import { Tabs, usePathname } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, material, tokens } from '../../components/ui';

export default function TabsLayout() {
  const { bottom } = useSafeAreaInsets();
  const cameraActive = usePathname() === '/';
  return <Tabs initialRouteName="index" screenOptions={{
    headerShown: false,
    tabBarActiveTintColor: colors.text,
    tabBarInactiveTintColor: colors.muted,
    tabBarStyle: { position: cameraActive ? 'absolute' : 'relative', backgroundColor: 'transparent', borderTopWidth: 0, elevation: 0, height: 76 + bottom, paddingBottom: bottom, paddingTop: 6 },
    tabBarBackground: () => <View pointerEvents="none" style={[material.frosted, styles.barBackground, cameraActive && material.cameraChrome]} />,
    tabBarLabelStyle: { fontSize: 10, fontWeight: '600', paddingTop: 3 },
    sceneStyle: { backgroundColor: colors.background },
  }}>
    <Tabs.Screen name="inbox" options={{ title: 'Inbox', tabBarItemStyle: styles.sideTab, tabBarIcon: ({ color, size }) => <Feather name="message-circle" size={size} color={color} /> }} />
    <Tabs.Screen name="index" options={{
      title: 'Camera',
      tabBarAccessibilityLabel: 'Camera, open the in-app camera',
      tabBarIconStyle: { width: 48, height: 40 },
      tabBarLabelStyle: { fontSize: 10, fontWeight: '700', paddingTop: 3 },
      tabBarIcon: ({ focused }) => <View style={[styles.cameraButton, focused && styles.cameraSelected]}>
        <Feather name="camera" size={21} color={focused ? colors.onAccent : colors.text} />
      </View>,
    }} />
    <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarItemStyle: styles.sideTab, tabBarIcon: ({ color, size }) => <Feather name="user" size={size} color={color} /> }} />
  </Tabs>;
}

const styles = StyleSheet.create({
  barBackground: { ...StyleSheet.absoluteFillObject, left: 12, right: 12, top: 2, bottom: undefined, height: 68, borderRadius: tokens.radius.pill },
  sideTab: { paddingTop: 2 },
  cameraButton: {
    width: 42, height: 42, borderRadius: 21, backgroundColor: colors.elevated,
    borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center',
  },
  cameraSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
});
