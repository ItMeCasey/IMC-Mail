import { describe, expect, it } from 'vitest'
import { textToHtml } from './textToHtml'

describe('textToHtml', () => {
  it('keeps line breaks and escapes what would be read as markup', () => {
    expect(textToHtml('Hi <b>there</b> & you\nSecond line')).toBe('Hi &lt;b&gt;there&lt;/b&gt; &amp; you<br>Second line')
  })

  it('gives nothing for nothing', () => {
    expect(textToHtml('')).toBe('')
  })
})
