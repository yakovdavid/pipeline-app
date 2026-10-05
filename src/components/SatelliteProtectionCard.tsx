import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { PipelineColorScheme } from '@/constants/pipeline-colors';
import { usePipelineTheme } from '@/contexts/theme-context';
import { computeProtectionState, type ProtectionState } from '@/utils/protectionState';

export interface SatelliteProtectionCardProps {
  ticker: string;
  currentPrice: number;
  hwm: number;
}

// How long a copy button shows its "copied" checkmark before reverting to
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

// Which specific copy button last fired its "copied" feedback — distinct
// buttons (stop price vs. alert price) need independent feedback, so this
// is a key, not a bare boolean.
type CopiedField = 'stopPrice' | 'alertPrice' | null;

// A single tappable row: a label, the value itself, and a copy-to-
// clipboard icon button — shared by both the Stop Price and the Broker
// Price Alert rows in the expanded view below, so their layout/behavior
// can never drift apart.
type CopyableValueRowProps = {
  label: string;
  value: string;
  fieldKey: Exclude<CopiedField, null>;
  copiedField: CopiedField;
  onCopy: (fieldKey: Exclude<CopiedField, null>, value: string) => void;
  colors: PipelineColorScheme;
  styles: ReturnType<typeof createStyles>;
};

function CopyableValueRow({ label, value, fieldKey, copiedField, onCopy, colors, styles }: CopyableValueRowProps) {
  const isCopied = copiedField === fieldKey;

  return (
    <View style={styles.valueRow}>
      <View style={styles.valueTextGroup}>
        <Text style={styles.valueLabel}>{label}</Text>
        <Text style={styles.valueText}>{value}</Text>
      </View>
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
  );
}

// SATELLITE PROTECTION CARD: Progressive Disclosure UI for the Protection
// State Tracker (see @/utils/protectionState for the business logic this
// renders). Collapsed, it's a quick-scan overview (ticker, price, a
// colored status badge); expanded, it surfaces the exact order parameters
// the user needs to type into their brokerage account — kept hidden by
// default specifically so a list of many Satellite positions doesn't dump
// every position's full order-ticket detail on screen at once.
export function SatelliteProtectionCard({ ticker, currentPrice, hwm }: SatelliteProtectionCardProps) {
  const { colors, isDarkMode } = usePipelineTheme();
  const styles = useMemo(() => createStyles(colors, isDarkMode), [colors, isDarkMode]);

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
  const statusLabel = isAutomatedTracking ? 'Automated Tracking' : 'Manual Setup Required';

  const stopPriceDisplay =
    typeof protectionState.stopPriceTarget === 'number'
      ? formatUsd(protectionState.stopPriceTarget)
      : protectionState.stopPriceTarget;

  const handleCopy = (fieldKey: Exclude<CopiedField, null>, value: string) => {
    Clipboard.setStringAsync(value).catch(() => {
      // Copying to the clipboard failing is not something the user can
      // act on here; the button simply won't show its "copied" checkmark,
      // which is feedback enough that nothing happened.
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
    <View style={styles.card}>
      {/* COLLAPSED STATE: ticker, current price, and a small status badge
          — tapping anywhere on this row toggles the expanded detail
          below. */}
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
            <Text style={styles.orderTypeLabel}>Order Type</Text>
            <Text style={styles.orderTypeValue}>{protectionState.orderType}</Text>
          </View>

          <CopyableValueRow
            label="Stop Price"
            value={stopPriceDisplay}
            fieldKey="stopPrice"
            copiedField={copiedField}
            onCopy={handleCopy}
            colors={colors}
            styles={styles}
          />

          {protectionState.alertTriggerPrice !== null && (
            <View style={styles.alertInstructionBlock}>
              <CopyableValueRow
                label={`Set Broker Price Alert at: ${formatUsd(protectionState.alertTriggerPrice)}`}
                value={formatUsd(protectionState.alertTriggerPrice)}
                fieldKey="alertPrice"
                copiedField={copiedField}
                onCopy={handleCopy}
                colors={colors}
                styles={styles}
              />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function createStyles(colors: PipelineColorScheme, isDarkMode: boolean) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.cardBackground,
      borderRadius: 12,
      paddingHorizontal: 16,
      paddingVertical: 14,
      marginBottom: 10,
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
      color: colors.textPrimary,
      fontSize: 16,
      fontWeight: '700',
    },
    currentPrice: {
      color: colors.textSecondary,
      fontSize: 15,
      fontWeight: '500',
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
    statusBadgeText: {
      color: '#FFFFFF',
      fontSize: 11,
      fontWeight: '700',
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
    orderTypeLabel: {
      color: colors.textSecondary,
      fontSize: 13,
      fontWeight: '600',
    },
    orderTypeValue: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: '700',
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
    valueLabel: {
      color: colors.textSecondary,
      fontSize: 13,
      fontWeight: '600',
    },
    valueText: {
      color: colors.textPrimary,
      fontSize: 16,
      fontWeight: '700',
      marginTop: 2,
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
