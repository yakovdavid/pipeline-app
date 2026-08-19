import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { PipelineColorScheme } from '@/constants/pipeline-colors';
import { usePipelineLanguage, type Language } from '@/contexts/language-context';
import { usePipelineTheme } from '@/contexts/theme-context';
import type { TrendLabel } from '@/types/asset';
import { deriveLocalValue, formatUnitPrice } from '@/utils/currency';

export type MomentumBarProps = {
  ticker: string;
  // USD-normalized (Multi-Currency engine) — the SAME basis price/sma50/
  // sma200 must already share for the marker-position math below to be
  // meaningful.
  price: number;
  sma50: number | null;
  sma200: number | null;
  // The instrument's own local-currency price, for display only — see
  // formatUnitPrice/deriveLocalValue below.
  localPrice: number;
  currencySymbol: string;
  // Drives the marker dot's color. SMA50-based (the finer-grained
  // "tactical" signal) uniformly for every asset type now, replacing the
  // old asset-type-dependent split (SMA200 for ETFs, SMA50 for Stocks) —
  // both signals are shown explicitly and equally via the separate
  // TrendBadges component wherever this bar is used, so the marker no
  // longer needs to silently pick one on the asset's behalf.
  tacticalMomentum: TrendLabel;
};

// Add SMA Visuals to Portfolio: this is the EXACT SAME component the
// Ambush Radar StockCard and the Portfolio PortfolioStockRow (index.tsx)
// both render — not a lookalike copy — so the visual and behavior are
// guaranteed identical between the two screens. Fully self-contained
// (reads theme/language via context itself rather than taking colors/
// styles/t as props from its parent), which is what makes it safely
// reusable across two otherwise-unrelated screens.
export function MomentumBar({
  ticker,
  price,
  sma50,
  sma200,
  localPrice,
  currencySymbol,
  tacticalMomentum,
}: MomentumBarProps) {
  const { colors } = usePipelineTheme();
  const { language, t } = usePipelineLanguage();
  const styles = useMemo(() => createStyles(colors, language), [colors, language]);

  if (sma50 === null || sma200 === null) {
    return <Text style={styles.fallbackText}>{t('insufficientMomentumData')}</Text>;
  }

  // TASE AGOROT DISPLAY: sma50/sma200 are USD-normalized (same as price),
  // so they're first scaled onto localPrice's basis (see deriveLocalValue)
  // — exact, not an approximation, since the backend applies one identical
  // linear conversion to every price-like field for a given ticker — and
  // only then formatted, so a ".TA" ticker's moving averages show in
  // Agorot right alongside its current price, not mixed USD/Agorot.
  const agorotSuffix = t('ag');
  const localSma50 = deriveLocalValue(sma50, localPrice, price);
  const localSma200 = deriveLocalValue(sma200, localPrice, price);
  const sma50Display = formatUnitPrice(ticker, localSma50, currencySymbol, agorotSuffix);
  const sma200Display = formatUnitPrice(ticker, localSma200, currencySymbol, agorotSuffix);

  // The dot's position on the track is intentionally still dynamic — it
  // maps to where price actually sits between the lower and higher of the
  // two SMAs, whichever that happens to be this render.
  const low = Math.min(sma50, sma200);
  const high = Math.max(sma50, sma200);
  const range = high - low;
  const rawPosition = range > 0 ? (price - low) / range : 0.5;
  const markerPosition = Math.min(1, Math.max(0, rawPosition));
  const markerColor = tacticalMomentum === 'Bullish' ? colors.bullish : colors.bearish;

  return (
    <View style={styles.container}>
      <View style={styles.track}>
        <View
          style={[styles.marker, { left: `${markerPosition * 100}%`, backgroundColor: markerColor }]}
        />
      </View>
      {/* Static layout, deliberately NOT tied to which of sma50/sma200 is
          numerically higher (unlike the dot above): SMA50 always reads on
          the left and SMA200 always on the right, so the row doesn't swap
          positions out from under a user scanning the list — a text swap
          that tracked the dot used to make quick visual scanning unreliable.
          Each label is still ONE Text node combining a translated word with
          a number — safe as a single string because it always starts with
          the translated word (SMA50/SMA200 or their Hebrew equivalent),
          never a bare leading numeral (see the RTL MIXED TEXT RENDERING
          FIX note in index.tsx for the actual bug pattern this avoids). */}
      <View style={styles.labelRow}>
        <Text style={styles.labelText}>
          {t('sma50')} {sma50Display}
        </Text>
        <Text style={styles.labelText}>
          {t('sma200')} {sma200Display}
        </Text>
      </View>
    </View>
  );
}

function createStyles(colors: PipelineColorScheme, language: Language) {
  const isHebrew = language === 'he';

  return StyleSheet.create({
    container: {
      flex: 1,
    },
    fallbackText: {
      flex: 1,
      color: colors.textSecondary,
      fontSize: 13,
      textAlign: isHebrew ? 'right' : 'left',
      writingDirection: isHebrew ? 'rtl' : 'ltr',
    },
    track: {
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.background,
      justifyContent: 'center',
    },
    marker: {
      position: 'absolute',
      width: 12,
      height: 12,
      borderRadius: 6,
      marginLeft: -6,
    },
    labelRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: 6,
    },
    labelText: {
      color: colors.textSecondary,
      fontSize: 11,
    },
  });
}
