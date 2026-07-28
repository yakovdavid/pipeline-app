import * as Notifications from 'expo-notifications';

// Foreground notifications are suppressed by default; this makes them
// actually appear while the app is open, which is when a structural stop
// warning is most useful.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

let hasPromptedForPermissions = false;

async function ensureNotificationPermissions(): Promise<boolean> {
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  if (existingStatus === 'granted') {
    return true;
  }
  if (hasPromptedForPermissions) {
    // Already asked once this session — don't re-prompt on every check if
    // the user denied it.
    return false;
  }

  hasPromptedForPermissions = true;
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

// Fires a local (on-device) notification warning that an ETF is trading
// near its 200-day structural support level. Failures here (missing
// permissions, unsupported platform, etc.) are swallowed rather than
// thrown: a notification is a courtesy, not something that should ever
// break the screen that triggered it — the in-app warning banner on the
// stock card is the primary, always-visible signal.
export async function sendStructuralStopNotification(
  ticker: string,
  price: number,
  sma200: number,
): Promise<void> {
  try {
    const granted = await ensureNotificationPermissions();
    if (!granted) {
      return;
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Structural Stop Warning',
        body: `${ticker} is at $${price.toFixed(2)}, within 2% of its 200-day support ($${sma200.toFixed(2)}).`,
      },
      trigger: null,
    });
  } catch (error) {
    console.warn(`Failed to send structural stop notification for ${ticker}:`, error);
  }
}
