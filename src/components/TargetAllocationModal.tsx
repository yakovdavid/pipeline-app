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

import { categoryLabel } from '@/constants/labels';
import type { PipelineColorScheme } from '@/constants/pipeline-colors';
import { usePipelineLanguage, type Language } from '@/contexts/language-context';
import { usePipelineTheme } from '@/contexts/theme-context';
import type { AllocationLayer } from '@/utils/allocation';
import { parseTargetAllocations, type TargetAllocations } from '@/utils/target-allocation-store';

const LAYERS: readonly AllocationLayer[] = ['Core', 'Satellite', 'Quality'];

export type TargetAllocationModalProps = {
  visible: boolean;
  targets: TargetAllocations;
  onSubmit: (targets: TargetAllocations) => void;
  onCancel: () => void;
};

// A field's percent, or null when it isn't a number. Blank is 0, so moving
// to e.g. 80/0/20 doesn't require typing the zero.
function parsePct(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') {
    return 0;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

// DYNAMIC LAYER TARGETS: edits the Core/Satellite/Quality targets. Saving
// is only possible once they sum to 100%. The parent remounts it (a fresh
// `key`) each time it opens, so it always starts from the saved targets.
export function TargetAllocationModal({ visible, targets, onSubmit, onCancel }: TargetAllocationModalProps) {
  const { colors } = usePipelineTheme();
  const { language, t } = usePipelineLanguage();
  const styles = useMemo(() => createStyles(colors, language), [colors, language]);
  const [texts, setTexts] = useState<Record<AllocationLayer, string>>({
    Core: String(targets.Core),
    Satellite: String(targets.Satellite),
    Quality: String(targets.Quality),
  });

  const values = { Core: parsePct(texts.Core), Satellite: parsePct(texts.Satellite), Quality: parsePct(texts.Quality) };
  const parsed = parseTargetAllocations(values);
  const sum = LAYERS.reduce((total, layer) => total + (values[layer] ?? 0), 0);

  const handleSubmit = () => {
    if (parsed === null) {
      Alert.alert(t('invalidTargetsTitle'), t('invalidTargetsMessage'));
      return;
    }
    Keyboard.dismiss();
    onSubmit(parsed);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.avoider}>
          <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
            <View style={styles.card}>
              <View style={styles.header}>
                <Text style={styles.title}>{t('targetAllocation')}</Text>
                <TouchableOpacity
                  onPress={onCancel}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel={t('cancel')}>
                  <Ionicons name="close" size={22} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>

              <Text style={styles.hint}>{t('targetAllocationHint')}</Text>

              {LAYERS.map((layer) => (
                <View key={layer} style={styles.fieldRow}>
                  <Text style={styles.label}>{categoryLabel(t, layer)}</Text>
                  <TextInput
                    style={styles.input}
                    value={texts[layer]}
                    onChangeText={(text) => setTexts((previous) => ({ ...previous, [layer]: text }))}
                    placeholder="0"
                    placeholderTextColor={colors.textSecondary}
                    keyboardType="decimal-pad"
                    maxLength={5}
                    onSubmitEditing={handleSubmit}
                    accessibilityLabel={`${t('targetAllocation')}: ${categoryLabel(t, layer)}`}
                  />
                  <Text style={styles.percentSign}>%</Text>
                </View>
              ))}

              <Text style={[styles.sum, parsed === null && styles.invalid]}>
                {t('targetAllocationSum', { sum: (Math.round(sum * 10) / 10).toString() })}
              </Text>

              <TouchableOpacity
                style={[styles.submitButton, parsed === null && styles.submitButtonDisabled]}
                onPress={handleSubmit}
                accessibilityRole="button">
                <Text style={styles.submitButtonText}>{t('saveTargets')}</Text>
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
      marginBottom: 8,
    },
    title: {
      color: colors.textPrimary,
      fontSize: 18,
      fontWeight: '700',
      writingDirection,
    },
    hint: {
      color: colors.textSecondary,
      fontSize: 12,
      marginBottom: 12,
      textAlign,
      writingDirection,
    },
    fieldRow: {
      flexDirection: isHebrew ? 'row-reverse' : 'row',
      alignItems: 'center',
      gap: 10,
      marginBottom: 10,
    },
    label: {
      flex: 1,
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: '600',
      textAlign,
      writingDirection,
    },
    input: {
      width: 90,
      backgroundColor: colors.background,
      color: colors.textPrimary,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      fontSize: 16,
      textAlign: 'center',
      writingDirection: 'ltr',
    },
    percentSign: {
      color: colors.textSecondary,
      fontSize: 15,
      fontWeight: '600',
    },
    sum: {
      color: colors.textSecondary,
      fontSize: 13,
      fontWeight: '700',
      marginTop: 4,
      textAlign,
      writingDirection,
    },
    invalid: {
      color: colors.bearish,
    },
    submitButton: {
      backgroundColor: colors.bullish,
      borderRadius: 8,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 16,
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
