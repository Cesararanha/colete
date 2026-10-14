import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Platform, useColorScheme } from 'react-native';

import { colors, type ThemeColors, type ThemeMode } from './colors';

type ThemeContextValue = {
  colors: ThemeColors;
  mode: ThemeMode;
  toggleMode: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: PropsWithChildren) {
  const systemMode = useColorScheme();
  const [override, setOverride] = useState<ThemeMode | null>(null);
  const mode: ThemeMode = override ?? (systemMode === 'dark' ? 'dark' : 'light');

  // The web focus ring lives in +html's stylesheet; it follows the app theme,
  // which can differ from the system preference after the toggle.
  useEffect(() => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      document.documentElement.dataset['theme'] = mode;
    }
  }, [mode]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      colors: colors[mode],
      mode,
      toggleMode: () => setOverride((current) => ((current ?? mode) === 'dark' ? 'light' : 'dark')),
    }),
    [mode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);

  if (!context) {
    throw new Error('useTheme must be used inside ThemeProvider');
  }

  return context;
}
