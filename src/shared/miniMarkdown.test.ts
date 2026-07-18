import { describe, expect, it } from 'vitest'
import { parseMiniMarkdown } from './miniMarkdown'

describe('parseMiniMarkdown', () => {
  it('parses headings, bullets and paragraphs per line', () => {
    const blocks = parseMiniMarkdown('# Title\n## Sub\n- item\n* item2\nplain')
    expect(blocks.map((b) => b.kind)).toEqual(['h1', 'h2', 'li', 'li', 'p'])
    expect(blocks[0].spans).toEqual([{ text: 'Title', bold: false }])
    expect(blocks[2].spans).toEqual([{ text: 'item', bold: false }])
  })

  it('splits **bold** spans inline', () => {
    const [b] = parseMiniMarkdown('a **b** c')
    expect(b.spans).toEqual([
      { text: 'a ', bold: false },
      { text: 'b', bold: true },
      { text: ' c', bold: false }
    ])
  })

  it('renders unterminated ** literally and keeps empty lines as empty paragraphs', () => {
    const blocks = parseMiniMarkdown('**open\n\nend')
    expect(blocks[0].spans).toEqual([{ text: '**open', bold: false }])
    expect(blocks[1]).toEqual({ kind: 'p', spans: [] })
  })
})
