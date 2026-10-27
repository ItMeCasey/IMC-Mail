import type { ReactNode } from 'react'
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

// Shared building blocks. Every screen sits inside the space the system leaves free: below the status bar, above the
// Back / Home / Recents buttons (or the gesture bar), and clear of any notch, whatever the Android version.

export const colors = {
  bg: '#101418',
  raised: '#1d2733',
  line: '#2a3340',
  text: '#f2f4f7',
  soft: '#c7d0dc',
  muted: '#9aa4b2',
  faint: '#7d8794',
  accent: '#2b6cb0',
  link: '#8ab4f8',
  danger: '#f2a3a3',
  warn: '#e4cfa0'
}

/** A whole screen: padded for the system bars, with an optional fixed bottom bar kept above the navigation buttons. */
export function Screen({ children, footer, style }: { children: ReactNode; footer?: ReactNode; style?: StyleProp<ViewStyle> }) {
  const i = useSafeAreaInsets()
  return (
    <View style={[s.screen, { paddingTop: i.top, paddingLeft: i.left, paddingRight: i.right }, style]}>
      <View style={s.fill}>{children}</View>
      {footer ? <View style={{ paddingBottom: i.bottom }}>{footer}</View> : <View style={{ height: i.bottom }} />}
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
      <Text style={s.buttonText}>{children}</Text>
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
      {tabs.map((t) => (
        <Pressable key={t.id} accessibilityRole="tab" accessibilityState={{ selected: current === t.id }} onPress={() => onSelect(t.id)} style={s.tab}>
          <Text style={[s.tabText, current === t.id && s.tabOn]}>
            {t.label}
            {t.badge ? ` (${t.badge})` : ''}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  fill: { flex: 1 },
  title: { color: colors.text, fontSize: 22, fontWeight: '600' },
  note: { color: colors.muted, fontSize: 14 },
  error: { color: colors.danger },
  link: { color: colors.link, paddingVertical: 6, fontSize: 15 },
  button: { backgroundColor: colors.accent, borderRadius: 8, padding: 14 },
  quiet: { backgroundColor: colors.raised },
  dangerButton: { backgroundColor: '#7a2a2a' },
  disabled: { opacity: 0.5 },
  buttonText: { color: colors.text, fontSize: 16 },
  card: { backgroundColor: colors.raised, borderRadius: 8, padding: 14, gap: 2 },
  tabs: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, backgroundColor: colors.bg },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 14 },
  tabText: { color: colors.muted, fontSize: 14 },
  tabOn: { color: colors.text, fontWeight: '600' }
})
