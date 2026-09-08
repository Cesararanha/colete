import { Manrope_400Regular } from '@expo-google-fonts/manrope/400Regular';
import { Manrope_600SemiBold } from '@expo-google-fonts/manrope/600SemiBold';
import { Manrope_800ExtraBold } from '@expo-google-fonts/manrope/800ExtraBold';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import Head from 'expo-router/head';
import { StatusBar } from 'expo-status-bar';
import { QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

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
  useFonts({ Manrope_400Regular, Manrope_600SemiBold, Manrope_800ExtraBold });

  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        <ThemeProvider>
          <ThemedRoutes />
        </ThemeProvider>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}
