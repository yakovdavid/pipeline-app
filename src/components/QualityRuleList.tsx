import { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { PipelineColorScheme } from '@/constants/pipeline-colors';
import { usePipelineLanguage, type Language, type TFunction } from '@/contexts/language-context';
import { usePipelineTheme } from '@/contexts/theme-context';
import type {
  QualityEntryEvaluation,
  QualityEntryReading,
  QualityEntryRuleId,
  QualityEntryThresholds,
} from '@/utils/quality-entry-rules';
import { SINGLE_STOCK_CAP_PCT } from '@/utils/position-cap';

// VALUE ZONE TRANSPARENCY (backlog P4): every entry rule the active
// template applies, each with ✓ / ✗ and the actual value, so a card that
// is not in the Value Zone says exactly which rule failed. Shared by the
// Ambush Radar's Quality card and the Portfolio's Quality row.

function formatPct(value: number | null): string {
  return value === null ? 'N/A' : `${value.toFixed(1)}%`;
}

function formatNumber(value: number | null): string {
  return value === null ? 'N/A' : value.toFixed(1);
}

export function qualityRuleText(
  t: TFunction,
  id: QualityEntryRuleId,
  reading: QualityEntryReading,
  thresholds: QualityEntryThresholds,
): string {
  switch (id) {
    case 'roic':
      return `${t('ruleRoic', { floor: thresholds.minRoicPct })}: ${formatPct(reading.roic)}`;
    case 'moat':
      return t('ruleMoatRated');
    case 'capexToRevenue':
      return `${t('ruleCapexToRevenue', { max: thresholds.maxCapexToRevenuePct })}: ${formatPct(reading.capexToRevenue3y)}`;
    case 'capexToOcf':
      return `${t('ruleCapexToOcf', { max: thresholds.maxCapexToOcfPct })}: ${formatPct(reading.capexToOcf3y)}`;
    case 'peBelowAverage':
      return `${t('rulePeBelowAverage')}: ${formatNumber(reading.peTtm)} / ${formatNumber(reading.pe5yAvg)}`;
    case 'positionCap':
      return t('rulePositionCap', { max: SINGLE_STOCK_CAP_PCT });
    case 'zScore':
      return `${t('ruleZScore', { max: thresholds.maxZScore.toFixed(1) })}: ${
        reading.zScore === null ? 'N/A' : reading.zScore.toFixed(2)
      }`;
    default:
      return id;
  }
}

export type QualityRuleListProps = {
  reading: QualityEntryReading;
  evaluation: QualityEntryEvaluation;
  thresholds: QualityEntryThresholds;
};

export const QualityRuleList = memo(function QualityRuleList({ reading, evaluation, thresholds }: QualityRuleListProps) {
  const { colors } = usePipelineTheme();
  const { language, t } = usePipelineLanguage();
  const styles = useMemo(() => createStyles(colors, language), [colors, language]);

  return (
    <View style={styles.container}>
      {evaluation.rules.map((rule) => (
        <Text key={rule.id} style={[styles.rule, { color: rule.passed ? colors.bullish : colors.bearish }]}>
          {`${rule.passed ? '✓' : '✗'} ${qualityRuleText(t, rule.id, reading, thresholds)}`}
        </Text>
      ))}
    </View>
  );
});

function createStyles(colors: PipelineColorScheme, language: Language) {
  const isHebrew = language === 'he';
  return StyleSheet.create({
    container: {
      gap: 1,
    },
    rule: {
      color: colors.textPrimary,
      fontSize: 11,
      fontWeight: '600',
      textAlign: isHebrew ? 'right' : 'left',
      writingDirection: isHebrew ? 'rtl' : 'ltr',
    },
  });
}
