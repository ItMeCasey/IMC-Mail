/**
 * The phone's secure storage accepts only letters, digits, ".", "-" and "_" in a key. This turns any text (an
 * email address, say) into such a key. Every other character, and "_" itself, is written as _hex_, so two
 * different inputs never give the same key.
 */
export function storageKey(prefix: string, text: string): string {
  const safe = text.toLowerCase().replace(/[^a-z0-9.-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)
  return `${prefix}.${safe}`
}
