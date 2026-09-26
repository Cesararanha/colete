import { Stack } from 'expo-router';
import Head from 'expo-router/head';
import { StatusBar } from 'expo-status-bar';
import { QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SessionLifecycle } from '@/features/auth/SessionLifecycle';
import { pt } from '@/lib/i18n/pt';
import { queryClient } from '@/lib/query-client';
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
    <QueryClientProvider client={queryClient}>
      <SessionLifecycle />
      <SafeAreaProvider>
        <ThemeProvider>
          <ThemedRoutes />
        </ThemeProvider>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}
