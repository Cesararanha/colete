import { Stack } from 'expo-router';
import Head from 'expo-router/head';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { pt } from '@/lib/i18n/pt';
import { ThemeProvider, useTheme } from '@/theme/ThemeProvider';

function ThemedRoutes() {
  const { mode } = useTheme();

  return (
    <>
      <Head>
        <title>{pt.app.name}</title>
      </Head>
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ThemedRoutes />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
