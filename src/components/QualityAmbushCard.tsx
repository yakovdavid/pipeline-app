import { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AMBUSH_ZONE_BADGE_KEY, ambushZoneColors } from '@/constants/ambush-zones';
import type { PipelineColorScheme } from '@/constants/pipeline-colors';
import { usePipelineLanguage, type Language, type TFunction } from '@/contexts/language-context';
import { usePipelineTheme } from '@/contexts/theme-context';
import type { QualityAmbushAsset, QualityMoat } from '@/types/ambush';
import { QUALITY_MIN_ROIC_PCT, type AmbushReadinessZone } from '@/utils/ambush-grouping';
import { formatUnitPrice } from '@/utils/currency';

export type QualityAmbushCardProps = {
  asset: QualityAmbushAsset;
  // The readiness zone this asset was grouped into (see
  // classifyAmbushReadiness). Passed in from its section rather than
  // recomputed, so the badge always matches the section it sits under.
  zone: AmbushReadinessZone;
};

function moatLabel(t: TFunction, moat: QualityMoat): string {
  switch (moat) {
    case 'Wide':
      return t('moatWide');
    case 'Narrow':
      return t('moatNarrow');
    case 'None':
    default:
      return t('moatNone');
  }
}

// UNIFIED RADAR: the Quality (fundamental) counterpart of StockCard. Three
// rows, top to bottom: ticker and price; fundamentals (ROIC, green at or
// above the 15% gate and red below it, plus the moat); the Z-Score as the
// statistical trigger. A status strip along the bottom shows the readiness
// zone in that zone's color.
//
// Follows the app's light/dark theme like every other card, so in dark
// mode it reads as the dark dashboard card, and in light mode it doesn't
// clash with the cards around it.
//
// Wrapped in memo() so refreshing other rows doesn't re-render this one;
// theme and language are context reads, which still re-render it.
export const QualityAmbushCard = memo(function QualityAmbushCard({ asset, zone }: QualityAmbushCardProps) {
  const { colors, isDarkMode } = usePipelineTheme();
  const { language, t } = usePipelineLanguage();
  const styles = useMemo(() => createStyles(colors, isDarkMode, language), [colors, isDarkMode, language]);

  const zoneColors = ambushZoneColors(colors, zone);
  const passesRoicGate = asset.roic >= QUALITY_MIN_ROIC_PCT;
  const priceDisplay = formatUnitPrice(asset.ticker, asset.localPrice, asset.currencySymbol, t('ag'));

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.tickerGroup}>
          {/* Ticker symbols stay LTR regardless of app language. */}
          <Text style={styles.ticker}>{asset.ticker}</Text>
          {asset.isDemo && (
            <View style={styles.demoTag}>
              <Text style={styles.demoTagText}>{t('demoTag')}</Text>
            </View>
          )}
        </View>
        <Text style={styles.price}>{priceDisplay}</Text>
      </View>

      <View style={styles.fundamentalsRow}>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>{t('roicLabel')}</Text>
          <Text style={[styles.metricValue, { color: passesRoicGate ? colors.bullish : colors.bearish }]}>
            {asset.roic.toFixed(1)}%
          </Text>
        </View>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>{t('moatLabel')}</Text>
          <Text style={styles.metricValue}>{moatLabel(t, asset.moat)}</Text>
        </View>
      </View>

      {/* The statistical trigger, shown larger than the fundamentals. */}
      <View style={styles.zScoreRow}>
        <Text style={styles.zScoreLabel}>{t('zScoreLabel')}:</Text>
        <Text style={styles.zScoreValue}>{asset.zScore.toFixed(2)}</Text>
      </View>

      <View style={[styles.statusStrip, { backgroundColor: zoneColors.badgeBackground }]}>
        <Text style={[styles.statusStripText, { color: zoneColors.badgeText }]}>
          {t(AMBUSH_ZONE_BADGE_KEY[zone])}
        </Text>
      </View>
    </View>
  );
});

function createStyles(colors: PipelineColorScheme, isDarkMode: boolean, language: Language) {
  const isHebrew = language === 'he';
  const rowDirection = isHebrew ? 'row-reverse' : 'row';
  const textAlign = isHebrew ? 'right' : 'left';
  const writingDirection = isHebrew ? 'rtl' : 'ltr';

  return StyleSheet.create({
    // Same outer metrics as StockCard (16px side margin, 12px radius, 12px
    // gap) so Quality and Satellite cards line up in one list.
    card: {
      backgroundColor: colors.cardBackground,
      borderRadius: 12,
      marginHorizontal: 16,
      marginBottom: 12,
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: colors.quality,
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
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: 14,
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
      writingDirection: 'ltr',
    },
    demoTag: {
      borderWidth: 1,
      borderColor: colors.textSecondary,
      borderRadius: 4,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    demoTagText: {
      color: colors.textSecondary,
      fontSize: 10,
      fontWeight: '700',
      writingDirection,
    },
    price: {
      color: colors.textPrimary,
      fontSize: 18,
      fontWeight: '600',
      writingDirection: 'ltr',
    },
    fundamentalsRow: {
      flexDirection: rowDirection,
      gap: 24,
      paddingHorizontal: 16,
      marginTop: 12,
    },
    metric: {
      alignItems: isHebrew ? 'flex-end' : 'flex-start',
    },
    metricLabel: {
      color: colors.textSecondary,
      fontSize: 11,
      fontWeight: '700',
      textTransform: 'uppercase',
      textAlign,
      writingDirection,
    },
    metricValue: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: '700',
      marginTop: 2,
      textAlign,
      writingDirection,
    },
    zScoreRow: {
      flexDirection: rowDirection,
      alignItems: 'baseline',
      gap: 8,
      paddingHorizontal: 16,
      marginTop: 10,
      marginBottom: 12,
    },
    zScoreLabel: {
      color: colors.textSecondary,
      fontSize: 14,
      fontWeight: '600',
      writingDirection,
    },
    // The number itself: large and LTR, since it may carry a minus sign.
    zScoreValue: {
      color: colors.textPrimary,
      fontSize: 26,
      fontWeight: '800',
      writingDirection: 'ltr',
    },
    statusStrip: {
      paddingHorizontal: 16,
      paddingVertical: 6,
    },
    statusStripText: {
      fontSize: 12,
      fontWeight: '800',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      textAlign,
      writingDirection,
    },
  });
}
