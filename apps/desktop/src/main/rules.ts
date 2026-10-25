import { matchesRule, type Category, type Rule } from '@imc/core'
import type { MailStore } from './store'

/** What a rule may do to a message; the message service provides the real versions. */
export interface RuleActor {
  setFlags(id: string, change: { seen?: boolean; flagged?: boolean }): Promise<void>
  archive(id: string): Promise<void>
}

/**
 * Applies the user's rules to inbox mail. A rule that fails on one message (offline, server
 * refusal) must not stop the others, so every action is attempted on its own.
 */
export class RuleEngine {
  constructor(
    private store: MailStore,
    private actor: RuleActor
  ) {}

  /** Runs every enabled rule (or only `only`) over these messages. Returns how many messages matched something. */
  async apply(ids: string[], only?: string): Promise<number> {
    const rules = this.store.listRules().filter((r) => r.enabled && (!only || r.id === only))
    if (rules.length === 0) return 0
    let matched = 0
    for (const { id, target } of this.store.ruleTargets(ids)) {
      let hit = false
      for (const rule of rules) {
        if (!matchesRule(rule.match, target)) continue
        hit = true
        const archived = await this.act(id, rule)
        if (archived) break // it has left the inbox; later rules have nothing to act on
      }
      if (hit) matched++
    }
    return matched
  }

  /** Returns true when the message was archived. */
  private async act(id: string, rule: Rule): Promise<boolean> {
    const a = rule.actions
    try {
      if (a.labelId) {
        const have = this.store.labelIdsOf(id)
        if (!have.includes(a.labelId)) this.store.setLabels(id, [...have, a.labelId])
      }
      if (a.category) this.store.setCategory(id, a.category as Category)
    } catch {
      /* a message with no Message-ID cannot be labelled; the rest still applies */
    }
    if (a.markRead || a.star) {
      await this.actor.setFlags(id, { ...(a.markRead ? { seen: true } : {}), ...(a.star ? { flagged: true } : {}) }).catch(() => {})
    }
    if (a.archive) {
      return this.actor.archive(id).then(
        () => true,
        () => false
      )
    }
    return false
  }
}
