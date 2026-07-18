import { describe, expect, it } from 'vitest'
import { emptyWorkbook, migrateWorkbook, type Workbook } from './types'

/** Simulate a JSON-parsed legacy document (types can't express it directly). */
function legacyV1(): Workbook {
  const wb = emptyWorkbook() as Workbook & { otwbVersion?: number; opvxVersion?: number }
  delete wb.opvxVersion
  delete (wb as { sourceFilters?: unknown }).sourceFilters
  wb.otwbVersion = 1
  return wb as Workbook
}

describe('migrateWorkbook', () => {
  it('upgrades legacy .otwb v1: rewrites the version field and backfills sourceFilters', () => {
    const out = migrateWorkbook(legacyV1())
    expect(out.opvxVersion).toBe(2)
    expect(out.sourceFilters).toEqual({})
    expect(out).not.toHaveProperty('otwbVersion')
  })

  it('passes current v2 documents through, preserving sourceFilters', () => {
    const wb = emptyWorkbook()
    wb.sourceFilters = { ds1: [{ kind: 'in', field: 'region', values: ['US'] }] }
    const out = migrateWorkbook(wb)
    expect(out.opvxVersion).toBe(2)
    expect(out.sourceFilters).toEqual(wb.sourceFilters)
    expect(out.meta).toEqual(wb.meta)
  })

  it('rejects documents newer than the app', () => {
    const wb = emptyWorkbook() as Workbook & { opvxVersion: number }
    wb.opvxVersion = 3
    expect(() => migrateWorkbook(wb as Workbook)).toThrow(/newer than this app supports/)
  })

  it('coerces version-less documents to the current schema', () => {
    const wb = legacyV1() as Workbook & { otwbVersion?: number }
    delete wb.otwbVersion
    const out = migrateWorkbook(wb as Workbook)
    expect(out.opvxVersion).toBe(2)
    expect(out.sourceFilters).toEqual({})
  })

  it('rewrites v0.10.0 correlated-unnest email-user calc fields DuckDB rejects', () => {
    const wb = emptyWorkbook()
    const legacy =
      `CASE WHEN trim(split_part(trim("E-mail"), '@', 1)) ~ '^[a-zA-Z]' THEN ` +
      `(SELECT string_agg(upper(substr(w,1,1))||lower(substr(w,2)), ' ') FROM ` +
      `(SELECT unnest(string_split(regexp_replace(trim(split_part(trim("E-mail"), '@', 1)), '[._-]+', ' ', 'g'), ' ')) AS w) AS _w) ` +
      `ELSE '' END`
    wb.calculatedFields = {
      ds1: [
        { name: 'User', expr: legacy, role: 'dimension' },
        { name: 'Other', expr: 'upper("name")', role: 'dimension' }
      ]
    }
    const out = migrateWorkbook(wb)
    expect(out.calculatedFields.ds1[0].expr).not.toContain('unnest')
    expect(out.calculatedFields.ds1[0].expr).toContain('list_transform')
    expect(out.calculatedFields.ds1[0].expr).toContain('"E-mail"')
    expect(out.calculatedFields.ds1[1].expr).toBe('upper("name")')
  })
})
