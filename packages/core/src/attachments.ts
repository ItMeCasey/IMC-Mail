const TEXT_NAME = /\.(txt|csv|tsv|md|log|json|xml|ics|srt|vtt)$/i

/** Whether an attachment can be shown inside the app (images and plain text; never HTML or SVG). */
export const canPreviewAttachment = (mime: string, filename: string): boolean =>
  /^image\/(png|jpe?g|gif|webp)$/i.test(mime) || /^text\/(?!html)/i.test(mime) || TEXT_NAME.test(filename)
