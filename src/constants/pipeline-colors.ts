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
} as const;
