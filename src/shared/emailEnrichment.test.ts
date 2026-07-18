import { describe, it, expect } from 'vitest'
import {
  PUBLIC_PROVIDERS,
  KNOWN_ORGANIZATIONS,
  TLD_COUNTRY,
  emailUserExpr,
  emailDomainExpr,
  emailCategoryExpr,
  emailOrgExpr,
  emailOrgFallbackExpr,
  emailOrgTypeExpr,
  emailLocationExpr,
  emailTLDOf,
  fixLegacyEmailUserExpr
} from './emailEnrichment'

describe('emailEnrichment knowledge bases', () => {
  it('PUBLIC_PROVIDERS includes major Brazilian and global providers', () => {
    expect(PUBLIC_PROVIDERS).toContain('gmail.com')
    expect(PUBLIC_PROVIDERS).toContain('outlook.com')
    expect(PUBLIC_PROVIDERS).toContain('hotmail.com')
    expect(PUBLIC_PROVIDERS).toContain('yahoo.com')
    expect(PUBLIC_PROVIDERS).toContain('uol.com.br')
    expect(PUBLIC_PROVIDERS).toContain('bol.com.br')
    expect(PUBLIC_PROVIDERS).toContain('terra.com.br')
    expect(PUBLIC_PROVIDERS).toContain('ig.com.br')
    expect(PUBLIC_PROVIDERS).toContain('proton.me')
    expect(PUBLIC_PROVIDERS).toContain('icloud.com')
    expect(PUBLIC_PROVIDERS.length).toBeGreaterThanOrEqual(40)
  })

  it('KNOWN_ORGANIZATIONS covers banks, universities, government, tech, auto, retail', () => {
    expect(KNOWN_ORGANIZATIONS['itau.com.br']).toEqual({ name: 'Itaú', type: 'Banco' })
    expect(KNOWN_ORGANIZATIONS['usp.br']).toEqual({ name: 'Universidade de São Paulo', type: 'Universidade' })
    expect(KNOWN_ORGANIZATIONS['planalto.gov.br']).toEqual({ name: 'Governo Federal', type: 'Governo' })
    expect(KNOWN_ORGANIZATIONS['tesla.com']).toEqual({ name: 'Tesla', type: 'Empresa automotiva' })
    expect(KNOWN_ORGANIZATIONS['nubank.com.br']).toEqual({ name: 'Nubank', type: 'Banco' })
    expect(KNOWN_ORGANIZATIONS['petrobras.com.br']).toEqual({ name: 'Petrobras', type: 'Indústria de energia' })
    expect(Object.keys(KNOWN_ORGANIZATIONS).length).toBeGreaterThanOrEqual(40)
  })

  it('TLD_COUNTRY maps country codes correctly', () => {
    expect(TLD_COUNTRY['br']).toBe('Brasil')
    expect(TLD_COUNTRY['uk']).toBe('Reino Unido')
    expect(TLD_COUNTRY['com']).toBe('Global')
    expect(TLD_COUNTRY['org']).toBe('Global')
    expect(TLD_COUNTRY['io']).toBe('Indeterminado')
    expect(TLD_COUNTRY['gov']).toBe('Global')
  })
})

describe('emailUserExpr', () => {
  it('uses list_transform + array_to_string to capitalize name parts from local part (no correlated unnest)', () => {
    const sql = emailUserExpr('e')
    expect(sql).not.toContain('unnest')
    expect(sql).not.toContain('string_agg')
    expect(sql).toContain('list_transform')
    expect(sql).toContain('array_to_string')
    expect(sql).toContain('upper(substr(w,1,1))||lower(substr(w,2))')
    expect(sql).toContain("regexp_replace(trim(split_part(trim(e), '@', 1)), '[._-]+', ' ', 'g')")
  })

  it('returns empty string when local part does not start with a letter', () => {
    const sql = emailUserExpr('e')
    // regexp_matches, NOT the ~ operator: DuckDB's ~ is regexp_full_match
    expect(sql).toContain("CASE WHEN regexp_matches(trim(split_part(trim(e), '@', 1)), '^[a-zA-Z]') THEN")
    expect(sql).toContain("ELSE ''")
  })
})

describe('emailDomainExpr', () => {
  it('extracts lowercased domain from the email column', () => {
    const sql = emailDomainExpr('e')
    expect(sql).toContain("lower(trim(split_part(trim(e), '@', 2)))")
  })
})

describe('emailCategoryExpr', () => {
  it('generates a CASE expression with all expected categories', () => {
    const sql = emailCategoryExpr('d')
    expect(sql).toContain("'Rede oculta'")
    expect(sql).toContain("'Governamental'")
    expect(sql).toContain("'Militar'")
    expect(sql).toContain("'Particular'")
    expect(sql).toContain("'Educacional'")
    expect(sql).toContain("'Organização sem fins lucrativos'")
    expect(sql).toContain("'Corporativo'")
    expect(sql).toContain("'Indeterminado'")
  })

  it('references the domain expression passed in', () => {
    const sql = emailCategoryExpr('my_domain')
    expect(sql).toContain('my_domain')
  })

  it('lists public providers as IN values', () => {
    const sql = emailCategoryExpr('d')
    expect(sql).toContain("'gmail.com'")
    expect(sql).toContain("'outlook.com'")
  })
})

describe('emailOrgExpr', () => {
  it('generates a CASE expression mapping domains to organization names', () => {
    const sql = emailOrgExpr('d')
    expect(sql).toContain("WHEN d = 'itau.com.br' THEN 'Itaú'")
    expect(sql).toContain("WHEN d = 'usp.br' THEN 'Universidade de São Paulo'")
  })

  it('unknown domains fall back to the domain-derived name instead of blank', () => {
    const sql = emailOrgExpr('d')
    expect(sql).not.toContain("ELSE ''")
    expect(sql).toContain(emailOrgFallbackExpr('d'))
  })
})

describe('emailOrgFallbackExpr', () => {
  it('takes the 2nd label for 4+ dot-separated segments, else the 1st', () => {
    const sql = emailOrgFallbackExpr('d')
    expect(sql).toContain("len(string_split(d, '.')) >= 4")
    expect(sql).toContain("split_part(d, '.', 2)")
    expect(sql).toContain("split_part(d, '.', 1)")
  })
})

describe('emailOrgTypeExpr', () => {
  it('generates a CASE expression mapping domains to organization types', () => {
    const sql = emailOrgTypeExpr('d')
    expect(sql).toContain("WHEN d = 'itau.com.br' THEN 'Banco'")
    expect(sql).toContain("WHEN d = 'usp.br' THEN 'Universidade'")
    expect(sql).toContain("ELSE 'Indeterminado'")
  })
})

describe('emailLocationExpr', () => {
  it('generates a CASE expression mapping TLD to country', () => {
    const sql = emailLocationExpr('t')
    expect(sql).toContain("WHEN t = 'br' THEN 'Brasil'")
    expect(sql).toContain("WHEN t = 'com' THEN 'Global'")
    expect(sql).toContain("ELSE 'Indeterminado'")
  })
})

describe('emailTLDOf', () => {
  it('takes the last dot-separated label of an already-computed domain reference', () => {
    expect(emailTLDOf('email_domain')).toBe(`reverse(split_part(reverse(email_domain), '.', 1))`)
  })
})

describe('fixLegacyEmailUserExpr', () => {
  // the exact expression shape the v0.10.0 "User name (from e-mail)" template
  // saved into workbooks — DuckDB rejects it: "UNNEST() for correlated
  // expressions is not supported yet"
  const legacy = (ref: string): string =>
    `CASE WHEN trim(split_part(trim(${ref}), '@', 1)) ~ '^[a-zA-Z]' THEN ` +
    `(SELECT string_agg(upper(substr(w,1,1))||lower(substr(w,2)), ' ') FROM ` +
    `(SELECT unnest(string_split(regexp_replace(trim(split_part(trim(${ref}), '@', 1)), '[._-]+', ' ', 'g'), ' ')) AS w) AS _w) ` +
    `ELSE '' END`

  it('rewrites the legacy correlated-unnest expression to the current scalar form', () => {
    const fixed = fixLegacyEmailUserExpr(legacy('"E-mail"'))
    expect(fixed).toBe(emailUserExpr('"E-mail"'))
    expect(fixed).not.toContain('unnest')
  })

  it('recovers the original e-mail reference, including calc field names', () => {
    const fixed = fixLegacyEmailUserExpr(legacy('"EmailExtracted"'))
    expect(fixed).toContain('"EmailExtracted"')
    expect(fixed).toContain('list_transform')
  })

  it('leaves every other expression untouched', () => {
    expect(fixLegacyEmailUserExpr('upper("name")')).toBe('upper("name")')
    expect(fixLegacyEmailUserExpr(emailUserExpr('"E-mail"'))).toBe(emailUserExpr('"E-mail"'))
  })

  it('also fixes the intermediate shape that used the ~ full-match guard with list_transform', () => {
    // list ops already, but the guard was `local ~ '^[a-zA-Z]'` — full match
    // in DuckDB, so email_user silently came out '' for every row
    const local = `trim(split_part(trim("E-mail"), '@', 1))`
    const parts = `string_split(regexp_replace(${local}, '[._-]+', ' ', 'g'), ' ')`
    const cap = `array_to_string(list_transform(${parts}, w -> CASE WHEN length(w) > 0 THEN upper(substr(w,1,1))||lower(substr(w,2)) ELSE NULL END), ' ')`
    const intermediate = `CASE WHEN ${local} ~ '^[a-zA-Z]' THEN ${cap} ELSE '' END`
    expect(fixLegacyEmailUserExpr(intermediate)).toBe(emailUserExpr('"E-mail"'))
  })
})
