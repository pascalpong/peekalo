import Feather from '@expo/vector-icons/Feather';
import { Tabs, usePathname } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../../components/ui';

export default function TabsLayout() {
  const { bottom } = useSafeAreaInsets();
  const cameraActive = usePathname() === '/';
  return <Tabs initialRouteName="index" screenOptions={{
    headerShown: false,
    tabBarActiveTintColor: cameraActive ? '#fff' : colors.ink,
    tabBarInactiveTintColor: cameraActive ? '#FFFFFFCC' : colors.muted,
    tabBarStyle: { position: cameraActive ? 'absolute' : 'relative', backgroundColor: 'transparent', borderTopWidth: 0, elevation: 0, height: 76 + bottom, paddingBottom: bottom, paddingTop: 9 },
    tabBarBackground: () => <View pointerEvents="none" style={[styles.barBackground, cameraActive && styles.cameraBarBackground]} />,
    tabBarLabelStyle: { fontSize: 10, fontWeight: '600', paddingTop: 3 },
    sceneStyle: { backgroundColor: colors.paper },
  }}>
    <Tabs.Screen name="inbox" options={{ title: 'Inbox', tabBarItemStyle: styles.sideTab, tabBarIcon: ({ color, size }) => <Feather name="message-circle" size={size} color={color} /> }} />
    <Tabs.Screen name="index" options={{
      title: 'Camera',
      tabBarAccessibilityLabel: 'Camera, open the in-app camera',
      tabBarIconStyle: { width: 68, height: 52 },
      tabBarLabelStyle: { fontSize: 10, fontWeight: '700', paddingTop: 3 },
      tabBarIcon: ({ focused }) => <View style={[styles.cameraButton, focused && styles.cameraSelected]}>
        <Feather name="camera" size={29} color={colors.ink} />
      </View>,
    }} />
    <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarItemStyle: styles.sideTab, tabBarIcon: ({ color, size }) => <Feather name="user" size={size} color={color} /> }} />
  </Tabs>;
}

const styles = StyleSheet.create({
  barBackground: { ...StyleSheet.absoluteFillObject, top: 28, backgroundColor: colors.paper, borderTopWidth: 1, borderTopColor: colors.line },
  cameraBarBackground: { backgroundColor: '#10181288', borderTopColor: '#FFFFFF30' },
  sideTab: { transform: [{ translateY: 14 }] },
  cameraButton: {
    width: 62, height: 62, borderRadius: 31, backgroundColor: colors.lime,
    borderWidth: 4, borderColor: colors.paper, alignItems: 'center', justifyContent: 'center',
    marginTop: -18, shadowColor: colors.ink, shadowOpacity: 0.13, shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 }, elevation: 4,
  },
  cameraSelected: { backgroundColor: '#C8EE7E' },
});
