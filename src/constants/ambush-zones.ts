import type { PipelineColorScheme } from '@/constants/pipeline-colors';
import type { TranslationKey } from '@/contexts/language-context';
import type { AmbushReadinessZone } from '@/utils/ambush-grouping';

// Section header titles (with their emoji) for each readiness zone.
export const AMBUSH_ZONE_TITLE_KEY: Record<AmbushReadinessZone, TranslationKey> = {
  valueZone: 'ambushZoneValueTitle',
  watch: 'ambushZoneWatchTitle',
  invalidated: 'ambushZoneInvalidatedTitle',
};

// Short labels for the status badge on a QualityAmbushCard.
export const AMBUSH_ZONE_BADGE_KEY: Record<AmbushReadinessZone, TranslationKey> = {
  valueZone: 'ambushZoneValue',
  watch: 'ambushZoneWatch',
  invalidated: 'ambushZoneInvalidated',
};

export type AmbushZoneColors = {
  // Section header accent bar and title text.
  accent: string;
  // Status badge fill and the text drawn on it.
  badgeBackground: string;
  badgeText: string;
};

// One palette per zone, built from the app's existing theme tokens:
// green for actionable, amber for standby, and the neutral "invalidated"
// gray the Pullback Depth badge already uses for a Macro Override.
export function ambushZoneColors(colors: PipelineColorScheme, zone: AmbushReadinessZone): AmbushZoneColors {
  switch (zone) {
    case 'valueZone':
      return { accent: colors.bullish, badgeBackground: colors.bullish, badgeText: colors.textPrimary };
    case 'watch':
      return { accent: colors.warning, badgeBackground: colors.warning, badgeText: colors.warningText };
    case 'invalidated':
    default:
      return { accent: colors.textSecondary, badgeBackground: colors.invalidated, badgeText: colors.textPrimary };
  }
}
