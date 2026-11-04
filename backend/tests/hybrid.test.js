import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadEmbeddings } from '../scripts/load-embeddings.js'
import { prisma } from '../src/db.js'
import { fuse, semanticWeight } from '../src/routes/search.js'
import { resetMl } from '../src/services/ml.js'
import { AUTHOR_BOOKS, BOOKS } from './fixtures.js'
import { app } from './helpers.js'

// Векторы книг — точки на окружности (соседи по номеру — соседи по смыслу); ML-сервис — мок fetch:
// для запроса возвращает вектор выбранной книги, будто запрос «про неё»
const MODEL = 'test/hybrid-8'
const vectorOf = (k) => [Math.cos(k * 0.2), Math.sin(k * 0.2), 0, 0, 0, 0, 0, 0.1]
const near = (book) => vectorOf(BOOKS.indexOf(book))
const fantasy = BOOKS.find((b) => b.title === 'Fantasy Book 3')
const dir = mkdtempSync(path.join(tmpdir(), 'bookmind-hybrid-'))

let answer // (text) => { model, vector } | Error | 'hang'
let fetchSpy
const json = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

beforeAll(async () => {
  const file = path.join(dir, 'emb.parquet').replaceAll('\\', '/')
  const values = BOOKS.map((b, k) => `('${b.id}', [${vectorOf(k).join(',')}]::FLOAT[], '${MODEL}')`).join(',')
  const duck = await (await DuckDBInstance.create(':memory:')).connect()
  await duck.run(`COPY (SELECT * FROM (VALUES ${values}) t(book_id, embedding, model)) TO '${file}' (FORMAT parquet)`)
  await loadEmbeddings({ file, databaseUrl: process.env.DATABASE_URL, log: () => {} })
})

afterAll(async () => {
  await prisma.embeddingModel.deleteMany({ where: { name: MODEL } })
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  resetMl()
  answer = () => ({ model: MODEL, vector: near(fantasy) })
  const realFetch = globalThis.fetch
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (!String(url).endsWith('/embed')) return realFetch(url, init)
    const out = answer(JSON.parse(init.body).texts[0])
    if (out === 'hang') {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
    }
    if (out instanceof Error) throw out
    // 1e400 → Infinity после JSON.parse: pgvector такой вектор не примет — ошибка SQL в смысловой части
    if (out === 'infinite') return new Response(`{"model":"${MODEL}","dim":8,"vectors":[[1e400,0,0,0,0,0,0,0]]}`)
    return json({ model: out.model, dim: out.vector.length, vectors: [out.vector] })
  })
})

afterEach(() => vi.restoreAllMocks())

const search = (query) => request(app).get('/api/search').query(query).expect(200).then((r) => r.body)

describe('гибридный поиск', () => {
  it('запрос по-русски находит книги по смыслу; ближайшая — первой', async () => {
    const res = await search({ q: 'книга про драконов и магию' })
    expect(res.mode).toBe('hybrid')
    expect(res.items[0].id).toBe(fantasy.id)
    expect(res.items.slice(1, 3).map((b) => b.subsection)).toEqual(['Fantasy', 'Fantasy'])
    expect(res.total).toBe(BOOKS.length) // по смыслу «найдено» всё, что есть в векторах (книг мало)
  })

  it('точное название остаётся первым, даже если по смыслу запрос о другом', async () => {
    const res = await search({ q: 'Silent River' })
    expect(res.mode).toBe('hybrid')
    expect(res.items[0].title).toBe('Silent River')
    expect(res.items.map((b) => b.id)).toContain(fantasy.id) // смысловая часть тоже подмешана
  })

  it('опечатка в имени автора: исправленные совпадения сверху, смысловая часть — ниже', async () => {
    const res = await search({ q: 'mara quil' })
    expect(res).toMatchObject({ mode: 'hybrid', fuzzy: true })
    // Три романа автора и книга о нём (имя в названии) — выше смысловых соседей «Fantasy Book 3»
    expect(new Set(res.items.slice(0, 4).map((b) => b.id))).toEqual(new Set(AUTHOR_BOOKS.map((b) => b.id)))
    expect(res.items[4].subsection).toBe('Fantasy')
  })

  it('фильтры действуют и на смысловую часть', async () => {
    const res = await search({ q: 'книга про драконов', section: 'Mystery, Thriller & Suspense', year: '2012-2013' })
    expect(res.items.length).toBeGreaterThan(0)
    expect(res.items.every((b) => b.section === 'Mystery, Thriller & Suspense' && b.year >= 2012 && b.year <= 2013)).toBe(true)
  })

  it('режимы keyword и semantic (для эксперимента E5)', async () => {
    const keyword = await search({ q: 'fantasy book 3', mode: 'keyword' })
    expect(keyword.mode).toBe('keyword')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(keyword.items[0].title).toBe('Fantasy Book 3')

    const semantic = await search({ q: 'что-то про драконов', mode: 'semantic', limit: 5 })
    expect(semantic).toMatchObject({ mode: 'semantic', fuzzy: false, total: BOOKS.length })
    // Ближайшие к «Fantasy Book 3» (номер 7) — она сама и соседи 5–9
    expect(semantic.items[0].id).toBe(fantasy.id)
    expect(new Set(semantic.items.map((b) => b.id))).toEqual(new Set([5, 6, 7, 8, 9].map((k) => BOOKS[k].id)))
    await request(app).get('/api/search').query({ q: 'x', mode: 'magic' }).expect(400)
  })

  it('листание гибрида: страницы не повторяются и складываются в total', async () => {
    const all = []
    for (let offset = 0; offset < 40; offset += 7) {
      const page = await search({ q: 'book', limit: 7, offset })
      all.push(...page.items.map((b) => b.id))
    }
    const first = await search({ q: 'book', limit: 7 })
    expect(new Set(all).size).toBe(all.length)
    expect(all.length).toBe(first.total)
  })

  it('ML-сервис недоступен — обычный поиск без ошибки, повторно сервис не дёргаем', async () => {
    answer = () => new TypeError('fetch failed')
    const res = await search({ q: 'fantasy book 3' })
    expect(res).toMatchObject({ mode: 'keyword' })
    expect(res.items[0].title).toBe('Fantasy Book 3')
    await search({ q: 'другой запрос' })
    expect(fetchSpy).toHaveBeenCalledTimes(1) // пауза после сбоя
  })

  it('ML-сервис завис — ждём не дольше таймаута', async () => {
    answer = () => 'hang'
    const started = Date.now()
    const res = await search({ q: 'fantasy book 3' })
    expect(res.mode).toBe('keyword')
    expect(Date.now() - started).toBeLessThan(1500) // таймаут в тестах — 300 мс
  })

  it('ошибка смыслового запроса в базе — обычный поиск, не 500', async () => {
    answer = () => 'infinite'
    const res = await search({ q: 'fantasy book 3' })
    expect(res.mode).toBe('keyword')
    expect(res.items[0].title).toBe('Fantasy Book 3')
  })

  it('векторов модели ML-сервиса нет в базе — обычный поиск', async () => {
    answer = () => ({ model: 'other/model', vector: near(fantasy) })
    expect((await search({ q: 'fantasy book 3' })).mode).toBe('keyword')
  })
})

describe('смешивание RRF', () => {
  it('точные совпадения сверху, остальное — по сумме 1/(k + место)', () => {
    const keyword = [{ id: 'A' }, { id: 'B' }, { id: 'X', pinned: true }, { id: 'C' }]
    // при равных весах B: 1/62 + 1/61 — выше A (только 1/61) и C
    expect(fuse(keyword, ['B', 'D'], 1)).toEqual(['X', 'B', 'A', 'D', 'C'])
  })

  it('вес смысловой части: по умолчанию (2) смысловая находка выше обычной на том же месте', () => {
    const keyword = [{ id: 'A' }, { id: 'B' }]
    expect(fuse(keyword, ['C', 'B'], 1)).toEqual(['B', 'A', 'C']) // A и C поровну — порядок обычного поиска
    expect(fuse(keyword, ['C', 'B'])).toEqual(['B', 'C', 'A'])
    expect(fuse([{ id: 'X', pinned: true }, ...keyword], ['C'], 5)[0]).toBe('X')
  })

  it('semWeight=auto — по длине запроса', () => {
    expect(semanticWeight('auto', 'dune')).toBe(1)
    expect(semanticWeight('auto', 'книга про девушку на болотах')).toBe(2)
    expect(semanticWeight(2.5, 'dune')).toBe(2.5)
  })
})

describe('вес смысловой части в /search', () => {
  it('по умолчанию вес 2; точное название сверху при любом весе; неверный вес — 400', async () => {
    const plain = await search({ q: 'book' })
    expect((await search({ q: 'book', semWeight: 2 })).items.map((b) => b.id)).toEqual(plain.items.map((b) => b.id))
    const heavy = await search({ q: 'Silent River', semWeight: 5 })
    expect(heavy.items[0].title).toBe('Silent River')
    expect((await search({ q: 'книга про драконов и магию', semWeight: 'auto' })).mode).toBe('hybrid')
    await request(app).get('/api/search').query({ q: 'book', semWeight: 'много' }).expect(400)
    await request(app).get('/api/search').query({ q: 'book', semWeight: 9 }).expect(400)
  })
})
