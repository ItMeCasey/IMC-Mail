import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture'
import { settings } from './db'

/**
 * Applies the privacy choice: while it is on, Android hides this app's content in the recent-apps list and blocks
 * screenshots and screen recording.
 */
export function applyPrivacy(): void {
  const on = settings.get().privacyScreen
  void (on ? preventScreenCaptureAsync('imc') : allowScreenCaptureAsync('imc')).catch(() => undefined)
}
