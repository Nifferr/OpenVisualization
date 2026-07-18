// Real-DuckDB smoke (committed, like smoke.entities.test.ts): drives the
// actual shipped textIntelligence SQL — including the struct+lambda binding
// idiom and list_filter/IN token counting — against an in-memory DuckDB.
import { describe, expect, it } from 'vitest'
import { DuckDBInstance } from '@duckdb/node-api'
import {
  languageExpr,
  toneExpr,
  sentimentExpr,
  sentimentScoreExpr,
  emotionExpr,
  intentExpr,
  knowledgeAreaExpr,
  techLevelExpr,
  urgencyExpr,
  confidenceExpr,
  relationTypesExpr
} from './textIntelligence'

const C = '"txt"'

describe('textIntelligence against real DuckDB', () => {
  it('classifies real sentences end-to-end', async () => {
    const instance = await DuckDBInstance.create(':memory:')
    const conn = await instance.connect()
    await conn.run(`CREATE TABLE t AS SELECT * FROM (VALUES
      (1, 'Prezados, solicito a correção do erro no boleto. Conforme informado, o problema persiste e não foi resolvido.'),
      (2, 'The system is working and we have all the required data from the server.'),
      (3, 'El sistema es muy bueno pero la aplicación tiene una falla que no funciona.'),
      (4, 'Excelente atendimento, porém houve um erro.'),
      (5, 'Acho que houve um problema.'),
      (6, 'URGENTE: preciso da resposta ainda hoje!'),
      (7, 'João trabalha na Petrobras. Maria mora em Campinas.'),
      (8, 'Fizemos o deploy da API REST com Docker e Kubernetes usando JWT.'),
      (9, 'Estou muito feliz com a conquista, que alegria!'),
      (10, 'O paciente passou por cirurgia no hospital e a consulta com o médico foi remarcada.'),
      (11, 'Oi mano, blz? Valeu pela força, kkkk'),
      (12, NULL)
    ) AS v(id, txt)`)

    const reader = await conn.runAndReadAll(
      `SELECT id,
        ${languageExpr(C)} AS lang,
        ${toneExpr(C)} AS tone,
        ${sentimentExpr(C)} AS sent,
        ${sentimentScoreExpr(C)} AS sent_score,
        ${emotionExpr(C)} AS emotion,
        ${intentExpr(C)} AS intent,
        ${knowledgeAreaExpr(C)} AS area,
        ${techLevelExpr(C)} AS tech,
        ${urgencyExpr(C)} AS urgency,
        ${confidenceExpr(C)} AS conf,
        ${relationTypesExpr(C)} AS rels
      FROM t ORDER BY id`
    )
    const rows = reader.getRowObjects()
    const row = (id: number): Record<string, unknown> => {
      const r = rows.find((x) => Number(x.id) === id)
      expect(r, `row ${id}`).toBeDefined()
      return r as Record<string, unknown>
    }

    // 1 — PT formal complaint
    expect(String(row(1).lang)).toBe('Português')
    expect(String(row(1).tone)).toBe('Formal')
    expect(String(row(1).sent)).toBe('Negativo')
    expect(String(row(1).intent)).toBe('Reclamação')

    // 2 — English
    expect(String(row(2).lang)).toBe('Inglês')

    // 3 — Spanish
    expect(String(row(3).lang)).toBe('Espanhol')

    // 4 — the user's own example: 1 positive + 1 negative → Neutro
    expect(String(row(4).sent)).toBe('Neutro')
    expect(Number(row(4).sent_score)).toBe(0)

    // 5 — the user's own example: hedging → confiança Baixa
    expect(String(row(5).conf)).toBe('Baixa')

    // 6 — strong signal (urgente ×2) + weak (hoje) → Alta
    expect(String(row(6).urgency)).toBe('Alta')

    // 7 — the user's own example: trabalha na + mora em
    expect(String(row(7).rels)).toBe('Emprego; Residência')

    // 8 — 6 tech terms → Intermediário; tone is Técnico with no formal/informal base
    expect(String(row(8).tech)).toBe('Intermediário')
    expect(String(row(8).tone)).toBe('Técnico')
    expect(String(row(8).area)).toBe('Tecnologia')

    // 9 — joy lexicon dominates
    expect(String(row(9).emotion)).toBe('Alegria')

    // 10 — health vocabulary dominates
    expect(String(row(10).area)).toBe('Saúde')

    // 11 — informal tone
    expect(String(row(11).tone)).toBe('Informal')

    // 12 — NULL text must land in the neutral bucket of every analysis,
    // never in a CASE's ELSE arm (the coalesce(…, 0) guard)
    expect(String(row(12).lang)).toBe('Indeterminado')
    expect(String(row(12).tone)).toBe('Neutro')
    expect(String(row(12).sent)).toBe('Neutro')
    expect(String(row(12).emotion)).toBe('Neutra')
    expect(String(row(12).intent)).toBe('Outro')
    expect(String(row(12).area)).toBe('Geral')
    expect(String(row(12).tech)).toBe('Básico')
    expect(String(row(12).urgency)).toBe('Baixa')
    expect(String(row(12).conf)).toBe('Média')
    expect(row(12).rels).toBeNull()

    // accent-insensitivity: shouting without accents still matches the lexicon
    const shout = await conn.runAndReadAll(
      `SELECT ${sentimentExpr("'OTIMO atendimento, PESSIMO prazo, horrivel'")} AS s`
    )
    expect(String(shout.getRowObjects()[0].s)).toBe('Negativo')

    // word-boundary tokenization: "como" must not match inside "comodidade"
    const bound = await conn.runAndReadAll(
      `SELECT ${intentExpr("'A comodidade do local agradou.'")} AS i`
    )
    expect(String(bound.getRowObjects()[0].i)).toBe('Outro')
  })
})
