import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { PipelineColorScheme } from '@/constants/pipeline-colors';
import {
  usePipelineLanguage,
  type Language,
  type TFunction,
  type TranslationKey,
} from '@/contexts/language-context';
import { usePipelineTheme } from '@/contexts/theme-context';
import type { TrendLabel } from '@/types/asset';
import { resolveAmbushSignal, type AmbushSignal, type AmbushSignalState } from '@/utils/ambush-zone';

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

// Background + text color per badge state, strictly per the PRD: Gray
// (Premium), Orange (Watch), Red (Kill Zone / Entry Trigger), dark magenta
// (Overshot — a crash, not an entry), and a neutral disabled gray when the
// Macro Override invalidates the setup. Reuses the app palette rather than
// inventing ad-hoc colors.
function pullbackDepthColors(
  colors: PipelineColorScheme,
  state: AmbushSignalState | null,
): { background: string; text: string } {
  switch (state) {
    case 'watch':
      return { background: colors.warning, text: colors.warningText };
    case 'killZone':
      return { background: colors.bearish, text: colors.textPrimary };
    case 'overshot':
      return { background: colors.overshot, text: colors.overshotText };
    case 'invalidated':
      return { background: colors.invalidated, text: colors.textPrimary };
    case 'premium':
    default:
      return { background: colors.textSecondary, text: colors.textPrimary };
  }
}

const PULLBACK_STATE_TEXT_KEY: Record<AmbushSignalState, TranslationKey> = {
  premium: 'premium',
  watch: 'watch',
  killZone: 'killZone',
  overshot: 'overshot',
  invalidated: 'invalidated',
};

// e.g. "-8.81% (Overshot)" when Bullish, "-4.12% (Invalidated)" when the
// Macro Override applies — the raw percentage is always kept visible.
function pullbackDepthValueText(t: TFunction, signal: AmbushSignal): string {
  if (signal.pullbackDepth === null || signal.state === null) {
    return t('notAvailable');
  }
  return `${signal.pullbackDepth.toFixed(2)}% (${t(PULLBACK_STATE_TEXT_KEY[signal.state])})`;
}

// Dashboard Trend Display: Macro Trend (price vs. SMA200, still a binary
// Bullish/Bearish badge) alongside the Pullback Depth Indicator (price vs.
// SMA50, now a graduated tiered badge — see @/utils/ambush-zone),
// replacing the old single asset-type-dependent Bullish/Bearish badge this
// app used to show (SMA200 for ETFs, SMA50 for Stocks, silently hiding
// whichever signal it didn't pick), and then replacing the Tactical
// Momentum half of that pair's own binary verdict with the Pullback Depth
// Indicator per "The Fortress 2.0" PRD. Both values are computed
// backend-side (see backend/main.py) and passed through as-is; this
// component only decides how to render them — including the Macro
// Override, which neutralizes the Pullback Depth badge to gray
// "Invalidated" unless Macro Trend is Bullish.
//
// Self-contained (reads theme/language via context itself), same reasoning
// as MomentumBar — shared identically by the Ambush Radar StockCard and
// the Portfolio PortfolioStockRow (index.tsx).
export function TrendBadges({ macroTrend, pullbackDepth }: TrendBadgesProps) {
  const { colors } = usePipelineTheme();
  const { language, t } = usePipelineLanguage();
  const styles = useMemo(() => createStyles(colors, language), [colors, language]);

  const ambushSignal = resolveAmbushSignal(macroTrend, pullbackDepth);
  const pullbackColors = pullbackDepthColors(colors, ambushSignal.state);

  return (
    <View style={styles.row}>
      <View style={[styles.badge, { backgroundColor: trendColor(colors, macroTrend) }]}>
        <Text style={styles.badgeLabel}>{t('macroTrend')}</Text>
        <Text style={styles.badgeValue}>{trendText(t, macroTrend)}</Text>
      </View>
      <View style={[styles.badge, { backgroundColor: pullbackColors.background }]}>
        <Text style={[styles.badgeLabel, { color: pullbackColors.text }]}>{t('pullbackDepth')}</Text>
        <Text style={[styles.badgeValue, { color: pullbackColors.text }]}>
          {pullbackDepthValueText(t, ambushSignal)}
        </Text>
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
