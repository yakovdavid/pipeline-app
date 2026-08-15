import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import type { PipelineColorScheme } from '@/constants/pipeline-colors';
import { usePipelineLanguage } from '@/contexts/language-context';
import { usePipelineTheme } from '@/contexts/theme-context';
import { useTickerSearch } from '@/hooks/useTickerSearch';

// Delay hiding the dropdown on blur so a tap on a row registers first —
// onBlur otherwise fires before onPress and the dropdown would vanish
// before the tap is handled.
const BLUR_HIDE_DELAY_MS = 150;

export type TickerAutocompleteProps = {
  value: string;
  onChangeText: (text: string) => void;
  onSelectTicker: (symbol: string) => void;
  onSubmit: () => void;
  editable: boolean;
};

export function TickerAutocomplete({
  value,
  onChangeText,
  onSelectTicker,
  onSubmit,
  editable,
}: TickerAutocompleteProps) {
  const { colors } = usePipelineTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // RUTHLESS LOCALIZATION AUDIT: this component is shared by both the
  // Portfolio Add Asset modal and the Ambush Radar add-ticker row, so its
  // placeholder reads this context directly (matching StockCard's own
  // established pattern) rather than taking the string as a prop.
  const { t } = usePipelineLanguage();

  const [isFocused, setIsFocused] = useState(false);
  const { results, isSearching } = useTickerSearch(value);

  const showDropdown = isFocused && value.trim().length > 0 && (isSearching || results.length > 0);

  const handleSelect = (symbol: string) => {
    onSelectTicker(symbol);
    setIsFocused(false);
  };

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={t('addTickerPlaceholder')}
        placeholderTextColor={colors.textSecondary}
        autoCapitalize="characters"
        autoCorrect={false}
        returnKeyType="done"
        editable={editable}
        onSubmitEditing={onSubmit}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setTimeout(() => setIsFocused(false), BLUR_HIDE_DELAY_MS)}
      />

      {showDropdown && (
        <View style={styles.dropdown}>
          {isSearching ? (
            <View style={styles.dropdownRow}>
              <ActivityIndicator size="small" color={colors.textSecondary} />
            </View>
          ) : (
            results.map((result) => (
              <TouchableOpacity
                key={result.symbol}
                style={styles.dropdownRow}
                onPress={() => handleSelect(result.symbol)}>
                <Text style={styles.dropdownText} numberOfLines={1}>
                  {result.symbol} - {result.shortname} ({result.exchDisp})
                </Text>
              </TouchableOpacity>
            ))
          )}
        </View>
      )}
    </View>
  );
}

// Factory (not a module-level StyleSheet.create) so it re-derives whenever
// the active theme changes — see the identical note in StockCard.tsx.
function createStyles(colors: PipelineColorScheme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      position: 'relative',
      zIndex: 10,
    },
    input: {
      // Ticker symbols are typed/displayed LTR regardless of app language
      // — they're identifiers, not translatable text.
      backgroundColor: colors.cardBackground,
      color: colors.textPrimary,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 16,
      writingDirection: 'ltr',
    },
    dropdown: {
      position: 'absolute',
      top: '100%',
      left: 0,
      right: 0,
      marginTop: 4,
      backgroundColor: colors.cardBackground,
      borderRadius: 8,
      paddingVertical: 4,
      zIndex: 20,
      elevation: 6,
    },
    dropdownRow: {
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    dropdownText: {
      color: colors.textPrimary,
      fontSize: 14,
    },
  });
}
