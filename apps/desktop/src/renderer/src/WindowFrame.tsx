import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Minus, Settings, ShieldCheck, Square, X } from 'lucide-react'
import appIcon from './assets/mail-64.png'
import { useStreamSafe } from './streamsafe'

/** The window is frameless and transparent so its corners can be rounded; this draws what the OS no longer does. */

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const MAIN_MIN = { minW: 1000, minH: 600 }

const GRIPS: { edge: Edge; className: string; cursor: string }[] = [
  { edge: 'n', className: 'top-0 right-3 left-3 h-1', cursor: 'ns-resize' },
  { edge: 's', className: 'right-3 bottom-0 left-3 h-1', cursor: 'ns-resize' },
  { edge: 'e', className: 'top-3 right-0 bottom-3 w-1', cursor: 'ew-resize' },
  { edge: 'w', className: 'top-3 bottom-3 left-0 w-1', cursor: 'ew-resize' },
  { edge: 'ne', className: 'top-0 right-0 size-3', cursor: 'nesw-resize' },
  { edge: 'nw', className: 'top-0 left-0 size-3', cursor: 'nwse-resize' },
  { edge: 'se', className: 'right-0 bottom-0 size-3', cursor: 'nwse-resize' },
  { edge: 'sw', className: 'bottom-0 left-0 size-3', cursor: 'nesw-resize' }
]

/** Resizes by dragging an edge or corner. Transparent windows cannot be resized by the OS, so it is done here. */
function Grip({ edge, className, cursor, minW, minH }: { edge: Edge; className: string; cursor: string; minW: number; minH: number }) {
  const start = useRef<{ x: number; y: number; b: { x: number; y: number; width: number; height: number } } | null>(null)
  const frame = useRef(0)

  const onDown = async (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    const b = await window.imc.invoke('window:bounds')
    start.current = { x: e.screenX, y: e.screenY, b }
  }
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = start.current
    if (!s) return
    cancelAnimationFrame(frame.current)
    const { screenX, screenY } = e
    frame.current = requestAnimationFrame(() => {
      const dx = screenX - s.x
      const dy = screenY - s.y
      let { x, y, width, height } = s.b
      if (edge.includes('e')) width = Math.max(minW, s.b.width + dx)
      if (edge.includes('s')) height = Math.max(minH, s.b.height + dy)
      if (edge.includes('w')) {
        width = Math.max(minW, s.b.width - dx)
        x = s.b.x + (s.b.width - width)
      }
      if (edge.includes('n')) {
        height = Math.max(minH, s.b.height - dy)
        y = s.b.y + (s.b.height - height)
      }
      void window.imc.invoke('window:setBounds', { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) })
    })
  }
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    start.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
  }
  return <div aria-hidden className={`absolute z-50 ${className}`} style={{ cursor, touchAction: 'none' }} onPointerDown={(e) => void onDown(e)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
}

/** Invisible edges and corners to drag, for a window that has no frame of its own. */
export function ResizeGrips({ minW, minH }: { minW: number; minH: number }) {
  return GRIPS.map((g) => <Grip key={g.edge} {...g} minW={minW} minH={minH} />)
}

const ctl =
  'grid h-8 w-11 place-items-center text-ink-2 transition-colors duration-(--dur-fast) hover:bg-hover hover:text-ink focus-visible:-outline-offset-2'

function TitleBar({ maximized }: { maximized: boolean }) {
  const streamActive = useStreamSafe().active
  const control = (action: 'minimize' | 'maximize' | 'restore' | 'close') => void window.imc.invoke('window:control', { action })
  return (
    <div className="flex h-8 shrink-0 items-center border-b border-line bg-rail" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      <span className="flex items-center gap-2 px-3 text-sm font-medium text-ink-2 select-none">
        <img src={appIcon} alt="" width={16} height={16} className="size-4 rounded-[3px]" draggable={false} />
        IMC-Mail
      </span>
      <span className="flex-1" />
      <div className="flex" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          className={`${ctl} ${streamActive ? 'w-auto gap-1.5 px-3 text-ink' : ''}`}
          aria-label={streamActive ? 'Settings (stream-safe mode is on)' : 'Settings'}
          title={streamActive ? 'Settings: stream-safe mode is on' : 'Settings'}
          onClick={() => window.dispatchEvent(new CustomEvent('imc:open-settings'))}
        >
          <Settings size={15} strokeWidth={1.75} aria-hidden />
          {streamActive && (
            <>
              <ShieldCheck size={14} strokeWidth={1.75} aria-hidden />
              <span className="text-xs">Stream-safe on</span>
            </>
          )}
        </button>
        <button className={ctl} aria-label="Minimize" title="Minimize" onClick={() => control('minimize')}>
          <Minus size={14} strokeWidth={1.75} aria-hidden />
        </button>
        <button
          className={ctl}
          aria-label={maximized ? 'Restore' : 'Maximize'}
          title={maximized ? 'Restore' : 'Maximize'}
          onClick={() => control(maximized ? 'restore' : 'maximize')}
        >
          {maximized ? <Copy size={12} strokeWidth={1.75} aria-hidden /> : <Square size={12} strokeWidth={1.75} aria-hidden />}
        </button>
        <button className={`${ctl} hover:text-alert`} aria-label="Close" title="Close" onClick={() => control('close')}>
          <X size={15} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    </div>
  )
}

/** Rounded window with its own title bar and resize edges, and no outline. Square while maximized. */
export default function WindowFrame({ children }: { children: React.ReactNode }) {
  const [maximized, setMaximized] = useState(false)
  const apply = useCallback((m: boolean) => {
    setMaximized(m)
    if (m) document.documentElement.setAttribute('data-maximized', '')
    else document.documentElement.removeAttribute('data-maximized')
  }, [])
  useEffect(() => {
    void window.imc.invoke('window:bounds').then((b) => apply(b.maximized))
    return window.imc.on('window:state', ({ maximized: m }) => apply(m))
  }, [apply])

  return (
    <div className={`relative h-full overflow-hidden bg-sheet ${maximized ? '' : 'rounded-(--win-radius)'}`}>
      <div className="flex h-full flex-col">
        <TitleBar maximized={maximized} />
        <div className="relative min-h-0 flex-1">{children}</div>
      </div>
      {!maximized && <ResizeGrips {...MAIN_MIN} />}
    </div>
  )
}
