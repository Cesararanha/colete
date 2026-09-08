import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useColorScheme } from 'react-native';

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

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const backgroundColor = colors[mode].background;
    document.documentElement.style.backgroundColor = backgroundColor;
    document.documentElement.style.colorScheme = mode;
    document.body.style.backgroundColor = backgroundColor;
    const root = document.getElementById('root');
    if (root !== null) root.style.backgroundColor = backgroundColor;
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
