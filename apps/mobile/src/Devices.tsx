import { useCallback, useEffect, useState } from 'react'
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import * as Clipboard from 'expo-clipboard'
import type { SyncDevice, SyncStatus } from '@imc/core'
import { notifyChanged } from './changes'
import { pair, rotateKey, sync, syncNow, unpair, watchSync } from './phonesync'
import { describeError, when } from './screens'
import { AppBar, BackIcon, IconButton } from './chrome'
import { Body, Button, colors, ErrorText, Link, Note, Screen } from './ui'

/** Pairing this phone with the desktop app (scan its QR code or paste the code), and what syncing is doing. */
export default function Devices({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<SyncStatus>(() => sync.status())
  const [devices, setDevices] = useState<SyncDevice[] | null>(null)
  const [code, setCode] = useState('')
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [permission, askCamera] = useCameraPermissions()
  const [newCode, setNewCode] = useState<string | null>(null)

  useEffect(() => watchSync(setStatus), [])

  const loadDevices = useCallback(async () => {
    if (!sync.status().paired) return setDevices(null)
    try {
      setDevices(await sync.devices())
    } catch {
      setDevices(null)
    }
  }, [])
  useEffect(() => void loadDevices(), [loadDevices, status.paired, status.lastSyncAt])

  const join = async (text: string) => {
    setBusy(true)
    setError(null)
    setScanning(false)
    try {
      setStatus(await pair(text))
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  const scan = async () => {
    const p = permission?.granted ? permission : await askCamera()
    if (!p.granted) return setError('Camera access is needed to scan the code. You can paste the code instead.')
    setScanning(true)
  }

  const replaceKey = () =>
    Alert.alert('Replace the key?', 'This ends the sync group on the server and starts a new one with a new key. Your other devices stop syncing until you add them again with the new code. Nothing is lost.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Replace',
        style: 'destructive',
        onPress: () => {
          setBusy(true)
          setError(null)
          rotateKey()
            .then((code) => {
              setNewCode(code)
              setStatus(sync.status())
            })
            .catch((e: unknown) => setError(describeError(e)))
            .finally(() => setBusy(false))
        }
      }
    ])

  const stop = () =>
    Alert.alert('Stop syncing?', 'Your mail and settings stay on this phone, but it will no longer share changes with your other devices.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Stop syncing',
        style: 'destructive',
        onPress: () =>
          void unpair().then(() => {
            setStatus(sync.status())
            setDevices(null)
            notifyChanged()
          })
      }
    ])

  return (
    <Screen>
      <AppBar left={<IconButton label="Back" onPress={onBack}><BackIcon /></IconButton>} title="Devices" />
      <Body refreshing={status.syncing} onRefresh={status.paired ? () => void syncNow() : undefined}>
        {status.paired ? (
          <>
            <Note>
              Syncing as {status.deviceName}. {status.syncing ? 'Syncing now…' : status.lastSyncAt ? `Last synced ${when(status.lastSyncAt)}.` : 'Not synced yet.'}
            </Note>
            {status.error !== null && <ErrorText>{status.error}</ErrorText>}
            {status.revoked && <ErrorText>Sync was reset or another device removed this phone. Stop syncing, then pair with the new code.</ErrorText>}
            <Button onPress={() => void syncNow()} disabled={status.syncing}>
              Sync now
            </Button>
            {devices?.map((d) => (
              <View key={d.id} style={st.device}>
                <Text style={{ color: colors.text }}>
                  {d.name}
                  {d.current ? ' (this phone)' : ''}
                </Text>
                <Text style={{ color: colors.muted, fontSize: 12 }}>Last seen {when(d.lastSeen)}</Text>
              </View>
            ))}
            {newCode !== null && (
              <View style={st.device}>
                <Text style={{ color: colors.text }}>New pairing code</Text>
                <Text selectable style={{ color: colors.soft, fontSize: 11, fontFamily: 'monospace' }}>
                  {newCode}
                </Text>
                <Link onPress={() => void Clipboard.setStringAsync(newCode)}>Copy code</Link>
                <Note>On each other device, turn sync off, then join with this code. Anyone with it can read your synced settings, so close this when you are done.</Note>
                <Link onPress={() => setNewCode(null)}>Hide</Link>
              </View>
            )}
            <Button kind="quiet" onPress={replaceKey} disabled={busy}>
              Replace the key…
            </Button>
            <Button kind="danger" onPress={stop}>
              Stop syncing on this phone
            </Button>
          </>
        ) : (
          <>
            <Note>On the desktop app open Settings › Devices › Add phone, then scan its code here. Everything is encrypted before it leaves the device.</Note>
            {scanning ? (
              <View style={st.camera}>
                <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={(r) => void join(r.data)} />
              </View>
            ) : (
              <Button onPress={() => void scan()} disabled={busy}>
                Scan the QR code
              </Button>
            )}
            {scanning && <Link onPress={() => setScanning(false)}>Cancel scanning</Link>}
            <Note>Or paste the code:</Note>
            <TextInput value={code} onChangeText={setCode} placeholder="imcsync1:…" placeholderTextColor={colors.faint} autoCapitalize="none" autoCorrect={false} style={st.input} />
            <View style={{ flexDirection: 'row', gap: 20 }}>
              <Link onPress={() => void Clipboard.getStringAsync().then(setCode)}>Paste</Link>
              <Link disabled={busy || code.trim() === ''} onPress={() => void join(code)}>
                {busy ? 'Pairing…' : 'Pair'}
              </Link>
            </View>
            {error !== null && <ErrorText>{error}</ErrorText>}
          </>
        )}
      </Body>
    </Screen>
  )
}

const st = StyleSheet.create({
  device: { backgroundColor: colors.raised, borderRadius: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, padding: 12, gap: 2 },
  camera: { height: 300, borderRadius: 4, overflow: 'hidden' },
  input: { color: colors.text, backgroundColor: colors.raised, borderRadius: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, paddingHorizontal: 12, paddingVertical: 9 }
})
