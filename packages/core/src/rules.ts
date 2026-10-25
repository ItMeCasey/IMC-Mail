/** What a rule looks at: the headers and first line of a message. */
export interface RuleTarget {
  fromName: string
  fromAddr: string
  to: string
  subject: string
  snippet: string
}

export interface RuleMatch {
  /** Each filled-in field must appear (case-insensitive) in the message. Empty fields are ignored. */
  from: string
  to: string
  subject: string
  /** Words anywhere in the subject or opening text. */
  contains: string
}

/** True when the rule has at least one condition, so an empty rule never matches everything. */
export const ruleHasConditions = (m: RuleMatch): boolean =>
  [m.from, m.to, m.subject, m.contains].some((v) => v.trim() !== '')

const has = (haystack: string, needle: string): boolean => haystack.toLowerCase().includes(needle.trim().toLowerCase())

export function matchesRule(match: RuleMatch, t: RuleTarget): boolean {
  if (!ruleHasConditions(match)) return false
  if (match.from.trim() && !has(`${t.fromName} ${t.fromAddr}`, match.from)) return false
  if (match.to.trim() && !has(t.to, match.to)) return false
  if (match.subject.trim() && !has(t.subject, match.subject)) return false
  if (match.contains.trim() && !has(`${t.subject} ${t.snippet}`, match.contains)) return false
  return true
}
