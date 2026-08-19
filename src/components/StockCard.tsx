import { memo, useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { MomentumBar } from '@/components/MomentumBar';
import { TrendBadges } from '@/components/TrendBadges';
import { assetTypeLabel } from '@/constants/labels';
import type { PipelineColorScheme } from '@/constants/pipeline-colors';
import { STRUCTURAL_STOP_THRESHOLD } from '@/constants/thresholds';
import { usePipelineLanguage, type Language } from '@/contexts/language-context';
import { usePipelineTheme } from '@/contexts/theme-context';
import type { AssetType, TrendLabel } from '@/types/asset';
import { formatUnitPrice } from '@/utils/currency';

export type Stock = {
  ticker: string;
  assetType: AssetType;
  // Multi-Currency engine: normalized to USD by the backend — used for the
  // structural-stop check below (also USD-normalized), never mixed with
  // localPrice.
  price: number;
  // The instrument's own actual local-currency value and the symbol to
  // display it with ('$' or '₪') — display-only.
  localPrice: number;
  currencySymbol: string;
  // Nullable: Yahoo Finance doesn't always publish these for every
  // instrument, so a missing value degrades the UI instead of failing it.
  sma50: number | null;
  sma200: number | null;
  // TREND CLASSIFICATION: two independent backend-computed signals — see
  // StockQuote's own field comments (services/api.ts) for the full
  // rationale. Rendered via the shared TrendBadges component below,
  // replacing the old single asset-type-dependent Bullish/Bearish badge.
  macroTrend: TrendLabel;
  tacticalMomentum: TrendLabel;
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

// Wrapped in memo() so a price/SMA update on one ticker doesn't re-render
// every other card in the list — the ambush.tsx list already keeps
// unaffected Stock objects referentially stable on every state update
// (add/delete/refresh only replace the entries that actually changed), so
// this comparison is meaningful, not a no-op. memo() only shallow-compares
// props, not context, so this still re-renders correctly on a theme toggle
// (usePipelineTheme() below is a context read, unaffected by memo).
export const StockCard = memo(function StockCard({ stock, onDelete }: StockCardProps) {
  const { colors, isDarkMode } = usePipelineTheme();
  // ROBUST LANGUAGE CONTEXT: a plain context read (like usePipelineTheme()
  // above), unaffected by this component's own memo() — a language switch
  // re-renders this card, and its translated text via t(), immediately, no
  // app restart required.
  const { language, t } = usePipelineLanguage();
  const styles = useMemo(() => createStyles(colors, isDarkMode, language), [colors, isDarkMode, language]);

  const {
    ticker,
    assetType,
    price,
    localPrice,
    currencySymbol,
    sma50,
    sma200,
    macroTrend,
    tacticalMomentum,
  } = stock;

  const isNearStructuralStop =
    assetType === 'ETF' && sma200 !== null && price <= sma200 * STRUCTURAL_STOP_THRESHOLD;

  // TASE AGOROT DISPLAY: the current UNIT price — see formatUnitPrice.
  const agorotSuffix = t('ag');
  const priceDisplay = formatUnitPrice(ticker, localPrice, currencySymbol, agorotSuffix);

  return (
    <View style={styles.card}>
      {isNearStructuralStop && (
        <View style={styles.warningBanner}>
          <Text style={styles.warningBannerText}>{t('structuralStopWarning')}</Text>
        </View>
      )}

      <View style={styles.row}>
        <View style={styles.tickerGroup}>
          {/* Ticker symbol: always LTR, regardless of app language — it's
              an identifier, not translatable text. */}
          <Text style={styles.ticker}>{ticker}</Text>
          <View style={styles.assetTypeBadge}>
            <Text style={styles.assetTypeBadgeText}>{assetTypeLabel(t, assetType)}</Text>
          </View>
        </View>
        <View style={styles.priceGroup}>
          {/* MULTI-CURRENCY DISPLAY: the instrument's own local-currency
              value (e.g. ₪13.48), never the USD-normalized `price` used for
              math — see the Stock type above. TASE AGOROT DISPLAY: for a
              ".TA" ticker this instead reads e.g. "3985 אג'" — see
              formatUnitPrice. Numeric, so left as LTR either way. */}
          <Text style={styles.price}>{priceDisplay}</Text>
          <TouchableOpacity
            onPress={() => onDelete(ticker)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel={`הסר את ${ticker} מרשימת המעקב`}>
            <Text style={styles.deleteButtonText}>✕</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Add SMA Visuals to Portfolio: this MomentumBar is the exact same
          shared component PortfolioStockRow (index.tsx) renders — see
          @/components/MomentumBar. */}
      <View style={styles.bottomRow}>
        <MomentumBar
          ticker={ticker}
          price={price}
          sma50={sma50}
          sma200={sma200}
          localPrice={localPrice}
          currencySymbol={currencySymbol}
          tacticalMomentum={tacticalMomentum}
        />
      </View>

      {/* Dashboard Trend Display: Macro Trend + Tactical Momentum, replacing
          the old single Bullish/Bearish badge — shared component, see
          @/components/TrendBadges. */}
      <TrendBadges macroTrend={macroTrend} tacticalMomentum={tacticalMomentum} />
    </View>
  );
});

// A factory (not a module-level StyleSheet.create) so it can be re-derived
// whenever the active theme OR language changes — StyleSheet.create bakes
// in whatever values it's given at the moment it's called, so a
// module-level call would freeze in whichever theme/language happened to be
// active on first import and never update. Called from a
// useMemo(() => createStyles(colors, isDarkMode, language), [colors,
// isDarkMode, language]) above, so it only actually re-runs on a real theme
// or language change, not on every render.
function createStyles(colors: PipelineColorScheme, isDarkMode: boolean, language: Language) {
  const isHebrew = language === 'he';

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
      // RTL/LTR LOCALIZATION: standard label text is right-aligned in
      // Hebrew, left-aligned in English; numeric values/ticker symbols
      // elsewhere are deliberately left at LTR regardless — see the
      // ticker/price styles below.
      textAlign: isHebrew ? 'right' : 'left',
      writingDirection: isHebrew ? 'rtl' : 'ltr',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    bottomRow: {
      flexDirection: 'row',
      marginTop: 12,
      alignItems: 'flex-start',
    },
    tickerGroup: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    ticker: {
      // Ticker symbols stay LTR regardless of app language — they're
      // identifiers, not translatable text.
      color: colors.textPrimary,
      fontSize: 18,
      fontWeight: '700',
      writingDirection: 'ltr',
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
      textAlign: isHebrew ? 'right' : 'left',
      writingDirection: isHebrew ? 'rtl' : 'ltr',
    },
    priceGroup: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    price: {
      // Numeric/currency value: kept LTR regardless of app language, same
      // as the ticker above — a currency symbol/Agorot suffix prefixing or
      // trailing a number doesn't change that.
      color: colors.textPrimary,
      fontSize: 18,
      fontWeight: '600',
      writingDirection: 'ltr',
    },
    deleteButtonText: {
      color: colors.bearish,
      fontSize: 16,
      fontWeight: '700',
    },
  });
}
