import { describe, it, expect } from 'vitest'
import {
  carveMessages,
  parseHeaderBlock,
  nameEmail,
  toDateIso,
  rowToEml,
  sanitizeName,
  type EmailRow
} from './emailParse'

describe('parseHeaderBlock', () => {
  it('lowercases keys and unfolds continuation lines', () => {
    const h = parseHeaderBlock('Subject: Hello\r\n world\r\nFrom: a@b.com')
    expect(h.subject).toBe('Hello world')
    expect(h.from).toBe('a@b.com')
  })
  it('keeps the first occurrence of a repeated header', () => {
    const h = parseHeaderBlock('Received: one\r\nReceived: two')
    expect(h.received).toBe('one')
  })
})

describe('nameEmail', () => {
  it('splits "Name <email>"', () => {
    expect(nameEmail('João Silva <joao@x.com>')).toEqual({ name: 'João Silva', email: 'joao@x.com' })
  })
  it('handles a bare address and a bare name', () => {
    expect(nameEmail('joao@x.com')).toEqual({ email: 'joao@x.com' })
    expect(nameEmail('Support Team')).toEqual({ name: 'Support Team' })
  })
})

describe('toDateIso', () => {
  it('parses an RFC-822 date', () => {
    expect(toDateIso('Wed, 08 Jul 2026 10:00:00 +0000')).toBe('2026-07-08T10:00:00.000Z')
  })
  it('returns undefined for junk', () => {
    expect(toDateIso('not a date')).toBeUndefined()
    expect(toDateIso(undefined)).toBeUndefined()
  })
})

describe('carveMessages', () => {
  it('carves an mbox with two messages', () => {
    const raw =
      'From alice@x.com Wed Jul 08 2026\r\n' +
      'From: Alice <alice@x.com>\r\n' +
      'To: bob@y.com\r\n' +
      'Subject: First\r\n' +
      'Date: Wed, 08 Jul 2026 10:00:00 +0000\r\n' +
      '\r\n' +
      'Body one.\r\n' +
      'From bob@y.com Wed Jul 08 2026\r\n' +
      'From: Bob <bob@y.com>\r\n' +
      'Subject: Second\r\n' +
      '\r\n' +
      'Body two.\r\n'
    const rows: EmailRow[] = []
    const n = carveMessages(raw, (r) => rows.push(r))
    expect(n).toBe(2)
    expect(rows[0].subject).toBe('First')
    expect(rows[0].from_email).toBe('alice@x.com')
    expect(rows[0].to_recipients).toBe('bob@y.com')
    expect(rows[0].body?.trim()).toBe('Body one.')
    expect(rows[0].date_sent).toBe('2026-07-08T10:00:00.000Z')
    expect(rows[1].subject).toBe('Second')
  })

  it('carves raw header blocks with no mbox separators', () => {
    const raw =
      'garbage bytes\x00\x01\r\n' +
      'Message-ID: <abc@x.com>\r\n' +
      'From: c@x.com\r\n' +
      'Subject: Recovered\r\n' +
      'Content-Type: text/html; charset=utf-8\r\n' +
      '\r\n' +
      '<p>hi</p>\r\n'
    const rows: EmailRow[] = []
    const n = carveMessages(raw, (r) => rows.push(r))
    expect(n).toBe(1)
    expect(rows[0].message_id).toBe('abc@x.com')
    expect(rows[0].subject).toBe('Recovered')
    expect(rows[0].body_html?.trim()).toBe('<p>hi</p>')
    expect(rows[0].body).toBeUndefined()
  })

  it('returns 0 and emits nothing when there is no header signal', () => {
    const rows: EmailRow[] = []
    expect(carveMessages('just some random text with no headers', (r) => rows.push(r))).toBe(0)
    expect(rows).toHaveLength(0)
  })
})

describe('sanitizeName', () => {
  it('strips path-unsafe characters and falls back when empty', () => {
    expect(sanitizeName('Re: Q3 / plan?*', 'x')).toBe('Re Q3 plan')
    expect(sanitizeName('', 'message-1')).toBe('message-1')
    expect(sanitizeName('///', 'fallback')).toBe('fallback')
  })
})

describe('rowToEml', () => {
  it('reuses stored internet headers verbatim + body', () => {
    const eml = rowToEml({
      headers: 'From: a@b.com\nSubject: Hi',
      body: 'Line1\nLine2'
    })
    expect(eml).toBe('From: a@b.com\r\nSubject: Hi\r\n\r\nLine1\r\nLine2')
  })

  it('synthesizes headers from columns when none are stored', () => {
    const eml = rowToEml({
      from_name: 'Alice',
      from_email: 'alice@x.com',
      to_recipients: 'bob@y.com',
      subject: 'Hello',
      date_sent: '2026-07-08T10:00:00.000Z',
      message_id: 'mid-1',
      body: 'Hi there'
    })
    expect(eml).toContain('From: Alice <alice@x.com>\r\n')
    expect(eml).toContain('To: bob@y.com\r\n')
    expect(eml).toContain('Subject: Hello\r\n')
    expect(eml).toContain('Message-ID: <mid-1>\r\n')
    expect(eml).toContain('Content-Type: text/plain; charset=utf-8\r\n')
    expect(eml).toMatch(/\r\n\r\nHi there$/)
  })

  it('marks HTML-only bodies as text/html', () => {
    const eml = rowToEml({ subject: 'x', body_html: '<b>hi</b>' })
    expect(eml).toContain('Content-Type: text/html; charset=utf-8\r\n')
  })

  it('strips CR/LF from header values (no header injection)', () => {
    const eml = rowToEml({ subject: 'evil\r\nBcc: victim@x.com', body: 'b' })
    expect(eml).toContain('Subject: evil Bcc: victim@x.com\r\n')
    expect(eml).not.toMatch(/\r\nBcc: victim/)
  })
})
