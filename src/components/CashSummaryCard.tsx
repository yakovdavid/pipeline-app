import { Ionicons } from '@expo/vector-icons';
import { memo, useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { categoryLabel } from '@/constants/labels';
import type { PipelineColorScheme } from '@/constants/pipeline-colors';
import { usePipelineLanguage, type Language, type TFunction } from '@/contexts/language-context';
import { usePipelineTheme } from '@/contexts/theme-context';
import { ALLOCATION_BUCKETS, type AllocationBreakdown, type AllocationBucket } from '@/utils/allocation';
import { formatUsd } from '@/utils/trade-execution';

export type CashSummaryCardProps = {
  cashBalance: number;
  allocation: AllocationBreakdown;
  // False until the saved balance has been read; the button is disabled
  // and the balance shows a dash rather than a misleading $0.00.
  isCashLoaded: boolean;
  onAdjustCash: () => void;
};

function bucketLabel(t: TFunction, bucket: AllocationBucket): string {
  return bucket === 'Cash' ? t('cash') : categoryLabel(t, bucket);
}

function bucketColor(colors: PipelineColorScheme, bucket: AllocationBucket): string {
  switch (bucket) {
    case 'Core':
      return colors.core;
    case 'Satellite':
      return colors.satellite;
    case 'Quality':
      return colors.quality;
    case 'Cash':
    default:
      return colors.textSecondary;
  }
}

// LIQUIDITY CORE: the Portfolio's summary strip. It shows the buying power,
// the total (invested + cash), the cash-diluted weight of every layer plus
// Cash itself (always summing to 100.0%, see computeAllocation), and the
// "Adjust Cash" button (deposits, dividends, withdrawals, corrections).
export const CashSummaryCard = memo(function CashSummaryCard({
  cashBalance,
  allocation,
  isCashLoaded,
  onAdjustCash,
}: CashSummaryCardProps) {
  const { colors } = usePipelineTheme();
  const { language, t } = usePipelineLanguage();
  const styles = useMemo(() => createStyles(colors, language), [colors, language]);
  const isNegative = isCashLoaded && cashBalance < 0;

  return (
    <View style={styles.card}>
      <View style={styles.topRow}>
        <View style={styles.balanceGroup}>
          <Text style={styles.caption}>{t('buyingPower')}</Text>
          <Text style={[styles.balance, isNegative && styles.negative]}>
            {isCashLoaded ? formatUsd(cashBalance) : '—'}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.adjustCashButton, !isCashLoaded && styles.adjustCashButtonDisabled]}
          onPress={onAdjustCash}
          disabled={!isCashLoaded}
          accessibilityRole="button"
          accessibilityLabel={t('adjustCash')}>
          <Ionicons name="add-circle" size={18} color={colors.textPrimary} />
          <Text style={styles.adjustCashButtonText}>{t('adjustCash')}</Text>
        </TouchableOpacity>
      </View>

      {isNegative && <Text style={styles.warning}>{t('negativeCashWarning')}</Text>}

      <Text style={styles.caption}>
        {t('totalWithCash')}: <Text style={styles.total}>{formatUsd(allocation.totalValue)}</Text>
      </Text>

      <Text style={[styles.caption, styles.allocationCaption]}>{t('allocationWithCash')}</Text>
      <View style={styles.weightsRow}>
        {ALLOCATION_BUCKETS.map((bucket) => (
          <View key={bucket} style={styles.weightChip}>
            <View style={[styles.weightDot, { backgroundColor: bucketColor(colors, bucket) }]} />
            <Text style={styles.weightLabel}>{bucketLabel(t, bucket)}</Text>
            <Text style={styles.weightValue}>{`${allocation.weightsPct[bucket].toFixed(1)}%`}</Text>
          </View>
        ))}
      </View>
    </View>
  );
});

function createStyles(colors: PipelineColorScheme, language: Language) {
  const isHebrew = language === 'he';
  const textAlign = isHebrew ? 'right' : 'left';
  const writingDirection = isHebrew ? 'rtl' : 'ltr';

  return StyleSheet.create({
    card: {
      backgroundColor: colors.cardBackground,
      borderRadius: 12,
      marginHorizontal: 16,
      marginBottom: 12,
      padding: 14,
      gap: 6,
    },
    topRow: {
      flexDirection: isHebrew ? 'row-reverse' : 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 12,
    },
    balanceGroup: {
      flexShrink: 1,
      alignItems: isHebrew ? 'flex-end' : 'flex-start',
    },
    caption: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: '600',
      textAlign,
      writingDirection,
    },
    allocationCaption: {
      marginTop: 4,
    },
    balance: {
      color: colors.textPrimary,
      fontSize: 24,
      fontWeight: '800',
      writingDirection: 'ltr',
    },
    total: {
      color: colors.textPrimary,
      fontWeight: '700',
    },
    negative: {
      color: colors.bearish,
    },
    warning: {
      color: colors.bearish,
      fontSize: 12,
      fontWeight: '600',
      textAlign,
      writingDirection,
    },
    // The highly visible Yield Ledger / cash correction entry point.
    adjustCashButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: colors.bullish,
      borderRadius: 20,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    adjustCashButtonDisabled: {
      opacity: 0.5,
    },
    adjustCashButtonText: {
      color: colors.textPrimary,
      fontSize: 14,
      fontWeight: '700',
      writingDirection,
    },
    weightsRow: {
      flexDirection: isHebrew ? 'row-reverse' : 'row',
      flexWrap: 'wrap',
      gap: 8,
    },
    weightChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: colors.background,
      borderRadius: 12,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    weightDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    weightLabel: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: '600',
      writingDirection,
    },
    weightValue: {
      color: colors.textPrimary,
      fontSize: 13,
      fontWeight: '700',
      writingDirection: 'ltr',
    },
  });
}
