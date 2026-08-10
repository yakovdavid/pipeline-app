import { memo, useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { PipelineColorScheme } from '@/constants/pipeline-colors';
import { STRUCTURAL_STOP_THRESHOLD } from '@/constants/thresholds';
import { usePipelineTheme } from '@/contexts/theme-context';
import type { AssetType } from '@/types/asset';

export type Stock = {
  ticker: string;
  assetType: AssetType;
  price: number;
  // Nullable: Yahoo Finance doesn't always publish these for every
  // instrument, so a missing value degrades the UI instead of failing it.
  sma50: number | null;
  sma200: number | null;
  // Anomaly News Fetcher output: set when today's move is 4%+ and the
  // backend found explanatory headlines. Not rendered on the card itself
  // (see report-formatters.ts) — just carried through so exports can use it.
  anomalyReport: string | null;
  // 52-week high / drawdown from the backend. Not rendered here: the
  // Quality-layer drawdown review styling is a Portfolio-only concept (see
  // PortfolioStockRow in index.tsx) — Ambush Radar has no "layer"/category
  // at all, so this pair is carried through for type-compatibility with
  // StockQuote only, unused by this component's own UI.
  high52: number | null;
  drawdownPct: number | null;
};

export type StockCardProps = {
  stock: Stock;
  onDelete: (ticker: string) => void;
};

type StockCardStyles = ReturnType<typeof createStyles>;

// Wrapped in memo() so a price/SMA update on one ticker doesn't re-render
// every other card in the list — the ambush.tsx list already keeps
// unaffected Stock objects referentially stable on every state update
// (add/delete/refresh only replace the entries that actually changed), so
// this comparison is meaningful, not a no-op. memo() only shallow-compares
// props, not context, so this still re-renders correctly on a theme toggle
// (usePipelineTheme() below is a context read, unaffected by memo).
export const StockCard = memo(function StockCard({ stock, onDelete }: StockCardProps) {
  const { colors, isDarkMode } = usePipelineTheme();
  const styles = useMemo(() => createStyles(colors, isDarkMode), [colors, isDarkMode]);

  const { ticker, assetType, price, sma50, sma200 } = stock;

  // ETFs are judged against the longer 200-day trend; individual stocks
  // keep the original 50-day mean-reversion rule.
  const relevantSma = assetType === 'ETF' ? sma200 : sma50;
  const hasTrendData = relevantSma !== null;
  const isBullish = hasTrendData && price > relevantSma;

  const isNearStructuralStop =
    assetType === 'ETF' && sma200 !== null && price <= sma200 * STRUCTURAL_STOP_THRESHOLD;

  return (
    <View style={styles.card}>
      {isNearStructuralStop && (
        <View style={styles.warningBanner}>
          <Text style={styles.warningBannerText}>
            ⚠ Structural Stop Warning: within 2% of SMA200 support
          </Text>
        </View>
      )}

      <View style={styles.row}>
        <View style={styles.tickerGroup}>
          <Text style={styles.ticker}>{ticker}</Text>
          <View style={styles.assetTypeBadge}>
            <Text style={styles.assetTypeBadgeText}>{assetType}</Text>
          </View>
        </View>
        <View style={styles.priceGroup}>
          <Text style={styles.price}>${price.toFixed(2)}</Text>
          <TouchableOpacity
            onPress={() => onDelete(ticker)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel={`Remove ${ticker} from watchlist`}>
            <Text style={styles.deleteButtonText}>✕</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={[styles.row, styles.bottomRow]}>
        <MomentumBar
          price={price}
          sma50={sma50}
          sma200={sma200}
          isBullish={isBullish}
          colors={colors}
          styles={styles}
        />
        <View
          style={[
            styles.badge,
            {
              backgroundColor: !hasTrendData
                ? colors.textSecondary
                : isBullish
                  ? colors.bullish
                  : colors.bearish,
            },
          ]}>
          <Text style={styles.badgeText}>
            {!hasTrendData ? 'N/A' : isBullish ? 'Bullish' : 'Bearish'}
          </Text>
        </View>
      </View>
    </View>
  );
});

type MomentumBarProps = {
  price: number;
  sma50: number | null;
  sma200: number | null;
  isBullish: boolean;
  colors: PipelineColorScheme;
  styles: StockCardStyles;
};

// Minimalist visual showing where the current price sits relative to the
// SMA50/SMA200 range, replacing the old plain "SMA 50: $X" text line.
// A private sub-component of StockCard (not exported/reused elsewhere), so
// it takes colors/styles as props from its parent's already-memoized theme
// read rather than calling usePipelineTheme() again itself.
function MomentumBar({ price, sma50, sma200, isBullish, colors, styles }: MomentumBarProps) {
  if (sma50 === null || sma200 === null) {
    return <Text style={styles.momentumFallbackText}>Insufficient SMA data</Text>;
  }

  // The dot's position on the track is intentionally still dynamic — it
  // maps to where price actually sits between the lower and higher of the
  // two SMAs, whichever that happens to be this render.
  const low = Math.min(sma50, sma200);
  const high = Math.max(sma50, sma200);
  const range = high - low;
  const rawPosition = range > 0 ? (price - low) / range : 0.5;
  const markerPosition = Math.min(1, Math.max(0, rawPosition));
  const markerColor = isBullish ? colors.bullish : colors.bearish;

  return (
    <View style={styles.momentumContainer}>
      <View style={styles.momentumTrack}>
        <View
          style={[
            styles.momentumMarker,
            { left: `${markerPosition * 100}%`, backgroundColor: markerColor },
          ]}
        />
      </View>
      {/* Static layout, deliberately NOT tied to which of sma50/sma200 is
          numerically higher (unlike the dot above): SMA50 always reads on
          the left and SMA200 always on the right, so the row doesn't swap
          positions out from under a user scanning the list — a text swap
          that tracked the dot used to make quick visual scanning unreliable. */}
      <View style={styles.momentumLabelRow}>
        <Text style={styles.momentumLabelText}>SMA50 ${sma50.toFixed(2)}</Text>
        <Text style={styles.momentumLabelText}>SMA200 ${sma200.toFixed(2)}</Text>
      </View>
    </View>
  );
}

// A factory (not a module-level StyleSheet.create) so it can be re-derived
// whenever the active theme changes — StyleSheet.create bakes in whatever
// color values it's given at the moment it's called, so a module-level call
// would freeze in whichever theme happened to be active on first import and
// never update. Called from a useMemo(() => createStyles(colors, isDarkMode),
// [colors, isDarkMode]) above, so it only actually re-runs on a real
// theme change, not on every render.
function createStyles(colors: PipelineColorScheme, isDarkMode: boolean) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.cardBackground,
      borderRadius: 12,
      paddingHorizontal: 16,
      paddingVertical: 14,
      marginHorizontal: 16,
      marginBottom: 12,
      overflow: 'hidden',
      // Light theme's white cards need a subtle shadow to read as
      // distinct/elevated against the light-gray page background; dark
      // theme's cards already contrast against the near-black background
      // without one, so the shadow is skipped there rather than rendering
      // an invisible-but-still-computed one.
      ...(isDarkMode
        ? null
        : {
            shadowColor: '#000',
            shadowOpacity: 0.08,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 2 },
            elevation: 2,
          }),
    },
    warningBanner: {
      backgroundColor: colors.warning,
      marginHorizontal: -16,
      marginTop: -14,
      marginBottom: 10,
      paddingHorizontal: 16,
      paddingVertical: 6,
    },
    warningBannerText: {
      color: colors.warningText,
      fontSize: 12,
      fontWeight: '700',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    bottomRow: {
      marginTop: 12,
      alignItems: 'flex-start',
    },
    tickerGroup: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    ticker: {
      color: colors.textPrimary,
      fontSize: 18,
      fontWeight: '700',
    },
    assetTypeBadge: {
      backgroundColor: colors.background,
      borderRadius: 4,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    assetTypeBadgeText: {
      color: colors.textSecondary,
      fontSize: 10,
      fontWeight: '700',
    },
    priceGroup: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    price: {
      color: colors.textPrimary,
      fontSize: 18,
      fontWeight: '600',
    },
    deleteButtonText: {
      color: colors.bearish,
      fontSize: 16,
      fontWeight: '700',
    },
    badge: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 6,
      marginLeft: 12,
    },
    badgeText: {
      color: colors.textPrimary,
      fontSize: 12,
      fontWeight: '700',
    },
    momentumContainer: {
      flex: 1,
    },
    momentumFallbackText: {
      flex: 1,
      color: colors.textSecondary,
      fontSize: 13,
    },
    momentumTrack: {
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.background,
      justifyContent: 'center',
    },
    momentumMarker: {
      position: 'absolute',
      width: 12,
      height: 12,
      borderRadius: 6,
      marginLeft: -6,
    },
    momentumLabelRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: 6,
    },
    momentumLabelText: {
      color: colors.textSecondary,
      fontSize: 11,
    },
  });
}
