// Pipeline's own Light/Dark theme palettes, independent of the app-wide
// Colors in `theme.ts` (which follows the OS color scheme) — Pipeline has
// its own explicit toggle instead (see @/contexts/theme-context), persisted
// separately from the OS setting.
export type PipelineColorScheme = {
  background: string;
  cardBackground: string;
  textPrimary: string;
  textSecondary: string;
  bullish: string;
  bearish: string;
  core: string;
  satellite: string;
  quality: string;
  // Amber caution color: distinct from "bearish" (already-confirmed
  // downtrend) — used for "approaching a risk threshold" warnings.
  warning: string;
  // Fixed near-black text for content painted on top of `warning` (an
  // amber/orange surface), in BOTH themes — deliberately not derived from
  // `background`, since `background` flips light/dark with the theme but a
  // warning banner needs legible dark text regardless.
  warningText: string;
  // Explicit review-alert red for the Quality-layer 52-week drawdown rule
  // (>= 15% off the high) — deliberately its own color, not reused from
  // "bearish", so this specific manual-review signal reads distinctly.
  reviewAlert: string;
};

export const DarkPipelineColors: PipelineColorScheme = {
  background: '#121212',
  cardBackground: '#1E1E1E',
  textPrimary: '#FFFFFF',
  textSecondary: '#A0A0A0',
  bullish: '#00C853',
  bearish: '#D50000',
  core: '#1976D2',
  satellite: '#F57C00',
  quality: '#8E24AA',
  warning: '#FFA726',
  warningText: '#121212',
  reviewAlert: '#FF4444',
};

// Clean white/light-gray backgrounds, dark text, white cards (shadows are
// applied per-component via isDarkMode, not part of the color palette
// itself). Accent colors (bullish/bearish/core/satellite/quality) are
// deepened slightly from their dark-mode values to keep sufficient
// contrast against a white/light background.
export const LightPipelineColors: PipelineColorScheme = {
  background: '#F2F2F7',
  cardBackground: '#FFFFFF',
  textPrimary: '#1C1C1E',
  textSecondary: '#6E6E73',
  bullish: '#1B8A4B',
  bearish: '#C62828',
  core: '#1565C0',
  satellite: '#E65100',
  quality: '#7B1FA2',
  warning: '#FB8C00',
  warningText: '#1C1C1E',
  reviewAlert: '#D32F2F',
};
