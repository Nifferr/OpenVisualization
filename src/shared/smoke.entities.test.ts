// THROWAWAY smoke test (deleted after run, per project convention):
// drives the real entityTokenSql SQL against a real in-memory DuckDB with the
// actual EXTRACT_PATTERNS regexes for e-mail/CPF/telefone/URL.
import { describe, expect, it } from 'vitest'
import { DuckDBInstance } from '@duckdb/node-api'
import { entityTokenSql } from './sqlBuilder'

const PATTERNS = {
  email: '(?i)\\b[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}\\b',
  cpf: '\\b\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}\\b|\\b\\d{11}\\b',
  url: '(?i)https?://[^\\s"\'<>]+'
}

describe('entityTokenSql against real DuckDB', () => {
  it('extracts, types and normalizes entities across fields', async () => {
    const instance = await DuckDBInstance.create(':memory:')
    const conn = await instance.connect()
    await conn.run(`CREATE TABLE t AS SELECT * FROM (VALUES
      ('contato: Foo@Example.COM e foo@example.com', 'CPF 123.456.789-09 visita https://x.gov.br/a'),
      ('sem nada', 'cpf 12345678909 de novo'),
      (NULL, 'dois emails: a@b.com c@d.org')
    ) AS v(notes, extra)`)
    await conn.run(`CREATE VIEW ds_s AS SELECT * FROM t`)

    const sql = entityTokenSql('"ds_s"', {
      fields: ['notes', 'extra'],
      patterns: [
        { id: 'email', label: 'E-mail', pattern: PATTERNS.email },
        { id: 'cpf', label: 'CPF', pattern: PATTERNS.cpf },
        { id: 'url', label: 'URL', pattern: PATTERNS.url }
      ],
      normalize: true
    })
    const reader = await conn.runAndReadAll(
      `SELECT entity, entity_type, source_field, count(*) AS n FROM (${sql}) GROUP BY 1,2,3 ORDER BY 2,1,3`
    )
    const rows = reader.getRowObjects().map((r) => ({
      entity: String(r.entity),
      type: String(r.entity_type),
      field: String(r.source_field),
      n: Number(r.n)
    }))

    // CPF: formatted and digits-only merged into 11-digit canonical form
    const cpf = rows.filter((r) => r.type === 'CPF' && r.entity === '12345678909')
    expect(cpf.reduce((a, r) => a + r.n, 0)).toBe(2)
    // e-mail: case variants merged by lower()
    const foo = rows.filter((r) => r.type === 'E-mail' && r.entity === 'foo@example.com')
    expect(foo.reduce((a, r) => a + r.n, 0)).toBe(2)
    // multiple matches in one cell each become a row
    expect(rows.some((r) => r.entity === 'a@b.com')).toBe(true)
    expect(rows.some((r) => r.entity === 'c@d.org')).toBe(true)
    // URL kept verbatim (normalizer 'none')
    expect(rows.some((r) => r.type === 'URL' && r.entity === 'https://x.gov.br/a')).toBe(true)
    // source_field attribution
    expect(rows.find((r) => r.entity === 'foo@example.com')?.field).toBe('notes')

    // normalize=false keeps raw variants distinct
    const rawSql = entityTokenSql('"ds_s"', {
      fields: ['notes'],
      patterns: [{ id: 'email', label: 'E-mail', pattern: PATTERNS.email }],
      normalize: false
    })
    const raw = (await conn.runAndReadAll(`SELECT DISTINCT entity FROM (${rawSql}) ORDER BY 1`))
      .getRowObjects()
      .map((r) => String(r.entity))
    expect(raw).toContain('Foo@Example.COM')
    expect(raw).toContain('foo@example.com')
  })

  it('enriches e-mail entities with user/org/category/type/location columns', async () => {
    const instance = await DuckDBInstance.create(':memory:')
    const conn = await instance.connect()
    await conn.run(`CREATE TABLE t AS SELECT * FROM (VALUES
      ('fale com nicolas.flores@itau-personalite.com.br'),
      ('pessoal: maria_souza@gmail.com'),
      ('CPF 123.456.789-09 sem e-mail')
    ) AS v(notes)`)
    await conn.run(`CREATE VIEW ds_e AS SELECT * FROM t`)

    const sql = entityTokenSql('"ds_e"', {
      fields: ['notes'],
      patterns: [
        { id: 'email', label: 'E-mail', pattern: PATTERNS.email },
        { id: 'cpf', label: 'CPF', pattern: PATTERNS.cpf }
      ],
      normalize: true
    })
    const rows = (await conn.runAndReadAll(`SELECT * FROM (${sql}) ORDER BY entity`))
      .getRowObjects()
      .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)])))

    const itau = rows.find((r) => r.entity === 'nicolas.flores@itau-personalite.com.br')!
    expect(itau.email_user).toBe('Nicolas Flores')
    expect(itau.email_domain).toBe('itau-personalite.com.br')
    expect(itau.email_org).toBe('Itaú Personnalité')
    expect(itau.email_category).toBe('Corporativo')
    expect(itau.email_org_type).toBe('Banco')
    expect(itau.email_location).toBe('Brasil')

    const gmail = rows.find((r) => r.entity === 'maria_souza@gmail.com')!
    expect(gmail.email_user).toBe('Maria Souza')
    expect(gmail.email_category).toBe('Particular')
    expect(gmail.email_org).toBe('gmail') // unknown org falls back to the domain name
    expect(gmail.email_location).toBe('Global')

    // non-email rows keep blank enrichment
    const cpf = rows.find((r) => r.entity_type === 'CPF')!
    expect(cpf.email_user).toBe('')
    expect(cpf.email_domain).toBe('')
    expect(cpf.email_category).toBe('')
  })

  it('gives every entity row a unique entity_id and a source_id shared per origin row', async () => {
    const instance = await DuckDBInstance.create(':memory:')
    const conn = await instance.connect()
    await conn.run(`CREATE TABLE t AS SELECT * FROM (VALUES
      ('Nicolas Flores <nicolasflores@gmail.com>; thaisdias@gmail.com'),
      ('sem e-mail'),
      ('um só: solo@x.com')
    ) AS v("to")`)
    await conn.run(`CREATE VIEW ds_i AS SELECT * FROM t`)

    const sql = entityTokenSql('"ds_i"', {
      fields: ['to'],
      patterns: [{ id: 'email', label: 'E-mail', pattern: PATTERNS.email }],
      normalize: true,
      sourceTable: 'Emails'
    })
    const rows = (
      await conn.runAndReadAll(`SELECT entity_id, source_id, source_table, entity FROM (${sql}) ORDER BY entity_id`)
    )
      .getRowObjects()
      .map((r) => ({
        entityId: Number(r.entity_id),
        sourceId: Number(r.source_id),
        table: String(r.source_table),
        entity: String(r.entity)
      }))

    // one row per extracted e-mail, entity_id unique and sequential
    expect(rows.map((r) => r.entityId)).toEqual([1, 2, 3])
    expect(rows.every((r) => r.table === 'Emails')).toBe(true)
    // the two e-mails from the same cell share the origin row's source_id
    const nicolas = rows.find((r) => r.entity === 'nicolasflores@gmail.com')!
    const thais = rows.find((r) => r.entity === 'thaisdias@gmail.com')!
    const solo = rows.find((r) => r.entity === 'solo@x.com')!
    expect(nicolas.sourceId).toBe(thais.sourceId)
    expect(solo.sourceId).not.toBe(nicolas.sourceId)
  })

  it('carries idField as source_id and joins back to the origin row_id view', async () => {
    const instance = await DuckDBInstance.create(':memory:')
    const conn = await instance.connect()
    await conn.run(`CREATE TABLE t AS SELECT * FROM (VALUES
      ('a@x.com', 'assunto A'),
      ('b@y.com; c@z.com', 'assunto B')
    ) AS v("to", subject)`)
    // same wrap registerDataSource applies for withRowId sources
    await conn.run(`CREATE VIEW ds_j AS SELECT row_number() OVER () AS row_id, * FROM t`)

    const sql = entityTokenSql('"ds_j"', {
      fields: ['to'],
      patterns: [{ id: 'email', label: 'E-mail', pattern: PATTERNS.email }],
      normalize: true,
      idField: 'row_id',
      sourceTable: 'Emails'
    })
    await conn.run(`CREATE TABLE ds_ent AS ${sql}`)
    const joined = (
      await conn.runAndReadAll(
        `SELECT e.entity, o.subject FROM ds_ent e JOIN ds_j o ON e.source_id = o.row_id ORDER BY e.entity`
      )
    )
      .getRowObjects()
      .map((r) => ({ entity: String(r.entity), subject: String(r.subject) }))
    expect(joined).toEqual([
      { entity: 'a@x.com', subject: 'assunto A' },
      { entity: 'b@y.com', subject: 'assunto B' },
      { entity: 'c@z.com', subject: 'assunto B' }
    ])
  })

  it('fills email_org from the domain by dot logic when the org is unknown', async () => {
    const instance = await DuckDBInstance.create(':memory:')
    const conn = await instance.connect()
    await conn.run(`CREATE TABLE t AS SELECT * FROM (VALUES
      ('usuario@teste.com'),
      ('usuario@empresa.com.br'),
      ('usuario@mail.empresa.com.br'),
      ('usuario@smtp.empresa.corp.com.br')
    ) AS v(notes)`)
    await conn.run(`CREATE VIEW ds_o AS SELECT * FROM t`)

    const sql = entityTokenSql('"ds_o"', {
      fields: ['notes'],
      patterns: [{ id: 'email', label: 'E-mail', pattern: PATTERNS.email }],
      normalize: true
    })
    const orgs = (await conn.runAndReadAll(`SELECT entity, email_org FROM (${sql}) ORDER BY entity`))
      .getRowObjects()
      .map((r) => ({ entity: String(r.entity), org: String(r.email_org) }))
    expect(orgs).toEqual([
      { entity: 'usuario@empresa.com.br', org: 'empresa' },
      { entity: 'usuario@mail.empresa.com.br', org: 'empresa' },
      { entity: 'usuario@smtp.empresa.corp.com.br', org: 'empresa' },
      { entity: 'usuario@teste.com', org: 'teste' }
    ])
  })

  it('scans calculated fields via fieldExprs (no such column on the view)', async () => {
    const instance = await DuckDBInstance.create(':memory:')
    const conn = await instance.connect()
    await conn.run(`CREATE TABLE t AS SELECT * FROM (VALUES
      ('contato: ANA@EMPRESA.COM.BR ok')
    ) AS v(raw_notes)`)
    await conn.run(`CREATE VIEW ds_c AS SELECT * FROM t`)

    const sql = entityTokenSql('"ds_c"', {
      fields: ['EmailLimpo'],
      fieldExprs: { EmailLimpo: `lower("raw_notes")` },
      patterns: [{ id: 'email', label: 'E-mail', pattern: PATTERNS.email }],
      normalize: true
    })
    const rows = (await conn.runAndReadAll(`SELECT entity, source_field FROM (${sql})`))
      .getRowObjects()
      .map((r) => ({ entity: String(r.entity), field: String(r.source_field) }))
    expect(rows).toEqual([{ entity: 'ana@empresa.com.br', field: 'EmailLimpo' }])
  })
})
