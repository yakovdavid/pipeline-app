import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';

import type { PipelineColorScheme } from '@/constants/pipeline-colors';
import { usePipelineLanguage, type Language } from '@/contexts/language-context';
import { usePipelineTheme } from '@/contexts/theme-context';
import {
  formatUsd,
  parseCashAmount,
  roundToCents,
  signedCashDelta,
  type CashAdjustmentDirection,
} from '@/utils/trade-execution';

export type AdjustCashModalProps = {
  visible: boolean;
  cashBalance: number;
  // Signed USD amount: positive adds to the balance, negative removes.
  onSubmit: (deltaUsd: number) => void;
  onCancel: () => void;
};

// YIELD LEDGER / CASH CORRECTION: "Adjust Cash". Deposit / Dividend adds to
// the buying power; Withdraw / Correction removes from it (a withdrawal
// from the broker, or fixing an earlier wrong entry). The parent remounts
// it (a fresh `key`) each time it opens, so it always starts on Deposit
// with an empty amount.
export function AdjustCashModal({ visible, cashBalance, onSubmit, onCancel }: AdjustCashModalProps) {
  const { colors } = usePipelineTheme();
  const { language, t } = usePipelineLanguage();
  const styles = useMemo(() => createStyles(colors, language), [colors, language]);
  const [direction, setDirection] = useState<CashAdjustmentDirection>('deposit');
  const [amountText, setAmountText] = useState('');

  const amount = parseCashAmount(amountText);
  const delta = amount === null ? null : signedCashDelta(amount, direction);
  const balanceAfter = delta === null ? null : roundToCents(cashBalance + delta);

  const handleSubmit = () => {
    if (delta === null) {
      Alert.alert(t('invalidAmountTitle'), t('invalidAmountMessage'));
      return;
    }
    Keyboard.dismiss();
    onSubmit(delta);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.avoider}>
          <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
            <View style={styles.card}>
              <View style={styles.header}>
                <Text style={styles.title}>{t('adjustCash')}</Text>
                <TouchableOpacity
                  onPress={onCancel}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel={t('cancel')}>
                  <Ionicons name="close" size={22} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>

              <View style={styles.toggleRow} accessibilityRole="radiogroup">
                <TouchableOpacity
                  style={[styles.toggleButton, direction === 'deposit' && styles.toggleDepositActive]}
                  onPress={() => setDirection('deposit')}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: direction === 'deposit' }}>
                  <Text style={styles.toggleText}>{t('depositOrDividend')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.toggleButton, direction === 'withdraw' && styles.toggleWithdrawActive]}
                  onPress={() => setDirection('withdraw')}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: direction === 'withdraw' }}>
                  <Text style={styles.toggleText}>{t('withdrawOrCorrect')}</Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.label}>{t('cashAmountLabel')}</Text>
              <TextInput
                style={styles.input}
                value={amountText}
                onChangeText={setAmountText}
                placeholder={t('cashAmountPlaceholder')}
                placeholderTextColor={colors.textSecondary}
                keyboardType="decimal-pad"
                maxLength={15}
                autoFocus
                onSubmitEditing={handleSubmit}
                accessibilityLabel={t('cashAmountLabel')}
              />

              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>{t('buyingPower')}</Text>
                <Text style={[styles.summaryValue, balanceAfter !== null && balanceAfter < 0 && styles.negative]}>
                  {balanceAfter === null
                    ? formatUsd(cashBalance)
                    : `${formatUsd(cashBalance)} → ${formatUsd(balanceAfter)}`}
                </Text>
              </View>

              <TouchableOpacity
                style={[
                  styles.submitButton,
                  direction === 'withdraw' && styles.withdrawSubmitButton,
                  delta === null && styles.submitButtonDisabled,
                ]}
                onPress={handleSubmit}
                accessibilityRole="button">
                <Text style={styles.submitButtonText}>{t('applyAdjustment')}</Text>
              </TouchableOpacity>
            </View>
          </TouchableWithoutFeedback>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

function createStyles(colors: PipelineColorScheme, language: Language) {
  const isHebrew = language === 'he';
  const textAlign = isHebrew ? 'right' : 'left';
  const writingDirection = isHebrew ? 'rtl' : 'ltr';

  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
    },
    avoider: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    card: {
      width: '90%',
      backgroundColor: colors.cardBackground,
      borderRadius: 20,
      padding: 16,
      paddingBottom: 20,
      shadowColor: '#000',
      shadowOpacity: 0.3,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 6 },
      elevation: 12,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 12,
    },
    title: {
      color: colors.textPrimary,
      fontSize: 18,
      fontWeight: '700',
      writingDirection,
    },
    toggleRow: {
      flexDirection: isHebrew ? 'row-reverse' : 'row',
      gap: 8,
      marginBottom: 14,
    },
    toggleButton: {
      flex: 1,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.textSecondary,
      paddingVertical: 10,
      alignItems: 'center',
    },
    toggleDepositActive: {
      backgroundColor: colors.bullish,
      borderColor: colors.bullish,
    },
    toggleWithdrawActive: {
      backgroundColor: colors.bearish,
      borderColor: colors.bearish,
    },
    toggleText: {
      color: colors.textPrimary,
      fontSize: 13,
      fontWeight: '700',
      writingDirection,
    },
    label: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: '700',
      textTransform: 'uppercase',
      marginBottom: 6,
      textAlign,
      writingDirection,
    },
    input: {
      backgroundColor: colors.background,
      color: colors.textPrimary,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 18,
      textAlign: 'center',
      writingDirection: 'ltr',
    },
    summaryRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 12,
      marginTop: 14,
    },
    summaryLabel: {
      color: colors.textSecondary,
      fontSize: 13,
      fontWeight: '600',
      writingDirection,
    },
    summaryValue: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: '700',
      writingDirection: 'ltr',
    },
    negative: {
      color: colors.bearish,
    },
    submitButton: {
      backgroundColor: colors.bullish,
      borderRadius: 8,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 16,
    },
    withdrawSubmitButton: {
      backgroundColor: colors.bearish,
    },
    submitButtonDisabled: {
      opacity: 0.6,
    },
    submitButtonText: {
      color: colors.textPrimary,
      fontSize: 16,
      fontWeight: '700',
      writingDirection,
    },
  });
}
