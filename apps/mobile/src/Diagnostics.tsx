import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Constants from 'expo-constants'
import { StatusBar } from 'expo-status-bar'
import sanitizeHtml from 'sanitize-html'
import {
  assess,
  canonicalRequest,
  classify,
  hashBody,
  newDataKey,
  newDeviceId,
  newDeviceKeys,
  openPayload,
  parseICS,
  safeWebUrl,
  sealPayload,
  signText,
  verifyText
} from '@imc/core'

// Phase 0: proves that the code shared with the desktop (packages/core) runs on a phone.
// Each button runs a piece of that shared code and shows what it did.

const ICS = ['BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:phase0@imc', 'SUMMARY:Sponsor call', 'DTSTART:20261103T150000Z', 'DTEND:20261103T153000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')

type Check = { name: string; run: () => Promise<string> | string }

/** Signing a request the way a device signs sync requests: new key pair, sign, check, and check a changed request fails. */
const signingCheck = async (): Promise<string> => {
  const keys = await newDeviceKeys()
  const text = canonicalRequest({ method: 'POST', path: '/v1/sync', timestamp: Date.now(), bodyHash: await hashBody('{}') })
  const sig = await signText(keys.privateKey, text)
  const ok = await verifyText(keys.publicKey, text, sig)
  const changed = await verifyText(keys.publicKey, text + 'x', sig)
  return `signature ${sig.length} chars, verifies: ${ok}, changed text verifies: ${changed}`
}

const checks: Check[] = [
  {
    name: 'Mail categories',
    run: () => JSON.stringify(classify({ subject: 'Sponsorship opportunity for your channel', fromName: 'Brand Team', fromAddr: 'partners@brand.example', text: 'We would like to pay you to feature our product' })).slice(0, 220)
  },
  { name: 'Meeting invitations (iCalendar)', run: () => JSON.stringify(parseICS(ICS)).slice(0, 220) },
  { name: 'Sanitizer', run: () => sanitizeHtml('<p onclick=x>hi<script>1</script></p>') },
  { name: 'Safe links', run: () => `${safeWebUrl('https://example.com/join')} / ${safeWebUrl('javascript:alert(1)')}` },
  { name: 'Scam shield', run: () => JSON.stringify(assess({ fromName: 'PayPal', fromAddr: 'x@paypa1-secure.example', subject: 'Verify now', text: 'click here' })).slice(0, 220) },
  { name: 'Sync signing (ECDSA)', run: () => signingCheck() },
  {
    name: 'Sync encryption (AES-GCM)',
    run: async () => {
      const key = newDataKey()
      const env = { id: 'label-1', type: 'label', hlc: `${'0'.repeat(15)}-0000-${newDeviceId()}`, deleted: false }
      const sealed = await sealPayload(key, env, { name: 'Sponsors' })
      return JSON.stringify(await openPayload(key, env, sealed))
    }
  }
]

const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** While developing, the computer that serves this app also listens for a report of these checks (port 8099). */
const reportUrl = (): string | null => {
  // The address of the development server, such as 192.168.1.16:8081, is also where the report goes.
  const host = /^([^/:]+)/.exec(Constants.expoConfig?.hostUri ?? '')?.[1]
  return host ? `http://${host}:8099/report` : null
}

export default function Diagnostics({ onBack }: { onBack: () => void }) {
  const [out, setOut] = useState<Record<string, string>>({})
  const [report, setReport] = useState<string | null>(null)

  const runOne = async (c: Check): Promise<string> => {
    try {
      return String(await c.run())
    } catch (e) {
      return `FAILED: ${describeError(e)}`
    }
  }

  const run = async (c: Check) => {
    const result = await runOne(c)
    setOut((o) => ({ ...o, [c.name]: result }))
  }

  const runAll = async () => {
    const results: Record<string, string> = {}
    for (const c of checks) results[c.name] = await runOne(c)
    setOut(results)
    const url = reportUrl()
    if (!url) return setReport('Not sent: no computer address.')
    try {
      await fetch(url, { method: 'POST', body: JSON.stringify(results) })
      setReport('Sent to the computer.')
    } catch (e) {
      setReport(`Could not send: ${describeError(e)}`)
    }
  }

  return (
    <View style={s.root}>
      <StatusBar style="auto" />
      <ScrollView contentContainerStyle={s.body}>
        <Pressable accessibilityRole="button" onPress={onBack}>
          <Text style={s.note}>Back</Text>
        </Pressable>
        <Text style={s.title}>Diagnostics</Text>
        <Text style={s.note}>The code shared with the desktop, running on this phone.</Text>
        <Pressable accessibilityRole="button" onPress={() => void runAll()} style={[s.button, s.primary]}>
          <Text style={s.buttonText}>Run all checks and send to the computer</Text>
        </Pressable>
        {report !== null && <Text style={s.result}>{report}</Text>}
        {checks.map((c) => (
          <View key={c.name} style={s.card}>
            <Pressable accessibilityRole="button" onPress={() => void run(c)} style={s.button}>
              <Text style={s.buttonText}>{c.name}</Text>
            </Pressable>
            {out[c.name] !== undefined && <Text style={s.result}>{out[c.name]}</Text>}
          </View>
        ))}
      </ScrollView>
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#101418' },
  body: { padding: 20, paddingTop: 56, gap: 12 },
  title: { color: '#f2f4f7', fontSize: 22, fontWeight: '600' },
  note: { color: '#9aa4b2', marginBottom: 8 },
  card: { gap: 6 },
  primary: { backgroundColor: '#2b6cb0' },
  button: { backgroundColor: '#1d2733', borderRadius: 8, padding: 14 },
  buttonText: { color: '#f2f4f7', fontSize: 16 },
  result: { color: '#c7d0dc', fontFamily: 'monospace', fontSize: 12 }
})
