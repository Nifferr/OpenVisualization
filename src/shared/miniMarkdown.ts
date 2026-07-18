// Tiny line-oriented markdown subset for dashboard text tiles: headings
// (#, ##), bullets (-, *) and **bold** spans. Parsed into a structure so the
// in-app React renderer and the HTML/PDF exporters produce identical output
// without either depending on the other. Pure TypeScript (shared module).

export interface MdSpan {
  text: string
  bold: boolean
}

export interface MdBlock {
  kind: 'h1' | 'h2' | 'li' | 'p'
  spans: MdSpan[]
}

function parseSpans(text: string): MdSpan[] {
  const spans: MdSpan[] = []
  // split on **bold** runs; unterminated ** renders literally
  const re = /\*\*([^*]+)\*\*/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) spans.push({ text: text.slice(last, m.index), bold: false })
    spans.push({ text: m[1], bold: true })
    last = m.index + m[0].length
  }
  if (last < text.length) spans.push({ text: text.slice(last), bold: false })
  return spans
}

export function parseMiniMarkdown(text: string): MdBlock[] {
  return text.split(/\r?\n/).map((line) => {
    if (line.startsWith('## ')) return { kind: 'h2' as const, spans: parseSpans(line.slice(3)) }
    if (line.startsWith('# ')) return { kind: 'h1' as const, spans: parseSpans(line.slice(2)) }
    if (line.startsWith('- ') || line.startsWith('* '))
      return { kind: 'li' as const, spans: parseSpans(line.slice(2)) }
    return { kind: 'p' as const, spans: parseSpans(line) }
  })
}
