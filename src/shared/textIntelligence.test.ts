import { describe, expect, it } from 'vitest'
import {
  keywordCountExpr,
  normTextExpr,
  languageExpr,
  toneExpr,
  sentimentExpr,
  sentimentScoreExpr,
  emotionExpr,
  intentExpr,
  knowledgeAreaExpr,
  techLevelExpr,
  techTermCountExpr,
  urgencyExpr,
  urgencyCountExpr,
  confidenceExpr,
  relationTypesExpr,
  RELATION_PATTERNS,
  SMART_ANALYSES,
  STOPWORDS_PT,
  STOPWORDS_EN,
  STOPWORDS_ES
} from './textIntelligence'
import { validateExpression } from './sqlBuilder'

const COL = '"notes"'

describe('normTextExpr', () => {
  it('strips accents and lowercases through VARCHAR cast', () => {
    expect(normTextExpr(COL)).toBe('strip_accents(lower(CAST("notes" AS VARCHAR)))')
  })
})

describe('keywordCountExpr', () => {
  it('counts single words via token list + IN', () => {
    const sql = keywordCountExpr(COL, ['erro', 'falha'])
    expect(sql).toContain("string_split_regex(strip_accents(lower(CAST(\"notes\" AS VARCHAR))), '[^a-z0-9]+')")
    expect(sql).toContain("_w IN ('erro', 'falha')")
    expect(sql).not.toContain('regexp_extract_all')
  })

  it('deaccents lexicon entries so they match strip_accents output', () => {
    const sql = keywordCountExpr(COL, ['não', 'ótimo'])
    expect(sql).toContain("'nao'")
    expect(sql).toContain("'otimo'")
    expect(sql).not.toContain('não')
  })

  it('counts multi-word phrases via \\b-anchored regex alternation', () => {
    const sql = keywordCountExpr(COL, ['por favor', 'pode ser'])
    expect(sql).toContain('regexp_extract_all')
    expect(sql).toContain('\\b(?:por favor|pode ser)\\b')
    expect(sql).not.toContain('list_filter')
  })

  it('mixes words and phrases as a sum', () => {
    const sql = keywordCountExpr(COL, ['erro', 'por favor'])
    expect(sql).toContain('list_filter')
    expect(sql).toContain('regexp_extract_all')
    expect(sql).toContain(' + ')
  })

  it('dedupes entries that collide after deaccent/lowercase', () => {
    const sql = keywordCountExpr(COL, ['Não', 'nao', 'NÃO'])
    expect(sql.match(/'nao'/g)).toHaveLength(1)
  })

  it('escapes single quotes in lexicon entries', () => {
    const sql = keywordCountExpr(COL, ["d'agua"])
    expect(sql).toContain("'d''agua'")
  })

  it('escapes regex metacharacters in phrases', () => {
    const sql = keywordCountExpr(COL, ['nota 10 (dez)'])
    expect(sql).toContain('nota 10 \\(dez\\)')
  })

  it('returns 0 for an empty lexicon', () => {
    expect(keywordCountExpr(COL, [])).toBe('0')
  })
})

describe('classifier expressions', () => {
  it('languageExpr binds pt/en/es once and prioritizes PT ≥ EN ≥ ES', () => {
    const sql = languageExpr(COL)
    expect(sql).toContain("'pt': (")
    expect(sql).toContain("'en': (")
    expect(sql).toContain("'es': (")
    expect(sql).toContain("'Português'")
    expect(sql).toContain("'Inglês'")
    expect(sql).toContain("'Espanhol'")
    expect(sql).toContain("'Indeterminado'")
    // the struct-bind idiom: single-element list_transform indexed [1]
    expect(sql).toContain('list_transform([{')
    expect(sql).toContain(')[1])')
  })

  it('toneExpr appends Técnico independently of Formal/Informal', () => {
    const sql = toneExpr(COL)
    expect(sql).toContain("'Formal'")
    expect(sql).toContain("'Informal'")
    expect(sql).toContain("'Técnico'")
    expect(sql).toContain("'Neutro'")
    expect(sql).toContain('_x.t >= 2')
  })

  it('sentimentExpr compares positive vs negative counts', () => {
    const sql = sentimentExpr(COL)
    expect(sql).toContain("'Positivo'")
    expect(sql).toContain("'Negativo'")
    expect(sql).toContain("'Neutro'")
  })

  it('sentimentScoreExpr is a plain subtraction (measure)', () => {
    const sql = sentimentScoreExpr(COL)
    expect(sql).toContain(') - (')
    expect(sql).not.toContain('CASE')
  })

  it('emotionExpr covers the four emotions plus Neutra', () => {
    const sql = emotionExpr(COL)
    for (const label of ['Raiva', 'Medo', 'Alegria', 'Tristeza', 'Neutra'])
      expect(sql).toContain(`'${label}'`)
  })

  it('intentExpr also counts question marks toward Dúvida', () => {
    const sql = intentExpr(COL)
    expect(sql).toContain("regexp_extract_all(CAST(\"notes\" AS VARCHAR), '\\?')")
    for (const label of ['Pedido', 'Reclamação', 'Dúvida', 'Elogio', 'Outro'])
      expect(sql).toContain(`'${label}'`)
  })

  it('knowledgeAreaExpr covers six areas plus Geral', () => {
    const sql = knowledgeAreaExpr(COL)
    for (const label of ['Tecnologia', 'Saúde', 'Jurídico', 'Financeiro', 'Educação', 'Comercial', 'Geral'])
      expect(sql).toContain(`'${label}'`)
  })

  it('techLevelExpr uses the 8 / 3 thresholds', () => {
    const sql = techLevelExpr(COL)
    expect(sql).toContain('_x.n >= 8')
    expect(sql).toContain('_x.n >= 3')
    for (const label of ['Avançado', 'Intermediário', 'Básico']) expect(sql).toContain(`'${label}'`)
  })

  it('urgencyCountExpr weighs strong signals ×2', () => {
    const sql = urgencyCountExpr(COL)
    expect(sql).toMatch(/^2 \* \(/)
    expect(sql).toContain("'urgente'")
    expect(sql).toContain("'hoje'")
  })

  it('urgencyExpr maps 0/1/2+ to Baixa/Média/Alta', () => {
    const sql = urgencyExpr(COL)
    expect(sql).toContain('_x.n >= 2')
    expect(sql).toContain('_x.n = 1')
    for (const label of ['Alta', 'Média', 'Baixa']) expect(sql).toContain(`'${label}'`)
  })

  it('confidenceExpr resolves ties (incl. 0×0) to Média', () => {
    const sql = confidenceExpr(COL)
    expect(sql).toContain('_x.l > _x.h')
    expect(sql).toContain('_x.h > _x.l')
    expect(sql).toContain("ELSE 'Média'")
  })

  it('relationTypesExpr uses regexp_matches (never ~) and NULLs when nothing matches', () => {
    const sql = relationTypesExpr(COL)
    expect(sql).toContain('regexp_matches(')
    expect(sql).not.toMatch(/ ~ /)
    expect(sql).toContain("nullif(concat_ws('; '")
    for (const r of RELATION_PATTERNS) expect(sql).toContain(`'${r.label}'`)
  })
})

describe('lexicon hygiene', () => {
  it('cross-language noise words are excluded from every stopword list', () => {
    // "a", "as", "no", "do", "me" are frequent words in more than one of the
    // three languages — including them in only one list would bias detection
    const all = [STOPWORDS_PT, STOPWORDS_EN, STOPWORDS_ES]
    for (const list of all)
      for (const w of ['a', 'as', 'no', 'do', 'me']) expect(list).not.toContain(w)
  })

  it('deliberately shared PT/ES words appear in both lists (they cancel out)', () => {
    for (const w of ['para', 'que', 'como', 'por', 'se', 'o'])
      for (const list of [STOPWORDS_PT, STOPWORDS_ES]) expect(list).toContain(w)
  })
})

describe('SMART_ANALYSES registry', () => {
  it('has 13 analyses with unique ids and valid roles', () => {
    expect(SMART_ANALYSES).toHaveLength(13)
    expect(new Set(SMART_ANALYSES.map((a) => a.id)).size).toBe(13)
    for (const a of SMART_ANALYSES) expect(['dimension', 'measure']).toContain(a.role)
  })

  it('every generated expression passes validateExpression', () => {
    for (const a of SMART_ANALYSES) {
      const sql = a.build(COL)
      expect(sql.length).toBeGreaterThan(0)
      expect(validateExpression(sql), `${a.id}: ${validateExpression(sql)}`).toBeNull()
    }
  })

  it('measures are the score/count analyses', () => {
    const measures = SMART_ANALYSES.filter((a) => a.role === 'measure').map((a) => a.id)
    expect(measures.sort()).toEqual(['sentimentScore', 'techTerms', 'urgencyScore'])
  })
})
