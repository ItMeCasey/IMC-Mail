/** Plain text as the HTML the composer holds: special characters escaped and each line break kept. */
export function textToHtml(text: string): string {
  if (text === '') return ''
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').split('\n').join('<br>')
}
