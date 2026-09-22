import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { PipelineColorScheme } from '@/constants/pipeline-colors';
import { PULLBACK_KILL_ZONE_THRESHOLD_PCT, PULLBACK_PREMIUM_THRESHOLD_PCT } from '@/constants/thresholds';
import { usePipelineLanguage, type Language, type TFunction } from '@/contexts/language-context';
import { usePipelineTheme } from '@/contexts/theme-context';
import type { TrendLabel } from '@/types/asset';

export type TrendBadgesProps = {
  macroTrend: TrendLabel;
  // PULLBACK DEPTH INDICATOR: replaces the old binary Tactical Momentum
  // Bullish/Bearish badge with a graduated 3-tier read of the exact same
  // underlying (price - SMA50) / SMA50 relationship — see
  // backend/main.py's pullback_depth. Macro Trend (SMA200-based, above)
  // is a different signal and is intentionally left as the binary
  // Bullish/Bearish badge it always was.
  pullbackDepth: number | null;
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

type PullbackDepthTier = 'premium' | 'watch' | 'killZone';

// PULLBACK DEPTH INDICATOR: see PULLBACK_PREMIUM_THRESHOLD_PCT/
// PULLBACK_KILL_ZONE_THRESHOLD_PCT in @/constants/thresholds for the exact
// boundaries and the PRD-vs-implementation rationale. Null (insufficient
// SMA50 history) is handled separately by the call site, not here.
function classifyPullbackDepth(pullbackDepth: number): PullbackDepthTier {
  if (pullbackDepth > PULLBACK_PREMIUM_THRESHOLD_PCT) return 'premium';
  if (pullbackDepth <= PULLBACK_KILL_ZONE_THRESHOLD_PCT) return 'killZone';
  return 'watch';
}

// Color code strictly per the PRD: Gray (Premium), Orange (Watch), Red
// (Kill Zone / Entry Trigger) — reusing this app's existing palette
// (textSecondary/warning/bearish) rather than inventing new colors, so
// this stays consistent with every other gray/orange/red signal already
// in the app (e.g. the Quality Kill Switch's own reviewAlert red).
function pullbackDepthColor(colors: PipelineColorScheme, tier: PullbackDepthTier | null): string {
  switch (tier) {
    case 'premium':
      return colors.textSecondary;
    case 'watch':
      return colors.warning;
    case 'killZone':
      return colors.bearish;
    default:
      return colors.textSecondary;
  }
}

function pullbackDepthTierText(t: TFunction, tier: PullbackDepthTier | null): string {
  switch (tier) {
    case 'premium':
      return t('premium');
    case 'watch':
      return t('watch');
    case 'killZone':
      return t('killZone');
    default:
      return t('notAvailable');
  }
}

function pullbackDepthValueText(t: TFunction, pullbackDepth: number | null): string {
  if (pullbackDepth === null) {
    return t('notAvailable');
  }
  const tier = classifyPullbackDepth(pullbackDepth);
  return `${pullbackDepth.toFixed(2)}% (${pullbackDepthTierText(t, tier)})`;
}

// Dashboard Trend Display: Macro Trend (price vs. SMA200, still a binary
// Bullish/Bearish badge) alongside the Pullback Depth Indicator (price vs.
// SMA50, now a graduated 3-tier badge — see classifyPullbackDepth above),
// replacing the old single asset-type-dependent Bullish/Bearish badge this
// app used to show (SMA200 for ETFs, SMA50 for Stocks, silently hiding
// whichever signal it didn't pick), and then replacing the Tactical
// Momentum half of that pair's own binary verdict with the Pullback Depth
// Indicator per "The Fortress 2.0" PRD. Both values are computed
// backend-side (see backend/main.py) and passed through as-is; this
// component only decides how to render them.
//
// Self-contained (reads theme/language via context itself), same reasoning
// as MomentumBar — shared identically by the Ambush Radar StockCard and
// the Portfolio PortfolioStockRow (index.tsx).
export function TrendBadges({ macroTrend, pullbackDepth }: TrendBadgesProps) {
  const { colors } = usePipelineTheme();
  const { language, t } = usePipelineLanguage();
  const styles = useMemo(() => createStyles(colors, language), [colors, language]);

  const pullbackTier = pullbackDepth === null ? null : classifyPullbackDepth(pullbackDepth);

  return (
    <View style={styles.row}>
      <View style={[styles.badge, { backgroundColor: trendColor(colors, macroTrend) }]}>
        <Text style={styles.badgeLabel}>{t('macroTrend')}</Text>
        <Text style={styles.badgeValue}>{trendText(t, macroTrend)}</Text>
      </View>
      <View style={[styles.badge, { backgroundColor: pullbackDepthColor(colors, pullbackTier) }]}>
        <Text style={styles.badgeLabel}>{t('pullbackDepth')}</Text>
        <Text style={styles.badgeValue}>{pullbackDepthValueText(t, pullbackDepth)}</Text>
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
