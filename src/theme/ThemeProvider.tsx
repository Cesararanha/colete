import { createContext, type PropsWithChildren, useContext } from 'react';

import { colors, type ThemeColors, type ThemeMode } from './colors';

type ThemeContextValue = {
  colors: ThemeColors;
  mode: ThemeMode;
};

// Human decision of 14/10/2026 (docs/29 §0): the interface runs in the dark
// theme only, whatever the system preference, and offers no theme switch. The
// light tokens stay in colors.ts; docs/15 is updated by a later docs slice.
const mode: ThemeMode = 'dark';
const value: ThemeContextValue = { colors: colors[mode], mode };

const ThemeContext = createContext<ThemeContextValue | null>(null);

// On the web, +html ships <html data-theme="dark"> and dark-only global CSS.
export function ThemeProvider({ children }: PropsWithChildren) {
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);

  if (!context) {
    throw new Error('useTheme must be used inside ThemeProvider');
  }

  return context;
}
