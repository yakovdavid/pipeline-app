import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { PipelineColorScheme } from '@/constants/pipeline-colors';
import { usePipelineLanguage, type Language, type TFunction } from '@/contexts/language-context';
import { usePipelineTheme } from '@/contexts/theme-context';
import type { TrendLabel } from '@/types/asset';

export type TrendBadgesProps = {
  macroTrend: TrendLabel;
  tacticalMomentum: TrendLabel;
};

function trendColor(colors: PipelineColorScheme, value: TrendLabel): string {
  if (value === 'Bullish') return colors.bullish;
  if (value === 'Bearish') return colors.bearish;
  return colors.textSecondary;
}

function trendText(t: TFunction, value: TrendLabel): string {
  if (value === 'Bullish') return t('bullish');
  if (value === 'Bearish') return t('bearish');
  return t('notAvailable');
}

// Dashboard Trend Display: TWO independent, equally-weighted trend
// indicators — Macro Trend (price vs. SMA200) and Tactical Momentum (price
// vs. SMA50) — replacing the single asset-type-dependent Bullish/Bearish
// badge this app used to show (SMA200 for ETFs, SMA50 for Stocks, silently
// hiding whichever signal it didn't pick). Both values are computed
// backend-side (see backend/main.py's _classify_trend) and passed through
// as-is; this component only decides how to render them.
//
// Self-contained (reads theme/language via context itself), same reasoning
// as MomentumBar — shared identically by the Ambush Radar StockCard and
// the Portfolio PortfolioStockRow (index.tsx).
export function TrendBadges({ macroTrend, tacticalMomentum }: TrendBadgesProps) {
  const { colors } = usePipelineTheme();
  const { language, t } = usePipelineLanguage();
  const styles = useMemo(() => createStyles(colors, language), [colors, language]);

  return (
    <View style={styles.row}>
      <View style={[styles.badge, { backgroundColor: trendColor(colors, macroTrend) }]}>
        <Text style={styles.badgeLabel}>{t('macroTrend')}</Text>
        <Text style={styles.badgeValue}>{trendText(t, macroTrend)}</Text>
      </View>
      <View style={[styles.badge, { backgroundColor: trendColor(colors, tacticalMomentum) }]}>
        <Text style={styles.badgeLabel}>{t('tacticalMomentum')}</Text>
        <Text style={styles.badgeValue}>{trendText(t, tacticalMomentum)}</Text>
      </View>
    </View>
  );
}

function createStyles(colors: PipelineColorScheme, language: Language) {
  const isHebrew = language === 'he';

  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      gap: 8,
      marginTop: 10,
    },
    badge: {
      flex: 1,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
      alignItems: isHebrew ? 'flex-end' : 'flex-start',
    },
    badgeLabel: {
      color: colors.textPrimary,
      opacity: 0.85,
      fontSize: 10,
      fontWeight: '700',
      textTransform: 'uppercase',
      textAlign: isHebrew ? 'right' : 'left',
      writingDirection: isHebrew ? 'rtl' : 'ltr',
    },
    badgeValue: {
      color: colors.textPrimary,
      fontSize: 13,
      fontWeight: '700',
      marginTop: 2,
      textAlign: isHebrew ? 'right' : 'left',
      writingDirection: isHebrew ? 'rtl' : 'ltr',
    },
  });
}
