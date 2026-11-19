import { Stack } from 'expo-router';
import { Platform } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';

// Each tab keeps its own stack, so leaving a tab and coming back keeps its
// place. The scene paints the theme background: the navigator's default card
// colour is a fixed light grey that would show through in the dark theme.
export default function TabStackLayout() {
  const { colors } = useTheme();
  return (
    <Stack
      {...(Platform.OS === 'web' ? { activityEnabled: false } : {})}
      screenOptions={{ contentStyle: { backgroundColor: colors.background }, headerShown: false }}
    />
  );
}
