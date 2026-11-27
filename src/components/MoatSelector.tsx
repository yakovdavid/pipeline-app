import { memo, useMemo } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { PipelineColorScheme } from '@/constants/pipeline-colors';
import { usePipelineLanguage, type Language, type TFunction } from '@/contexts/language-context';
import { usePipelineTheme } from '@/contexts/theme-context';
import type { QualityMoat } from '@/types/ambush';
import { getMoatRating, MOAT_RATINGS, saveMoatRating, useMoatRatings } from '@/utils/moat-store';

// MANUAL MOAT (backlog P1): the one editor for a ticker's moat rating,
// shared by the Ambush Radar's Quality card and the Portfolio's Quality
// row. Four chips; the selected one is filled. Saving publishes at once,
// so every screen re-evaluates the Value Zone on the new rating.

export function moatLabel(t: TFunction, moat: QualityMoat): string {
  switch (moat) {
    case 'Wide':
      return t('moatWide');
    case 'Narrow':
      return t('moatNarrow');
    case 'None':
      return t('moatNone');
    case 'Unrated':
    default:
      return t('moatUnrated');
  }
}

export type MoatSelectorProps = {
  ticker: string;
};

export const MoatSelector = memo(function MoatSelector({ ticker }: MoatSelectorProps) {
  const { colors } = usePipelineTheme();
  const { language, t } = usePipelineLanguage();
  const styles = useMemo(() => createStyles(colors, language), [colors, language]);
  const { ratings, isLoaded } = useMoatRatings();
  const current = getMoatRating(ticker, ratings);

  const handleSelect = (moat: QualityMoat) => {
    if (moat === current) {
      return;
    }
    saveMoatRating(ticker, moat).catch(() => {
      Alert.alert(t('moatSaveFailedTitle'), t('moatSaveFailedMessage'));
    });
  };

  return (
    <View style={styles.container}>
      <Text style={styles.label}>{t('moatLabel')}</Text>
      <View style={styles.chips}>
        {MOAT_RATINGS.map((moat) => {
          const isSelected = moat === current;
          return (
            <TouchableOpacity
              key={moat}
              style={[styles.chip, isSelected && styles.chipSelected]}
              onPress={() => handleSelect(moat)}
              disabled={!isLoaded}
              hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected, disabled: !isLoaded }}
              accessibilityLabel={`${t('moatLabel')} ${ticker}: ${moatLabel(t, moat)}`}>
              <Text style={[styles.chipText, isSelected && styles.chipTextSelected]}>{moatLabel(t, moat)}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
});

function createStyles(colors: PipelineColorScheme, language: Language) {
  const isHebrew = language === 'he';
  return StyleSheet.create({
    container: {
      flexDirection: isHebrew ? 'row-reverse' : 'row',
      alignItems: 'center',
      gap: 8,
      flexWrap: 'wrap',
    },
    label: {
      color: colors.textSecondary,
      fontSize: 10,
      fontWeight: '700',
      textTransform: 'uppercase',
      writingDirection: isHebrew ? 'rtl' : 'ltr',
    },
    chips: {
      flexDirection: isHebrew ? 'row-reverse' : 'row',
      gap: 6,
    },
    chip: {
      borderWidth: 1,
      borderColor: colors.quality,
      borderRadius: 999,
      paddingHorizontal: 9,
      paddingVertical: 2,
    },
    chipSelected: {
      backgroundColor: colors.quality,
    },
    chipText: {
      color: colors.textPrimary,
      fontSize: 12,
      fontWeight: '600',
      writingDirection: isHebrew ? 'rtl' : 'ltr',
    },
    chipTextSelected: {
      fontWeight: '800',
    },
  });
}
