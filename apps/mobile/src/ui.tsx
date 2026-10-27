import { useEffect, useState, type ReactNode } from 'react'
import { Appearance, Keyboard, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Category } from '@imc/core'

// "Studio Track Sheet", the same look as the desktop app: flat color, hairline rules, square corners, one type family,
// and a colored tape mark down the edge of a row for what kind of mail it is. Dark or light follows the phone's setting
// (read when the app starts). The values are the desktop's tokens (apps/desktop/src/renderer/src/styles/tokens.css).

const dark = {
  ground: '#0d0f12',
  rail: '#13161a',
  sheet: '#171a1f',
  raised: '#1d2128',
  selected: '#232b3b',
  line: '#2a2f37',
  lineStrong: '#667180',
  ink: '#e8ebef',
  ink2: '#b5bcc6',
  ink3: '#8f97a3',
  accent: '#7d9fff',
  onAccent: '#0a1020',
  alert: '#ff7a70',
  attn: '#f2c230',
  onAttn: '#14110a',
  ok: '#4cc38a',
  tape: ['#7b7ff5', '#2fcf9a', '#f5a524', '#f0609e', '#2bc3e0', '#a07bf5', '#f0605d', '#9bd03a']
}

const light: typeof dark = {
  ground: '#e6e9ed',
  rail: '#eff1f4',
  sheet: '#fafbfc',
  raised: '#ffffff',
  selected: '#dfe8fb',
  line: '#d3d9e0',
  lineStrong: '#7d8794',
  ink: '#1b1f24',
  ink2: '#424b56',
  ink3: '#5b6571',
  accent: '#2650c9',
  onAccent: '#ffffff',
  alert: '#bf241b',
  attn: '#f2c230',
  onAttn: '#1a1608',
  ok: '#17734a',
  tape: ['#5256d9', '#0f8f68', '#b86e00', '#c8317a', '#0a7f96', '#7248d0', '#c63a37', '#5f8a0c']
}

export const isLight = Appearance.getColorScheme() === 'light'
const t = isLight ? light : dark

export const colors = {
  /** The page behind everything. */
  bg: t.sheet,
  rail: t.rail,
  raised: t.raised,
  selected: t.selected,
  line: t.line,
  lineStrong: t.lineStrong,
  text: t.ink,
  soft: t.ink2,
  muted: t.ink3,
  faint: t.ink3,
  accent: t.accent,
  onAccent: t.onAccent,
  link: t.accent,
  danger: t.alert,
  warn: t.attn,
  ok: t.ok,
  tape: t.tape
}

/** The tape color for a kind of mail, or null when it has none. */
export const tapeFor = (c: Category): string | null => ({ sponsorship: t.tape[1]!, collab: t.tape[0]!, platform: t.tape[5]!, invoice: t.tape[2]!, fan: t.tape[3]!, cold: t.tape[6]!, other: null })[c]

export const radius = 4
const numbers = { fontVariant: ['tabular-nums' as const] }

/** A whole screen: padded for the system bars, with an optional fixed bottom bar kept above the navigation buttons. */
/** How tall the on-screen keyboard is (0 when hidden). The window does not shrink for it, so screens pad themselves. */
function useKeyboardHeight(): number {
  const [h, setH] = useState(0)
  useEffect(() => {
    const a = Keyboard.addListener('keyboardDidShow', (e) => setH(e.endCoordinates.height))
    const b = Keyboard.addListener('keyboardDidHide', () => setH(0))
    return () => (a.remove(), b.remove())
  }, [])
  return h
}

export function Screen({ children, footer, style }: { children: ReactNode; footer?: ReactNode; style?: StyleProp<ViewStyle> }) {
  const i = useSafeAreaInsets()
  const keyboard = useKeyboardHeight()
  return (
    <View style={[s.screen, { paddingTop: i.top, paddingLeft: i.left, paddingRight: i.right, paddingBottom: keyboard }, style]}>
      <View style={s.fill}>{children}</View>
      <View style={{ backgroundColor: footer ? colors.rail : colors.bg, paddingBottom: keyboard > 0 ? 0 : i.bottom }}>{footer}</View>
    </View>
  )
}

/** A scrolling screen body, with pull-to-refresh when given a handler. */
export function Body({ children, refreshing, onRefresh, gap = 12 }: { children: ReactNode; refreshing?: boolean; onRefresh?: () => void; gap?: number }) {
  return (
    <ScrollView
      contentContainerStyle={{ padding: 16, gap, flexGrow: 1 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.muted} colors={[colors.accent]} progressBackgroundColor={colors.raised} /> : undefined}
    >
      {children}
    </ScrollView>
  )
}

export function Title({ children }: { children: ReactNode }) {
  return <Text style={s.title}>{children}</Text>
}

/** A small caps label over a group of things. */
export function Section({ children }: { children: ReactNode }) {
  return <Text style={s.section}>{children}</Text>
}

export function Note({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[s.note, style]}>{children}</Text>
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <Text accessibilityRole="alert" style={s.error}>
      {children}
    </Text>
  )
}

export function Link({ children, onPress, danger, disabled }: { children: ReactNode; onPress: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled} hitSlop={8} style={disabled ? s.disabled : undefined}>
      <Text style={[s.link, danger && { color: colors.danger }]}>{children}</Text>
    </Pressable>
  )
}

export function Button({ children, onPress, kind = 'primary', disabled }: { children: ReactNode; onPress: () => void; kind?: 'primary' | 'quiet' | 'danger'; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled} style={[s.button, kind === 'quiet' && s.quiet, kind === 'danger' && s.dangerButton, disabled && s.disabled]}>
      <Text style={[s.buttonText, kind === 'quiet' && { color: colors.text }, kind === 'danger' && { color: colors.danger }]}>{children}</Text>
    </Pressable>
  )
}

export function Card({ children, onPress }: { children: ReactNode; onPress?: () => void }) {
  const inner = <View style={s.card}>{children}</View>
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {inner}
    </Pressable>
  ) : (
    inner
  )
}

/** The row of top-level places at the bottom of the main screens, kept above the system buttons by `Screen`. */
export function TabBar({ tabs, current, onSelect }: { tabs: { id: string; label: string; badge?: number }[]; current: string; onSelect: (id: string) => void }) {
  return (
    <View style={s.tabs}>
      {tabs.map((x) => (
        <Pressable key={x.id} accessibilityRole="tab" accessibilityState={{ selected: current === x.id }} onPress={() => onSelect(x.id)} style={[s.tab, current === x.id && s.tabOn]}>
          <Text style={[s.tabText, current === x.id && s.tabTextOn]}>
            {x.label}
            {x.badge ? ` ${x.badge}` : ''}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  fill: { flex: 1 },
  title: { color: colors.text, fontSize: 22, fontWeight: '600', letterSpacing: -0.2 },
  section: { color: colors.muted, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1, marginTop: 14, paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  note: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  error: { color: colors.danger, fontSize: 14 },
  link: { color: colors.link, paddingVertical: 6, fontSize: 15, fontWeight: '500' },
  button: { backgroundColor: colors.accent, borderRadius: radius, paddingVertical: 13, paddingHorizontal: 14, alignItems: 'center' },
  quiet: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.lineStrong },
  dangerButton: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.danger },
  disabled: { opacity: 0.45 },
  buttonText: { color: colors.onAccent, fontSize: 15, fontWeight: '600' },
  card: { backgroundColor: colors.raised, borderRadius: radius, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, padding: 14, gap: 3 },
  tabs: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 14, borderTopWidth: 2, borderTopColor: 'transparent', marginTop: -StyleSheet.hairlineWidth },
  tabOn: { borderTopColor: colors.accent },
  tabText: { color: colors.muted, fontSize: 13, fontWeight: '500' },
  tabTextOn: { color: colors.text, fontWeight: '600' },
  numbers
})
