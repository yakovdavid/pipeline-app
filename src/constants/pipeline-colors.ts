// Strict dark-mode palette for the Pipeline watchlist feature.
// Unlike the app-wide Colors in `theme.ts`, this palette does not adapt to
// the system color scheme: Pipeline's stock views are always dark.
export const PipelineColors = {
  background: '#121212',
  cardBackground: '#1E1E1E',
  textPrimary: '#FFFFFF',
  textSecondary: '#A0A0A0',
  bullish: '#00C853',
  bearish: '#D50000',
  core: '#1976D2',
  satellite: '#F57C00',
  quality: '#8E24AA',
  // Amber caution color: distinct from "bearish" (already-confirmed
  // downtrend) — used for "approaching a risk threshold" warnings.
  warning: '#FFA726',
  // Explicit review-alert red for the Quality-layer 52-week drawdown rule
  // (>= 15% off the high) — deliberately its own color, not reused from
  // "bearish", so this specific manual-review signal reads distinctly.
  reviewAlert: '#FF4444',
} as const;
