import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import sanitizeHtml from 'sanitize-html'
import { assess, classify, newDataKey, newDeviceId, openPayload, parseICS, safeWebUrl, sealPayload } from '@imc/core'

// Phase 0: proves that the code shared with the desktop (packages/core) bundles for Android under
// Hermes and runs on a phone. Each button runs a piece of that shared code and shows what it did.

const ICS = ['BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:phase0@imc', 'SUMMARY:Sponsor call', 'DTSTART:20261103T150000Z', 'DTEND:20261103T153000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')

type Check = { name: string; run: () => Promise<string> | string }

const checks: Check[] = [
  {
    name: 'Mail categories',
    run: () => JSON.stringify(classify({ subject: 'Sponsorship opportunity for your channel', fromName: 'Brand Team', fromAddr: 'partners@brand.example', text: 'We would like to pay you to feature our product' })).slice(0, 220)
  },
  { name: 'Meeting invitations (iCalendar)', run: () => JSON.stringify(parseICS(ICS)).slice(0, 220) },
  { name: 'Sanitizer', run: () => sanitizeHtml('<p onclick=x>hi<script>1</script></p>') },
  { name: 'Safe links', run: () => `${safeWebUrl('https://example.com/join')} / ${safeWebUrl('javascript:alert(1)')}` },
  { name: 'Scam shield', run: () => JSON.stringify(assess({ fromName: 'PayPal', fromAddr: 'x@paypa1-secure.example', subject: 'Verify now', text: 'click here' })).slice(0, 220) },
  {
    name: 'Sync encryption (needs Web Crypto)',
    run: async () => {
      const key = newDataKey()
      const env = { id: 'label-1', type: 'label', hlc: `${'0'.repeat(15)}-0000-${newDeviceId()}`, deleted: false }
      const sealed = await sealPayload(key, env, { name: 'Sponsors' })
      return JSON.stringify(await openPayload(key, env, sealed))
    }
  }
]

export default function App() {
  const [out, setOut] = useState<Record<string, string>>({})
  const run = async (c: Check) => {
    try {
      const result = String(await c.run())
      setOut((o) => ({ ...o, [c.name]: result }))
    } catch (e) {
      setOut((o) => ({ ...o, [c.name]: `FAILED: ${e instanceof Error ? e.message : String(e)}` }))
    }
  }
  return (
    <View style={s.root}>
      <StatusBar style="auto" />
      <ScrollView contentContainerStyle={s.body}>
        <Text style={s.title}>IMC-Mail for Android</Text>
        <Text style={s.note}>Phase 0: the code shared with the desktop, running on this phone.</Text>
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
  button: { backgroundColor: '#1d2733', borderRadius: 8, padding: 14 },
  buttonText: { color: '#f2f4f7', fontSize: 16 },
  result: { color: '#c7d0dc', fontFamily: 'monospace', fontSize: 12 }
})
