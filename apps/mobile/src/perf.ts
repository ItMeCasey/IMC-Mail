/** Logs how long a step took (visible with `adb logcat -s ReactNativeJS`), and returns the time for the next step. */
export const stamp = (label: string, since: number): number => {
  const now = Date.now()
  console.log(`[perf] ${label} ${now - since}ms`)
  return now
}
