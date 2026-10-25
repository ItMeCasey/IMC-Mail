import { useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from './theme'

const cssVar = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/**
 * One message body. It loads from the imc-body:// origin, which serves sanitized HTML under a
 * CSP that allows no scripts but our own and no remote loads unless `allowImages` is set. The
 * frame is sandboxed without same-origin, so the mail can never reach the app.
 */
export default function EmailFrame({
  id,
  allowImages,
  allowLinks,
  title
}: {
  id: string
  allowImages: boolean
  /** Links in dangerous messages are inert until this is set. */
  allowLinks: boolean
  title: string
}) {
  const theme = useTheme()
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(120)

  // Plain-text messages follow the theme; HTML mail always renders on white like the sender intended.
  const src = useMemo(() => {
    void theme // recompute the colors when the theme changes
    const q = new URLSearchParams({
      images: allowImages ? '1' : '0',
      links: allowLinks ? '1' : '0',
      fg: cssVar('--ink'),
      bg: cssVar('--sheet')
    })
    return `imc-body://m/${encodeURIComponent(id)}?${q}`
  }, [id, allowImages, allowLinks, theme])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return
      const d = e.data as { imcHeight?: unknown; id?: unknown } | null
      if (d && typeof d.imcHeight === 'number' && d.id === id) {
        setHeight(Math.min(Math.max(Math.ceil(d.imcHeight), 40), 30000))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [id])

  return (
    <iframe
      ref={frame}
      title={title}
      src={src}
      sandbox="allow-scripts allow-popups"
      referrerPolicy="no-referrer"
      style={{ height }}
      className="block w-full border border-line"
    />
  )
}
