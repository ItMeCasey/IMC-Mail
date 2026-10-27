import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import type { OAuthProviderId } from '@imc/core'
import { ImapClient, Pop3Client, SmtpClient } from '@imc/mail'
import { addPasswordAccount, signIn, type PhoneAccount } from './auth'
import { describeError } from './screens'
import { tcpConnect } from './tcp'
import { AppBar, BackIcon, IconButton } from './chrome'
import { Body, Button, colors, ErrorText, Link, Note, Screen } from './ui'

type Security = 'tls' | 'starttls'

/** Adding an account: Google or Microsoft through their sign-in page, or any other provider with a server and password. */
export default function AddAccount({ onAdded, onBack }: { onAdded: (a: PhoneAccount) => void; onBack: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [other, setOther] = useState(false)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [protocol, setProtocol] = useState<'imap' | 'pop3'>('imap')
  const [inHost, setInHost] = useState('')
  const [inPort, setInPort] = useState('993')
  const [inSecurity, setInSecurity] = useState<Security>('tls')
  const [outHost, setOutHost] = useState('')
  const [outPort, setOutPort] = useState('587')
  const [outSecurity, setOutSecurity] = useState<Security>('starttls')

  const oauth = async (p: OAuthProviderId) => {
    setBusy(p)
    setError(null)
    try {
      onAdded(await signIn(p))
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(null)
    }
  }

  /** Server names follow the address (imap.<domain>, smtp.<domain>) until the person types their own. */
  const [edited, setEdited] = useState(false)
  const guess = (address: string) => {
    setEmail(address)
    const domain = address.split('@')[1]
    if (domain && !edited) {
      setInHost(`${protocol === 'pop3' ? 'pop' : 'imap'}.${domain}`)
      setOutHost(`smtp.${domain}`)
    }
  }

  const choose = (p: 'imap' | 'pop3') => {
    setProtocol(p)
    setInPort(p === 'imap' ? '993' : '995')
    setInSecurity('tls')
    const domain = email.split('@')[1]
    if (domain && !edited) setInHost(`${p === 'pop3' ? 'pop' : 'imap'}.${domain}`)
  }

  const save = async () => {
    setBusy('password')
    setError(null)
    try {
      const incoming = { host: inHost.trim(), port: Number(inPort), security: inSecurity }
      const outgoing = { host: outHost.trim(), port: Number(outPort), security: outSecurity }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new Error('Enter the full email address.')
      if (!incoming.host || !outgoing.host || !Number.isInteger(incoming.port) || !Number.isInteger(outgoing.port)) throw new Error('Fill in both servers and their ports.')
      if (!password) throw new Error('Enter the password.')
      const user = username.trim() || email.trim()
      // Check the details before saving anything: sign in to each server.
      if (protocol === 'imap') {
        const c = new ImapClient(tcpConnect, incoming)
        await c.open()
        try {
          await c.login(user, password)
        } finally {
          await c.logout().catch(() => undefined)
        }
      } else {
        const c = new Pop3Client(tcpConnect, incoming)
        await c.open()
        try {
          await c.login(user, password)
        } finally {
          await c.quit().catch(() => undefined)
        }
      }
      const smtp = new SmtpClient(tcpConnect, outgoing)
      await smtp.open()
      try {
        await smtp.authPlain(user, password)
      } finally {
        await smtp.quit().catch(() => undefined)
      }
      onAdded(await addPasswordAccount({ email, name: name || email.split('@')[0]!, username: username.trim(), password, protocol, incoming, outgoing }))
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Screen>
      <AppBar left={<IconButton label="Back" onPress={onBack}><BackIcon /></IconButton>} title="Add an account" />
      <Body>
        <Note>Google and Microsoft sign in on their own page, so this app never sees your password.</Note>
        <Button disabled={busy !== null} onPress={() => void oauth('gmail')}>
          {busy === 'gmail' ? 'Waiting for Google…' : 'Add a Google account'}
        </Button>
        <Button disabled={busy !== null} onPress={() => void oauth('microsoft')}>
          {busy === 'microsoft' ? 'Waiting for Microsoft…' : 'Add a Microsoft account'}
        </Button>
        <Button kind="quiet" onPress={() => setOther(!other)}>
          Another provider (IMAP or POP3)
        </Button>
        {other && (
          <View style={{ gap: 10 }}>
            <Note>Use an app password if your provider offers one. It is kept in this phone's keystore.</Note>
            <Input label="Email address" value={email} onChange={guess} keyboard="email-address" />
            <Input label="Your name" value={name} onChange={setName} />
            <Input label="Password" value={password} onChange={setPassword} secret />
            <Input label="User name (if not the address)" value={username} onChange={setUsername} />
            <View style={st.row}>
              <Link onPress={() => choose('imap')}>{protocol === 'imap' ? '● IMAP' : '○ IMAP'}</Link>
              <Link onPress={() => choose('pop3')}>{protocol === 'pop3' ? '● POP3' : '○ POP3'}</Link>
            </View>
            <Input label="Incoming server" value={inHost} onChange={(v) => (setEdited(true), setInHost(v))} />
            <View style={st.row}>
              <Input label="Port" value={inPort} onChange={setInPort} keyboard="number-pad" />
              <Link onPress={() => setInSecurity(inSecurity === 'tls' ? 'starttls' : 'tls')}>{inSecurity === 'tls' ? 'TLS' : 'STARTTLS'}</Link>
            </View>
            <Input label="Outgoing server (SMTP)" value={outHost} onChange={(v) => (setEdited(true), setOutHost(v))} />
            <View style={st.row}>
              <Input label="Port" value={outPort} onChange={setOutPort} keyboard="number-pad" />
              <Link onPress={() => setOutSecurity(outSecurity === 'tls' ? 'starttls' : 'tls')}>{outSecurity === 'tls' ? 'TLS' : 'STARTTLS'}</Link>
            </View>
            <Button disabled={busy !== null} onPress={() => void save()}>
              {busy === 'password' ? 'Checking the servers…' : 'Check and add'}
            </Button>
          </View>
        )}
        {error !== null && <ErrorText>{error}</ErrorText>}
      </Body>
    </Screen>
  )
}

function Input({ label, value, onChange, secret, keyboard }: { label: string; value: string; onChange: (v: string) => void; secret?: boolean; keyboard?: 'email-address' | 'number-pad' }) {
  return (
    <View style={{ gap: 4, flex: 1 }}>
      <Text style={st.label}>{label}</Text>
      <TextInput value={value} onChangeText={onChange} secureTextEntry={secret} keyboardType={keyboard} autoCapitalize="none" autoCorrect={false} style={st.input} placeholderTextColor={colors.faint} />
    </View>
  )
}

const st = StyleSheet.create({
  label: { color: colors.muted, fontSize: 13 },
  input: { color: colors.text, backgroundColor: colors.raised, borderRadius: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, paddingHorizontal: 12, paddingVertical: 9, fontSize: 15 },
  row: { flexDirection: 'row', gap: 20, alignItems: 'flex-end' }
})
