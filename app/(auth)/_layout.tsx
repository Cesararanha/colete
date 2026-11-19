import { Stack } from 'expo-router';
import { Platform } from 'react-native';

export default function AuthLayout() {
  return (
    <Stack
      {...(Platform.OS === 'web' ? { activityEnabled: false } : {})}
      screenOptions={{ headerShown: false }}
    />
  );
}
