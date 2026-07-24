import { useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { PipelineColors } from '@/constants/pipeline-colors';
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
        placeholder="Add ticker (e.g. MSFT)"
        placeholderTextColor={PipelineColors.textSecondary}
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
              <ActivityIndicator size="small" color={PipelineColors.textSecondary} />
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    position: 'relative',
    zIndex: 10,
  },
  input: {
    backgroundColor: PipelineColors.cardBackground,
    color: PipelineColors.textPrimary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  dropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    marginTop: 4,
    backgroundColor: PipelineColors.cardBackground,
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
    color: PipelineColors.textPrimary,
    fontSize: 14,
  },
});
