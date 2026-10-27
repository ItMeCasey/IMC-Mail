import { useState, type ReactNode } from 'react'
import { Image, Modal, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors, radius } from './ui'

// The parts that make the phone app feel like an app: a top bar, round sender avatars, a floating Write button, bottom
// sheets and settings rows. Icons are drawn from plain views, so they need no icon font and follow the theme.

// ---- icons ---------------------------------------------------------------------------------------------------------

const bar = (w: number, h: number, extra?: ViewStyle): ViewStyle => ({ width: w, height: h, backgroundColor: colors.text, borderRadius: 1, ...extra })

export function MenuIcon({ color = colors.text }: { color?: string }) {
  return (
    <View style={{ width: 20, gap: 4 }}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={bar(20, 2, { backgroundColor: color })} />
      ))}
    </View>
  )
}

export function BackIcon({ color = colors.text }: { color?: string }) {
  return <View style={{ width: 11, height: 11, borderLeftWidth: 2, borderBottomWidth: 2, borderColor: color, transform: [{ rotate: '45deg' }], marginLeft: 4 }} />
}

export function SearchIcon({ color = colors.text }: { color?: string }) {
  return (
    <View style={{ width: 20, height: 20 }}>
      <View style={{ width: 13, height: 13, borderRadius: 7, borderWidth: 2, borderColor: color }} />
      <View style={bar(8, 2, { position: 'absolute', right: 0, bottom: 2, backgroundColor: color, transform: [{ rotate: '45deg' }] })} />
    </View>
  )
}

export function PlusIcon({ color = colors.onAccent, size = 14 }: { color?: string; size?: number }) {
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={bar(size, 2, { position: 'absolute', backgroundColor: color })} />
      <View style={bar(2, size, { position: 'absolute', backgroundColor: color })} />
    </View>
  )
}

export function CloseIcon({ color = colors.text }: { color?: string }) {
  return (
    <View style={{ width: 16, height: 16, alignItems: 'center', justifyContent: 'center' }}>
      <View style={bar(18, 2, { position: 'absolute', backgroundColor: color, transform: [{ rotate: '45deg' }] })} />
      <View style={bar(18, 2, { position: 'absolute', backgroundColor: color, transform: [{ rotate: '-45deg' }] })} />
    </View>
  )
}

// ---- top bar ---------------------------------------------------------------------------------------------------------

/** A square tap target for an icon, big enough for a thumb. */
export function IconButton({ children, onPress, label }: { children: ReactNode; onPress: () => void; label: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={4} style={st.iconButton}>
      {children}
    </Pressable>
  )
}

/** The bar at the top of a screen: something on the left, a title (and a line under it), things on the right. */
export function AppBar({ left, title, subtitle, right }: { left?: ReactNode; title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <View style={st.appBar}>
      <View style={st.appBarSide}>{left}</View>
      <View style={st.appBarTitle}>
        <Text numberOfLines={1} style={st.title}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} style={st.subtitle}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <View style={[st.appBarSide, { justifyContent: 'flex-end' }]}>{right}</View>
    </View>
  )
}

// ---- avatar ----------------------------------------------------------------------------------------------------------

const initialsOf = (name: string): string => {
  const words = name
    .replace(/<.*>/, '')
    .split(/[\s@._-]+/)
    .filter(Boolean)
  const letters = (words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? '?').slice(0, 2)).toUpperCase()
  return letters || '?'
}

/** The address of a company's icon, from a favicon service. It answers "not found" when it has none, and the initials stay. */
const logoUrl = (domain: string, size: number): string => `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${encodeURIComponent(domain)}&size=${Math.min(128, Math.round(size * 2))}`

/**
 * A round mark for a sender: the company's logo when a domain is given and the service has one, otherwise their
 * initials in a color picked from the name (or the given one).
 */
export function Avatar({ name, size = 40, color, domain }: { name: string; size?: number; color?: string | null; domain?: string | null }) {
  const [missing, setMissing] = useState<string | null>(null)
  if (domain && missing !== domain) {
    return (
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#ffffff', borderWidth: 1, borderColor: color ?? colors.line, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <Image accessibilityLabel={name} source={{ uri: logoUrl(domain, size) }} onError={() => setMissing(domain)} style={{ width: size * 0.62, height: size * 0.62 }} resizeMode="contain" />
      </View>
    )
  }
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const tone = color ?? colors.tape[h % colors.tape.length]!
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: tone + '33', borderWidth: 1, borderColor: tone, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: tone, fontSize: size * 0.36, fontWeight: '600' }}>{initialsOf(name)}</Text>
    </View>
  )
}

// ---- floating button ---------------------------------------------------------------------------------------------------

/** A pill that floats over the bottom right of a screen. */
export function Fab({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={st.fab}>
      <PlusIcon />
      <Text style={st.fabText}>{label}</Text>
    </Pressable>
  )
}

// ---- sheets ----------------------------------------------------------------------------------------------------------

/** A panel that slides up from the bottom (or in from the left, for a menu), over a dimmed screen. Tap outside to close. */
export function Sheet({ open, onClose, children, side = 'bottom' }: { open: boolean; onClose: () => void; children: ReactNode; side?: 'bottom' | 'left' }) {
  const i = useSafeAreaInsets()
  const panel: StyleProp<ViewStyle> = side === 'left' ? [st.drawer, { paddingTop: i.top + 8, paddingBottom: i.bottom + 8 }] : [st.sheet, { paddingBottom: i.bottom + 8 }]
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <View style={[st.scrim, side === 'bottom' && { justifyContent: 'flex-end' }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
        <View style={panel}>{children}</View>
      </View>
    </Modal>
  )
}

/** One choice in a sheet or menu. */
export function MenuItem({ label, onPress, danger, selected, indent = 0, hint }: { label: string; onPress: () => void; danger?: boolean; selected?: boolean; indent?: number; hint?: string }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[st.menuItem, selected && { backgroundColor: colors.selected }, { paddingLeft: 20 + indent * 16 }]}>
      <Text numberOfLines={1} style={[st.menuText, danger && { color: colors.danger }, selected && { fontWeight: '600' }]}>
        {label}
      </Text>
      {hint ? <Text style={st.menuHint}>{hint}</Text> : null}
    </Pressable>
  )
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <Text style={st.menuLabel}>{children}</Text>
}

// ---- settings rows -----------------------------------------------------------------------------------------------------

/** A group of settings rows under a small heading, divided by hairlines. */
export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ marginTop: 20 }}>
      <Text style={st.groupTitle}>{title}</Text>
      <View style={st.group}>{children}</View>
    </View>
  )
}

/** One settings row: a label (and a line under it) on the left, a control or value on the right. Tap anywhere if it has `onPress`. */
export function SettingRow({ label, hint, right, onPress, danger }: { label: string; hint?: string; right?: ReactNode; onPress?: () => void; danger?: boolean }) {
  const body = (
    <View style={st.settingRow}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[st.settingLabel, danger && { color: colors.danger }]}>{label}</Text>
        {hint ? <Text style={st.settingHint}>{hint}</Text> : null}
      </View>
      {right}
    </View>
  )
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {body}
    </Pressable>
  ) : (
    body
  )
}

const st = StyleSheet.create({
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  appBar: { flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, backgroundColor: colors.bg },
  appBarSide: { minWidth: 44, flexDirection: 'row', alignItems: 'center' },
  appBarTitle: { flex: 1, paddingHorizontal: 8 },
  title: { color: colors.text, fontSize: 18, fontWeight: '600', letterSpacing: -0.2 },
  subtitle: { color: colors.muted, fontSize: 12 },
  fab: { position: 'absolute', right: 16, bottom: 16, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.accent, borderRadius: radius, paddingHorizontal: 18, paddingVertical: 14, elevation: 0 },
  fabText: { color: colors.onAccent, fontSize: 15, fontWeight: '600' },
  scrim: { flex: 1, backgroundColor: '#000000aa' },
  sheet: { backgroundColor: colors.rail, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.lineStrong, paddingTop: 8, maxHeight: '80%' },
  drawer: { position: 'absolute', left: 0, top: 0, bottom: 0, width: '82%', maxWidth: 360, backgroundColor: colors.rail, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.line },
  menuItem: { minHeight: 48, paddingRight: 20, justifyContent: 'center' },
  menuText: { color: colors.text, fontSize: 16 },
  menuHint: { color: colors.muted, fontSize: 12 },
  menuLabel: { color: colors.muted, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 4 },
  groupTitle: { color: colors.muted, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1, paddingBottom: 6 },
  group: { backgroundColor: colors.raised, borderRadius: radius, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  settingRow: { marginTop: -StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  settingLabel: { color: colors.text, fontSize: 15 },
  settingHint: { color: colors.muted, fontSize: 12 }
})
