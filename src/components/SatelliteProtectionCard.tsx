import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { PipelineColorScheme } from '@/constants/pipeline-colors';
import { usePipelineLanguage, type Language, type TFunction } from '@/contexts/language-context';
import { usePipelineTheme } from '@/contexts/theme-context';
import { computeProtectionState, type ProtectionState } from '@/utils/protectionState';

export interface SatelliteProtectionCardProps {
  ticker: string;
  currentPrice: number;
  hwm: number;
}

// How long a copy button shows its "Copied!" feedback before reverting to
// the plain copy icon — long enough to register as deliberate feedback,
// short enough not to feel stuck if the user taps it again quickly.
const COPY_FEEDBACK_DURATION_MS = 1500;

// Plain USD formatting ("$142.56") — the Protection State Tracker's prices
// (hwm, stopPriceTarget) are always USD thresholds, never an instrument's
// own local-currency quote, so this deliberately does NOT reuse the app's
// multi-currency/Agorot-aware formatters (@/utils/currency) — those solve
// a different problem (displaying a TASE instrument's native quote) that
// doesn't apply here.
function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

// Which specific copy button last fired its "Copied!" feedback — distinct
// buttons (stop price vs. alert price) need independent feedback, so this
// is a key, not a bare boolean.
type CopiedField = 'stopPrice' | 'alertPrice' | null;

// A single tappable row: a label, the value itself, and a copy-to-
// clipboard icon button — shared by both the Stop Price and the Broker
// Price Alert rows in the expanded view below, so their layout/behavior
// can never drift apart.
//
// i18n: `label` arrives already translated (built by the caller via t(),
// since only the caller knows which translation key/params apply) —
// `value` is deliberately NEVER translated: it's either a raw USD amount
// or the literal "12%" from @/utils/protectionState, exactly what the
// user needs to type into/compare against their brokerage account, so it
// stays in its original, locale-independent form regardless of app
// language (same convention this app already applies to ticker symbols
// and prices everywhere else — see e.g. StockCard.tsx).
type CopyableValueRowProps = {
  label: string;
  value: string;
  fieldKey: Exclude<CopiedField, null>;
  copiedField: CopiedField;
  onCopy: (fieldKey: Exclude<CopiedField, null>, value: string) => void;
  colors: PipelineColorScheme;
  styles: ReturnType<typeof createStyles>;
  t: TFunction;
};

function CopyableValueRow({ label, value, fieldKey, copiedField, onCopy, colors, styles, t }: CopyableValueRowProps) {
  const isCopied = copiedField === fieldKey;

  return (
    <View style={styles.valueRow}>
      <View style={styles.valueTextGroup}>
        <Text style={styles.valueLabel}>{label}</Text>
        <Text style={styles.valueText}>{value}</Text>
      </View>
      <View style={styles.copyButtonGroup}>
        {isCopied && <Text style={styles.copiedFeedbackText}>{t('copied')}</Text>}
        <TouchableOpacity
          onPress={() => onCopy(fieldKey, value)}
          style={styles.copyButton}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityLabel={`Copy ${label} to clipboard`}>
          <Ionicons
            name={isCopied ? 'checkmark' : 'copy-outline'}
            size={18}
            color={isCopied ? colors.bullish : colors.textSecondary}
          />
        </TouchableOpacity>
      </View>
    </View>
  );
}

// SATELLITE PROTECTION CARD: Progressive Disclosure UI for the Protection
// State Tracker (see @/utils/protectionState for the business logic this
// renders). Collapsed, it's a quick-scan overview (ticker, price, a
// colored status badge); expanded, it surfaces the exact order parameters
// the user needs to type into their brokerage account — kept hidden by
// default specifically so a list of many Satellite positions doesn't dump
// every position's full order-ticket detail on screen at once.
//
// INTEGRATION NOTE: this is rendered embedded inside PortfolioStockRow's
// own asset card (index.tsx), directly below that card's existing
// Satellite metrics (SMA200/High Water Mark/Trailing Stop/Drop-from-HWM) —
// NOT as a separate, standalone list item — so its own outer wrapper
// deliberately carries no card chrome of its own (no background, no
// shadow/elevation, no bottom margin): see the `wrapper` style below.
export function SatelliteProtectionCard({ ticker, currentPrice, hwm }: SatelliteProtectionCardProps) {
  const { colors } = usePipelineTheme();
  // ROBUST LANGUAGE CONTEXT: a plain context read, same as usePipelineTheme
  // above — a language switch re-renders this card, and every translated
  // string on it, immediately, no app restart (see
  // @/contexts/language-context).
  const { language, t } = usePipelineLanguage();
  const styles = useMemo(() => createStyles(colors, language), [colors, language]);

  const [isExpanded, setIsExpanded] = useState(false);
  const [copiedField, setCopiedField] = useState<CopiedField>(null);

  // Tracks the pending "revert to plain copy icon" timeout so a second
  // copy tap (of either button) restarts the feedback window instead of
  // letting an earlier timeout fire mid-way through the new one.
  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimeoutRef.current !== null) {
        clearTimeout(copyFeedbackTimeoutRef.current);
      }
    };
  }, []);

  const protectionState: ProtectionState = useMemo(
    () => computeProtectionState(currentPrice, hwm),
    [currentPrice, hwm],
  );

  const isAutomatedTracking = protectionState.statusColor === 'green';
  // Reuses the app's own established green/orange semantics (bullish =
  // healthy/automated, warning = needs attention) rather than introducing
  // new hardcoded hex colors — this is what gives the badge correct
  // light/dark-mode contrast "for free."
  const statusBadgeColor = isAutomatedTracking ? colors.bullish : colors.warning;
  const statusLabel = isAutomatedTracking ? t('automatedTracking') : t('manualSetupRequired');

  const stopPriceDisplay =
    typeof protectionState.stopPriceTarget === 'number'
      ? formatUsd(protectionState.stopPriceTarget)
      : protectionState.stopPriceTarget;

  const handleCopy = (fieldKey: Exclude<CopiedField, null>, value: string) => {
    Clipboard.setStringAsync(value).catch(() => {
      // Copying to the clipboard failing is not something the user can
      // act on here; the button simply won't show its "Copied!" feedback,
      // which is signal enough that nothing happened.
      return;
    });

    if (copyFeedbackTimeoutRef.current !== null) {
      clearTimeout(copyFeedbackTimeoutRef.current);
    }
    setCopiedField(fieldKey);
    copyFeedbackTimeoutRef.current = setTimeout(() => {
      setCopiedField(null);
      copyFeedbackTimeoutRef.current = null;
    }, COPY_FEEDBACK_DURATION_MS);
  };

  return (
    <View style={styles.wrapper}>
      {/* COLLAPSED STATE: ticker, current price, and a small status badge
          — tapping anywhere on this row toggles the expanded detail
          below. Ticker/price are LTR identifiers (same convention as
          everywhere else in this app), so this row's own layout isn't
          language-flipped; only the badge's translated label text is. */}
      <TouchableOpacity
        style={styles.collapsedRow}
        onPress={() => setIsExpanded((previous) => !previous)}
        accessibilityLabel={`${isExpanded ? 'Collapse' : 'Expand'} protection details for ${ticker}`}
        accessibilityRole="button">
        <View style={styles.collapsedLeftGroup}>
          <Text style={styles.ticker}>{ticker}</Text>
          <Text style={styles.currentPrice}>{formatUsd(currentPrice)}</Text>
        </View>
        <View style={styles.collapsedRightGroup}>
          <View style={[styles.statusBadge, { backgroundColor: statusBadgeColor }]}>
            <Text style={styles.statusBadgeText}>{statusLabel}</Text>
          </View>
          <Ionicons
            name={isExpanded ? 'chevron-up' : 'chevron-down'}
            size={18}
            color={colors.textSecondary}
          />
        </View>
      </TouchableOpacity>

      {/* EXPANDED STATE: the actionable order-ticket detail — Order Type,
          the Stop Price/% value (with its own Copy button), and, only
          when Condition A (Recovery State) applies, the Broker Price
          Alert instruction (with its own Copy button). */}
      {isExpanded && (
        <View style={styles.expandedSection}>
          <View style={styles.divider} />

          <View style={styles.orderTypeRow}>
            <Text style={styles.orderTypeLabel}>{t('protectionOrderType')}</Text>
            <Text style={styles.orderTypeValue}>{protectionState.orderType}</Text>
          </View>

          <CopyableValueRow
            label={t('protectionStopPrice')}
            value={stopPriceDisplay}
            fieldKey="stopPrice"
            copiedField={copiedField}
            onCopy={handleCopy}
            colors={colors}
            styles={styles}
            t={t}
          />

          {protectionState.alertTriggerPrice !== null && (
            <View style={styles.alertInstructionBlock}>
              <CopyableValueRow
                label={t('setBrokerPriceAlertAt', { price: formatUsd(protectionState.alertTriggerPrice) })}
                value={formatUsd(protectionState.alertTriggerPrice)}
                fieldKey="alertPrice"
                copiedField={copiedField}
                onCopy={handleCopy}
                colors={colors}
                styles={styles}
                t={t}
              />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function createStyles(colors: PipelineColorScheme, language: Language) {
  const isHebrew = language === 'he';

  return StyleSheet.create({
    // INTEGRATION NOTE: no backgroundColor/shadow/elevation/marginBottom
    // here — this renders INSIDE PortfolioStockRow's own asset card
    // (index.tsx), directly below its existing Satellite metrics, so it
    // must never look like a second, nested card. A top border + marginTop
    // (matching this app's standard ~6-10px inter-element spacing, e.g.
    // macroContextText/trailingStopText/drawdownText's own marginTop: 6 in
    // index.tsx) is enough to visually separate it from the metrics above
    // without duplicating the parent's own card chrome.
    wrapper: {
      marginTop: 10,
      paddingTop: 10,
      borderTopWidth: 1,
      borderTopColor: colors.background,
    },
    collapsedRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    collapsedLeftGroup: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    ticker: {
      // Ticker symbols stay LTR regardless of app language — identifiers,
      // not translatable text (same convention as every other ticker
      // display in this app).
      color: colors.textPrimary,
      fontSize: 16,
      fontWeight: '700',
      writingDirection: 'ltr',
    },
    currentPrice: {
      // Pure currency value — stays LTR regardless of app language, same
      // reasoning as `ticker` above.
      color: colors.textSecondary,
      fontSize: 15,
      fontWeight: '500',
      writingDirection: 'ltr',
    },
    collapsedRightGroup: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    statusBadge: {
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    // Fixed white text regardless of theme — both statusBadgeColor options
    // (colors.bullish / colors.warning) are saturated enough in both
    // light and dark mode for white to stay legible on top of either.
    // textAlign/writingDirection DO follow the active language — this is
    // translated label text ("Automated Tracking" / "Manual Setup
    // Required"), unlike ticker/currentPrice above.
    statusBadgeText: {
      color: '#FFFFFF',
      fontSize: 11,
      fontWeight: '700',
      textAlign: isHebrew ? 'right' : 'left',
      writingDirection: isHebrew ? 'rtl' : 'ltr',
    },
    expandedSection: {
      marginTop: 12,
    },
    divider: {
      height: 1,
      backgroundColor: colors.background,
      marginBottom: 12,
    },
    orderTypeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 10,
    },
    // Translated label ("Order Type") — RTL/LTR-aware, same convention as
    // every other label text in this app (e.g. allocationText in
    // index.tsx).
    orderTypeLabel: {
      color: colors.textSecondary,
      fontSize: 13,
      fontWeight: '600',
      textAlign: isHebrew ? 'right' : 'left',
      writingDirection: isHebrew ? 'rtl' : 'ltr',
    },
    // The order type VALUE ("Stop Market" / "Trailing Stop") is a fixed
    // enum label from @/utils/protectionState, not translated content —
    // the Protection State Tracker's spec deliberately only calls for
    // translating the surrounding LABELS, not these literal order-type
    // names a broker's own UI would show in English regardless, so this
    // stays LTR.
    orderTypeValue: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: '700',
      writingDirection: 'ltr',
    },
    valueRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 6,
    },
    valueTextGroup: {
      flex: 1,
      marginRight: 12,
    },
    // Translated label ("Stop Price" / "Set Broker Price Alert at: ...").
    valueLabel: {
      color: colors.textSecondary,
      fontSize: 13,
      fontWeight: '600',
      textAlign: isHebrew ? 'right' : 'left',
      writingDirection: isHebrew ? 'rtl' : 'ltr',
    },
    // The value itself (a USD amount or the literal "12%") — never
    // translated, always LTR, exactly what the user types into/compares
    // against their brokerage account.
    valueText: {
      color: colors.textPrimary,
      fontSize: 16,
      fontWeight: '700',
      marginTop: 2,
      writingDirection: 'ltr',
    },
    copyButtonGroup: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    // Translated "Copied!" feedback, shown briefly next to the icon.
    copiedFeedbackText: {
      color: colors.bullish,
      fontSize: 12,
      fontWeight: '600',
      textAlign: isHebrew ? 'right' : 'left',
      writingDirection: isHebrew ? 'rtl' : 'ltr',
    },
    copyButton: {
      padding: 6,
    },
    // The Broker Price Alert instruction gets its own slightly separated,
    // tinted block (Condition A only) so it reads as a distinct
    // instruction rather than just another value row — it's telling the
    // user to do something OUTSIDE this app (set a price alert with their
    // broker), not just reporting a number.
    alertInstructionBlock: {
      marginTop: 8,
      borderRadius: 8,
      paddingHorizontal: 10,
      backgroundColor: colors.background,
    },
  });
}
