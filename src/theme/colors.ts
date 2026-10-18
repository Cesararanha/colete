export type ThemeMode = 'light' | 'dark';

/**
 * Placar premium tokens (docs/29). Areas separate by layer, not by outline:
 * background → surface → surfaceRaised. The only outline is fieldBorder, on
 * form fields. Scoreboard tokens are identical in both themes.
 */
export type ThemeColors = {
  background: string;
  surface: string;
  surfaceRaised: string;
  scoreboard: string;
  scoreTileTop: string;
  scoreTileBottom: string;
  digit: string;
  digitDim: string;
  brandBand: string;
  onBand: string;
  onBandMuted: string;
  bandRaised: string;
  text: string;
  textMuted: string;
  primary: string;
  onPrimary: string;
  indicator: string;
  link: string;
  fieldBorder: string;
  focus: string;
  focusOnBand: string;
  positive: string;
  warning: string;
  critical: string;
  info: string;
  /** Prévia aprovada (PR G): chip and avatar fills, one per state tone. */
  positiveSoft: string;
  warningSoft: string;
  infoSoft: string;
  criticalSoft: string;
  primarySoft: string;
  /** The fifth avatar tone; never a state. */
  accent: string;
  accentSoft: string;
  /** The neutral avatar tone. */
  avatar: string;
  /** Secondary text brighter than textMuted: times, counts, descriptions. */
  textSoft: string;
  /** Text on a filled positive or warning control (approve, pending counter). */
  onPositive: string;
  onWarning: string;
  /** The empty part of an occupancy bar. */
  track: string;
  /** The hairline between the rows of one card. */
  divider: string;
};

const scoreboard = {
  scoreboard: '#050A14',
  scoreTileTop: '#142039',
  scoreTileBottom: '#0F182C',
  digit: '#FFB940',
  digitDim: '#7E8AA5',
} as const;

export const colors: Record<ThemeMode, ThemeColors> = {
  light: {
    background: '#EEF1F6',
    surface: '#F7F8FB',
    surfaceRaised: '#FFFFFF',
    ...scoreboard,
    brandBand: '#14224A',
    onBand: '#FFFFFF',
    onBandMuted: '#C9D0DE',
    bandRaised: '#22336A',
    text: '#0D1630',
    textMuted: '#4A556E',
    primary: '#14224A',
    onPrimary: '#FFFFFF',
    indicator: '#14224A',
    link: '#14224A',
    fieldBorder: '#7A859C',
    focus: '#14224A',
    focusOnBand: '#FFFFFF',
    positive: '#1D6B43',
    warning: '#9A4A00',
    critical: '#B3202A',
    info: '#2B4FB8',
    positiveSoft: '#DFF1E6',
    warningSoft: '#FBE8D9',
    infoSoft: '#E1E8FB',
    criticalSoft: '#FBE1E2',
    primarySoft: '#E3E7F2',
    accent: '#9C2A5B',
    accentSoft: '#F8E1EB',
    avatar: '#D6DCEB',
    textSoft: '#2A3550',
    onPositive: '#FFFFFF',
    onWarning: '#FFFFFF',
    track: '#D9DEE8',
    divider: '#DDE2EB',
  },
  dark: {
    background: '#0A1120',
    surface: '#111A2E',
    surfaceRaised: '#18233B',
    ...scoreboard,
    brandBand: '#0A1120',
    onBand: '#F1F2F4',
    onBandMuted: '#A8B2C6',
    bandRaised: '#18233B',
    text: '#F1F2F4',
    textMuted: '#A8B2C6',
    primary: '#FFB940',
    onPrimary: '#1A1203',
    indicator: '#FFB940',
    link: '#F1F2F4',
    fieldBorder: '#6E7B98',
    focus: '#F1F2F4',
    focusOnBand: '#F1F2F4',
    positive: '#7CD3A0',
    warning: '#FFA46B',
    critical: '#FF9C96',
    info: '#9DB6FF',
    positiveSoft: '#14291F',
    warningSoft: '#33231A',
    infoSoft: '#1B2647',
    criticalSoft: '#3A1D1F',
    primarySoft: '#3A2C0E',
    accent: '#F2A7C3',
    accentSoft: '#3A1F2C',
    avatar: '#2B3A63',
    textSoft: '#D5DAE4',
    onPositive: '#0A1120',
    onWarning: '#1A1203',
    track: '#22304D',
    divider: '#1E2A44',
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
