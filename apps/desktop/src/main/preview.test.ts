import { describe, expect, it } from 'vitest'
import { canPreviewAttachment as canPreview } from '@imc/core'
import { previewOf, sniffImage } from './preview'

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(10)])

describe('attachment preview', () => {
  it('recognizes images by their bytes, not their label', () => {
    expect(sniffImage(png)).toBe('image/png')
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImage(Buffer.from('GIF89a....'))).toBe('image/gif')
    expect(sniffImage(Buffer.from('RIFF....WEBPVP8 '))).toBe('image/webp')
    expect(sniffImage(Buffer.from('<svg onload=alert(1)>'))).toBeNull()
  })
  it('previews an image as a data URL whatever it was called', () => {
    const p = previewOf('invoice.pdf', 'application/pdf', png)
    expect(p.kind).toBe('image')
    expect(p.kind === 'image' && p.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })
  it('shows plain text files, cuts long ones, and refuses binary data and HTML', () => {
    expect(previewOf('notes.txt', 'text/plain', Buffer.from('hello'))).toEqual({ kind: 'text', text: 'hello', truncated: false })
    const long = previewOf('big.csv', 'text/csv', Buffer.alloc(300 * 1024, 'a'))
    expect(long.kind === 'text' && long.truncated && long.text.length === 200 * 1024).toBe(true)
    expect(previewOf('x.txt', 'text/plain', Buffer.from([1, 2, 0, 3]))).toEqual({ kind: 'none' })
    expect(previewOf('page.html', 'text/html', Buffer.from('<script>x</script>'))).toEqual({ kind: 'none' })
    expect(previewOf('logo.svg', 'image/svg+xml', Buffer.from('<svg/>'))).toEqual({ kind: 'none' })
  })
  it('decides what to offer a Preview button for', () => {
    expect(canPreview('image/png', 'a.png')).toBe(true)
    expect(canPreview('image/svg+xml', 'a.svg')).toBe(false)
    expect(canPreview('application/octet-stream', 'script.srt')).toBe(true)
    expect(canPreview('application/pdf', 'a.pdf')).toBe(false)
  })
})
