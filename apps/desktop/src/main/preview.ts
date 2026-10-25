import { canPreviewAttachment, type AttachmentPreview } from '@imc/core'

const IMAGE_LIMIT = 8 * 1024 * 1024
const TEXT_LIMIT = 200 * 1024

/** The image type a file really is, from its first bytes. A wrong label or an SVG gets no preview. */
export function sniffImage(b: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}


/** An image as a data URL or a text file as text; anything else (or anything odd) is "none". */
export function previewOf(filename: string, mime: string, content: Buffer): AttachmentPreview {
  const image = sniffImage(content)
  if (image && content.length <= IMAGE_LIMIT) {
    return { kind: 'image', dataUrl: `data:${image};base64,${content.toString('base64')}` }
  }
  if (!image && canPreviewAttachment(mime, filename) && !content.subarray(0, 4096).includes(0)) {
    const truncated = content.length > TEXT_LIMIT
    return { kind: 'text', text: content.subarray(0, TEXT_LIMIT).toString('utf8'), truncated }
  }
  return { kind: 'none' }
}
