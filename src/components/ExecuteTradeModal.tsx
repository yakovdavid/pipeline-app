import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';

import { categoryLabel } from '@/constants/labels';
import type { PipelineColorScheme } from '@/constants/pipeline-colors';
import { usePipelineLanguage, type Language } from '@/contexts/language-context';
import { usePipelineTheme } from '@/contexts/theme-context';
import type { PortfolioCategory } from '@/types/portfolio';
import {
  computeSaleProceeds,
  computeTradeCost,
  exceedsHolding,
  formatMoney,
  formatUsd,
  isPriceEnteredInAgorot,
  parseTradeInputs,
  roundToCents,
  type TradeInputs,
  type TradePricingBasis,
} from '@/utils/trade-execution';

type TradeRequestBase = {
  ticker: string;
  category: PortfolioCategory;
  basis: TradePricingBasis;
  // The current price as the app displays it (e.g. "$187.20" or
  // "3985 Ag."), shown as a reference only, never pre-filled: the fill
  // price must come from the broker.
  livePriceDisplay: string;
};

// One pending trade, built by the Portfolio screen once it can price the
// ticker in USD.
export type ExecuteTradeRequest =
  | (TradeRequestBase & {
      side: 'buy';
      // True when the ticker is already held: the quantity is added to
      // the existing position.
      isTopUp: boolean;
    })
  | (TradeRequestBase & {
      side: 'sell';
      // The units currently held: the most that can be sold.
      unitsHeld: number;
      // EXECUTION RECONCILIATION fast path ("Log Exit Fill"): the quantity
      // to start with, or null for an empty field. Price and fee are never
      // prefilled; they must come from the broker's fill.
      prefillQuantity: number | null;
    });

export type ExecuteTradeModalProps = {
  request: ExecuteTradeRequest | null;
  cashBalance: number;
  onConfirm: (inputs: TradeInputs) => void;
  onCancel: () => void;
};

// TRADE RECONCILIATION: the "Execute Trade" / "Execute Sell" step. Every
// buy (from Add Asset or the Ambush Radar) and every sale goes through it.
// It asks for the three numbers on the broker's confirmation (Executed
// Quantity, Executed Price, Broker Fee), shows the Total Cost or Net
// Proceeds and the buying power after it as they're typed, and validates
// them (a sale can't exceed the units held). The cash checks are the
// Portfolio screen's job, in onConfirm, since it owns the balance.
//
// The parent remounts this component (a fresh `key`) for each request, so
// the fields always start empty without a state-resetting effect.
export function ExecuteTradeModal({ request, cashBalance, onConfirm, onCancel }: ExecuteTradeModalProps) {
  const { colors } = usePipelineTheme();
  const { language, t } = usePipelineLanguage();
  const styles = useMemo(() => createStyles(colors, language), [colors, language]);

  // Initial value only: the parent remounts this modal (a fresh `key`) for
  // each request, so a prefilled quantity applies exactly once.
  const [quantityText, setQuantityText] = useState(() =>
    request?.side === 'sell' && request.prefillQuantity !== null ? String(request.prefillQuantity) : '',
  );
  const [priceText, setPriceText] = useState('');
  const [feeText, setFeeText] = useState('');

  const inputs = parseTradeInputs(quantityText, priceText, feeText);
  const isSell = request?.side === 'sell';
  // Total Cost for a buy, Net Proceeds for a sale.
  const amount =
    request === null || inputs === null
      ? null
      : request.side === 'sell'
        ? computeSaleProceeds(inputs, request.basis)
        : computeTradeCost(inputs, request.basis);
  const cashAfter =
    amount === null ? null : roundToCents(isSell ? cashBalance + amount.totalUsd : cashBalance - amount.totalUsd);
  const isUsdInstrument = request?.basis.currencySymbol === '$';

  const handleConfirm = () => {
    if (inputs === null || request === null) {
      Alert.alert(t('invalidTradeTitle'), t('invalidTradeMessage'));
      return;
    }
    if (request.side === 'sell' && exceedsHolding(inputs.quantity, request.unitsHeld)) {
      Alert.alert(
        t('sellQuantityTooHighTitle'),
        t('sellQuantityTooHighMessage', { units: request.unitsHeld, ticker: request.ticker }),
      );
      return;
    }
    Keyboard.dismiss();
    onConfirm(inputs);
  };

  if (request === null) {
    return null;
  }

  const priceUnit = isPriceEnteredInAgorot(request.ticker) ? t('ag') : request.basis.currencySymbol;
  const feeUnit = request.basis.currencySymbol;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.avoider}>
          <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
            <View style={styles.card}>
              <View style={styles.header}>
                <Text style={styles.title}>{t(isSell ? 'executeSell' : 'executeTrade')}</Text>
                <TouchableOpacity
                  onPress={onCancel}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel={t('cancel')}>
                  <Ionicons name="close" size={22} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>

              <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}>
                <View style={styles.tickerRow}>
                  <Text style={styles.ticker}>{request.ticker}</Text>
                  <Text style={styles.subtitle}>{categoryLabel(t, request.category)}</Text>
                </View>
                <Text style={styles.hint}>{t('livePriceHint', { price: request.livePriceDisplay })}</Text>
                {request.side === 'buy' && request.isTopUp && (
                  <Text style={styles.topUpNote}>{t('buyMoreNote')}</Text>
                )}

                <View style={styles.quantityLabelRow}>
                  <Text style={[styles.label, styles.quantityLabel]}>{t('executedQuantity')}</Text>
                  {request.side === 'sell' && (
                    <TouchableOpacity
                      style={styles.sellAllButton}
                      onPress={() => setQuantityText(String(request.unitsHeld))}
                      accessibilityRole="button">
                      <Text style={styles.sellAllButtonText}>{t('sellAll')}</Text>
                    </TouchableOpacity>
                  )}
                </View>
                {request.side === 'sell' && (
                  <Text style={styles.hint}>{t('unitsHeld', { units: request.unitsHeld })}</Text>
                )}
                <TextInput
                  style={styles.input}
                  value={quantityText}
                  onChangeText={setQuantityText}
                  keyboardType="decimal-pad"
                  maxLength={15}
                  autoFocus
                  accessibilityLabel={t('executedQuantity')}
                />

                <Text style={styles.label}>{t('executedPrice', { unit: priceUnit })}</Text>
                <TextInput
                  style={styles.input}
                  value={priceText}
                  onChangeText={setPriceText}
                  keyboardType="decimal-pad"
                  maxLength={15}
                  accessibilityLabel={t('executedPrice', { unit: priceUnit })}
                />

                <Text style={styles.label}>{t('brokerFee', { unit: feeUnit })}</Text>
                <TextInput
                  style={styles.input}
                  value={feeText}
                  onChangeText={setFeeText}
                  keyboardType="decimal-pad"
                  maxLength={15}
                  placeholder="0"
                  placeholderTextColor={colors.textSecondary}
                  accessibilityLabel={t('brokerFee', { unit: feeUnit })}
                />

                <View style={styles.summary}>
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>{t(isSell ? 'netProceeds' : 'totalCost')}</Text>
                    <Text style={styles.summaryValue}>
                      {amount === null
                        ? '—'
                        : isUsdInstrument
                          ? formatUsd(amount.totalUsd)
                          : `${formatMoney(amount.totalLocal, request.basis.currencySymbol)} ≈ ${formatUsd(amount.totalUsd)}`}
                    </Text>
                  </View>
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>{t('cashAfterTrade')}</Text>
                    <Text style={[styles.summaryValue, cashAfter !== null && cashAfter < 0 && styles.negative]}>
                      {cashAfter === null ? formatUsd(cashBalance) : formatUsd(cashAfter)}
                    </Text>
                  </View>
                </View>

                <TouchableOpacity
                  style={[
                    styles.confirmButton,
                    isSell && styles.sellConfirmButton,
                    inputs === null && styles.confirmButtonDisabled,
                  ]}
                  onPress={handleConfirm}
                  accessibilityRole="button">
                  <Text style={styles.confirmButtonText}>{t(isSell ? 'confirmSell' : 'confirmExecution')}</Text>
                </TouchableOpacity>
              </ScrollView>
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

  // Same centered, intrinsic-height card as the Add Asset modal (see the
  // "squashed sliver" note on that modal in app/(tabs)/index.tsx): no
  // flex: 1 or maxHeight on the card, so it can't collapse on Android
  // while the keyboard opens.
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
      paddingHorizontal: 16,
      paddingTop: 16,
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
    scroll: {
      flexGrow: 0,
    },
    scrollContent: {
      paddingBottom: 20,
    },
    tickerRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: 8,
    },
    ticker: {
      color: colors.textPrimary,
      fontSize: 20,
      fontWeight: '800',
      writingDirection: 'ltr',
    },
    subtitle: {
      color: colors.textSecondary,
      fontSize: 14,
      fontWeight: '600',
      writingDirection,
    },
    hint: {
      color: colors.textSecondary,
      fontSize: 12,
      marginTop: 4,
      marginBottom: 8,
      textAlign,
      writingDirection,
    },
    topUpNote: {
      color: colors.warning,
      fontSize: 12,
      fontWeight: '600',
      marginBottom: 8,
      textAlign,
      writingDirection,
    },
    label: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: '700',
      textTransform: 'uppercase',
      marginTop: 12,
      marginBottom: 6,
      textAlign,
      writingDirection,
    },
    // Numbers stay LTR in both languages.
    input: {
      backgroundColor: colors.background,
      color: colors.textPrimary,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 16,
      textAlign: 'center',
      writingDirection: 'ltr',
    },
    summary: {
      backgroundColor: colors.background,
      borderRadius: 10,
      padding: 12,
      marginTop: 16,
      gap: 8,
    },
    summaryRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 12,
    },
    summaryLabel: {
      color: colors.textSecondary,
      fontSize: 13,
      fontWeight: '600',
      flexShrink: 1,
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
    confirmButton: {
      backgroundColor: colors.bullish,
      borderRadius: 8,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 16,
    },
    // A sale is styled apart from a buy, so the two can't be confused.
    sellConfirmButton: {
      backgroundColor: colors.bearish,
    },
    confirmButtonDisabled: {
      opacity: 0.6,
    },
    quantityLabelRow: {
      flexDirection: isHebrew ? 'row-reverse' : 'row',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      gap: 8,
    },
    quantityLabel: {
      flexShrink: 1,
    },
    sellAllButton: {
      borderWidth: 1,
      borderColor: colors.bearish,
      borderRadius: 12,
      paddingHorizontal: 10,
      paddingVertical: 3,
      marginBottom: 6,
    },
    sellAllButtonText: {
      color: colors.bearish,
      fontSize: 12,
      fontWeight: '700',
      writingDirection,
    },
    confirmButtonText: {
      color: colors.textPrimary,
      fontSize: 16,
      fontWeight: '700',
      writingDirection,
    },
  });
}
