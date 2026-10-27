import Constants from 'expo-constants'

/** While developing, the computer that serves this app listens on port 8099 for a short status (never mail). */
export async function tell(status: Record<string, unknown>): Promise<void> {
  const host = /^([^/:]+)/.exec(Constants.expoConfig?.hostUri ?? '')?.[1]
  if (!host) return
  try {
    await fetch(`http://${host}:8099/report`, { method: 'POST', body: JSON.stringify(status) })
  } catch {
    // no computer listening; that is fine
  }
}
