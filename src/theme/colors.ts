export type ThemeMode = 'light' | 'dark';

export type ThemeColors = {
  background: string;
  surface: string;
  surfaceStrong: string;
  text: string;
  textMuted: string;
  primary: string;
  onPrimary: string;
  border: string;
  focus: string;
  positive: string;
};

export const colors: Record<ThemeMode, ThemeColors> = {
  light: {
    background: '#F4F8F5',
    surface: '#FFFFFF',
    surfaceStrong: '#E5F1E9',
    text: '#10261A',
    textMuted: '#40594A',
    primary: '#0A6335',
    onPrimary: '#FFFFFF',
    border: '#718478',
    focus: '#A33D00',
    positive: '#075C31',
  },
  dark: {
    background: '#07150D',
    surface: '#10251A',
    surfaceStrong: '#193526',
    text: '#F2FAF5',
    textMuted: '#B7CABD',
    primary: '#79E5A9',
    onPrimary: '#062C17',
    border: '#849A8B',
    focus: '#FFB37D',
    positive: '#90EEB7',
  },
};

const linearize = (channel: number) => {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
};

export const relativeLuminance = (hex: string) => {
  const channels = hex
    .replace('#', '')
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16));

  if (!channels || channels.length !== 3 || channels.some(Number.isNaN)) {
    throw new Error(`Invalid RGB color: ${hex}`);
  }

  const [red = 0, green = 0, blue = 0] = channels.map(linearize);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};

export const contrastRatio = (foreground: string, background: string) => {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
};
