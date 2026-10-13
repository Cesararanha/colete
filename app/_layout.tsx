import { Barlow_400Regular } from '@expo-google-fonts/barlow/400Regular';
import { Barlow_600SemiBold } from '@expo-google-fonts/barlow/600SemiBold';
import { Barlow_700Bold } from '@expo-google-fonts/barlow/700Bold';
import { BarlowCondensed_700Bold } from '@expo-google-fonts/barlow-condensed/700Bold';
import { FontDisplay, useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import Head from 'expo-router/head';
import { StatusBar } from 'expo-status-bar';
import { QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SessionLifecycle } from '@/features/auth/SessionLifecycle';
import { pt } from '@/lib/i18n/pt';
import { queryClient } from '@/lib/query-client';
import { ThemeProvider, useTheme } from '@/theme/ThemeProvider';
import { fontFamilies } from '@/theme/typography';

// Only these four bundled files (docs/29 §4). Rendering never waits for them:
// typography falls back to the system font until each face swaps in.
const fontMap = {
  [fontFamilies.regular]: { uri: Barlow_400Regular, display: FontDisplay.SWAP },
  [fontFamilies.semibold]: { uri: Barlow_600SemiBold, display: FontDisplay.SWAP },
  [fontFamilies.bold]: { uri: Barlow_700Bold, display: FontDisplay.SWAP },
  [fontFamilies.condensed]: { uri: BarlowCondensed_700Bold, display: FontDisplay.SWAP },
};

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
  useFonts(fontMap);

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
