import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadReviewSummary } from '../scripts/load-review-summary.js'
import { prisma } from '../src/db.js'
import { sameWork } from '../src/lib/review-summary.js'
import { app, registerUser } from './helpers.js'

// Сводка отзывов (4.13): книга со сводкой, второе издание без своей, книга без сводки и своя русская книга.
// Оценок мало — в ленты и популярное чужих тестов не попадают
const base = { section: 'Literature & Fiction', category: 'Literature & Fiction', subsection: 'Literary Fiction', year: 2016, rating: 4.1, weightedRating: 4, ratingsCount: 3 }
const BOOKS = [
  { id: 'R000000001', title: 'Harbor Lights', author: 'Nell Ashby' },
  { id: 'R000000002', title: 'Harbor Lights: The Illustrated Edition', author: 'Nell Ashby' },
  { id: 'R000000003', title: 'Quiet Fields', author: 'Ola Brand' },
  { id: 'R000000004', title: 'Harbor Lights', author: 'Other Writer' },
  { id: 'R000000005', title: 'Harbor Lights: The Graphic Novel, Book 2', author: 'Nell Ashby' },
  { id: 'R000000006', title: 'Harbor Lights: Book One of the Harbor Trilogy', author: 'Nell Ashby' },
  { id: 'wd:Q90000001', title: 'Тихий берег', author: 'Иван Тестов', source: 'ru', language: 'Russian', ratingsCount: 0, rating: null },
].map((b) => ({ ...base, ...b }))
const [harbor, harborIllustrated, quiet, namesake, harborGraphic, harborBookOne, ownRu] = BOOKS

const COLS = 'book_id, analyzed, aspect, label_ru, kind, verdict, share_pos, mentions, mention_share, quote_pos, quote_neg, rank'
const q = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replaceAll("'", "''")}'`)
// Строки сводки нарочно не по rank: порядок показа — по rank, а не по файлу
const ROWS = [
  [harbor.id, 20, 'characters', 'Персонажи', 'aspect', 'praise', 0.8333333, 12, 0.6, 'The characters felt "real", and alive.', null, 3],
  [harbor.id, 20, 'overall', 'В целом', 'overall', 'praise', 0.9, 15, 0.75, 'A wonderful read.', 'Not for me.', 1],
  [harbor.id, 20, 'audience', 'Кому подойдёт', 'info', null, null, 4, 0.2, 'Great for book clubs.', null, 6],
  [harbor.id, 20, 'plot', 'Сюжет', 'aspect', 'mixed', 0.5, 10, 0.5, 'The plot twists kept me going.', 'The ending dragged,\nhonestly.', 2],
  [harbor.id, 20, 'pace', 'Темп', 'aspect', 'criticize', 0.25, 4, 0.2, null, 'Way too slow.', 4],
  [ownRu.id, 20, 'overall', 'В целом', 'overall', 'praise', 0.9, 15, 0.75, 'Nice.', null, 1],
  ['NOPE000001', 30, 'overall', 'В целом', 'overall', 'praise', 0.9, 20, 0.66, 'x', null, 1],
  ['NOPE000002', 30, 'plot', 'Сюжет', 'aspect', 'praise', 0.9, 20, 0.66, 'y', null, 1],
]

const dir = mkdtempSync(path.join(tmpdir(), 'bookmind-summary-'))
async function writeParquet(name, rows) {
  const file = path.join(dir, name).replaceAll('\\', '/')
  const values = rows.map((r) => `(${r.map(q).join(', ')})`).join(', ')
  const duck = await (await DuckDBInstance.create(':memory:')).connect()
  await duck.run(`COPY (SELECT book_id::VARCHAR AS book_id, analyzed::BIGINT AS analyzed, aspect::VARCHAR AS aspect,
      label_ru::VARCHAR AS label_ru, kind::VARCHAR AS kind, verdict::VARCHAR AS verdict, share_pos::DOUBLE AS share_pos,
      mentions::BIGINT AS mentions, mention_share::DOUBLE AS mention_share, quote_pos::VARCHAR AS quote_pos,
      quote_neg::VARCHAR AS quote_neg, rank::BIGINT AS rank
    FROM (VALUES ${values}) t(${COLS})) TO '${file}' (FORMAT parquet)`)
  return file
}
const load = (file) => loadReviewSummary({ file, databaseUrl: process.env.DATABASE_URL, log: () => {} })
const card = async (id, auth = {}) => (await request(app).get(`/api/books/${encodeURIComponent(id)}`).set(auth).expect(200)).body
const tableCounts = async () => ({
  books: await prisma.reviewSummary.count(),
  items: await prisma.reviewSummaryItem.count(),
})

beforeAll(async () => {
  await prisma.book.createMany({ data: BOOKS })
})
afterAll(async () => {
  await prisma.reviewSummary.deleteMany({})
  await prisma.book.deleteMany({ where: { id: { in: BOOKS.map((b) => b.id) } } })
  rmSync(dir, { recursive: true, force: true })
})

describe('загрузка сводок', () => {
  it('книги вне каталога пропускаются и считаются; повторный запуск — тот же результат', async () => {
    const file = await writeParquet('summary.parquet', ROWS)
    const first = await load(file)
    expect(first).toEqual({ rows: 8, books: 2, items: 6, skippedBooks: 2 })
    const counts = await tableCounts()
    expect(counts).toEqual({ books: 2, items: 6 })

    expect(await load(file)).toEqual(first)
    expect(await tableCounts()).toEqual(counts)
  })

  it('перезаписывает целиком: книги, которых нет в новом файле, теряют сводку', async () => {
    await load(await writeParquet('summary.parquet', ROWS))
    await load(await writeParquet('quiet.parquet', [[quiet.id, 12, 'overall', 'В целом', 'overall', 'mixed', 0.5, 6, 0.5, 'Fine.', 'Meh.', 1]]))
    expect(await tableCounts()).toEqual({ books: 1, items: 1 })
    expect((await card(harbor.id)).reviewSummary).toBeNull()
    expect((await card(quiet.id)).reviewSummary).toMatchObject({ analyzed: 12, overall: { verdict: 'mixed' }, aspects: [], info: [] })
  })

  it('чужой kind или пропущенная колонка — ошибка, прежние сводки остаются', async () => {
    await load(await writeParquet('summary.parquet', ROWS))
    const bad = ROWS.map((r, i) => (i === 0 ? [...r.slice(0, 4), 'aspekt', ...r.slice(5)] : r))
    await expect(load(await writeParquet('bad.parquet', bad))).rejects.toThrow(/review_summary_items_kind_check/)
    const noVerdict = ROWS.map((r, i) => (i === 0 ? [...r.slice(0, 5), null, ...r.slice(6)] : r))
    await expect(load(await writeParquet('no-verdict.parquet', noVerdict))).rejects.toThrow(/verdict_check/)
    expect(await tableCounts()).toEqual({ books: 2, items: 6 })

    const file = path.join(dir, 'cols.parquet').replaceAll('\\', '/')
    const duck = await (await DuckDBInstance.create(':memory:')).connect()
    await duck.run(`COPY (SELECT 'R000000001' AS book_id, 1 AS rank) TO '${file}' (FORMAT parquet)`)
    await expect(load(file)).rejects.toThrow(/нет колонок: analyzed/)
  })
})

describe('сводка в карточке книги', () => {
  beforeAll(async () => {
    await load(await writeParquet('summary.parquet', ROWS))
  })

  it('формат: в целом, аспекты и справка по rank, доля округлена, цитаты как в файле', async () => {
    const { reviewSummary } = await card(harbor.id)
    expect(reviewSummary).toEqual({
      analyzed: 20,
      overall: { verdict: 'praise', sharePos: 0.9, mentions: 15, quotePos: 'A wonderful read.', quoteNeg: 'Not for me.' },
      aspects: [
        { aspect: 'plot', label: 'Сюжет', verdict: 'mixed', sharePos: 0.5, mentions: 10, quotePos: 'The plot twists kept me going.', quoteNeg: 'The ending dragged,\nhonestly.' },
        { aspect: 'characters', label: 'Персонажи', verdict: 'praise', sharePos: 0.833, mentions: 12, quotePos: 'The characters felt "real", and alive.', quoteNeg: null },
        { aspect: 'pace', label: 'Темп', verdict: 'criticize', sharePos: 0.25, mentions: 4, quotePos: null, quoteNeg: 'Way too slow.' },
      ],
      info: [{ aspect: 'audience', label: 'Кому подойдёт', mentions: 4, quotePos: 'Great for book clubs.' }],
    })
  })

  it('и для вошедшего пользователя', async () => {
    const u = await registerUser()
    const body = await card(harbor.id, u.auth)
    expect(body.reviewSummary).toMatchObject({ analyzed: 20, overall: { verdict: 'praise' } })
    expect(body.my).toEqual({ rating: null, shelf: null, hidden: false })
  })

  it('сводки нет — null; без «в целом» — overall null', async () => {
    expect((await card(quiet.id)).reviewSummary).toBeNull()
    await load(await writeParquet('no-overall.parquet', ROWS.filter((r) => r[4] !== 'overall')))
    const { reviewSummary } = await card(harbor.id)
    expect(reviewSummary.overall).toBeNull()
    expect(reviewSummary.aspects.map((a) => a.aspect)).toEqual(['plot', 'characters', 'pace'])
    await load(await writeParquet('summary.parquet', ROWS))
  })

  it('другое издание той же книги берёт её сводку; тёзка другого автора, комикс и второй том — нет', async () => {
    const own = (await card(harbor.id)).reviewSummary
    expect((await card(harborIllustrated.id)).reviewSummary).toEqual(own)
    expect((await card(harborBookOne.id)).reviewSummary).toEqual(own)
    expect((await card(namesake.id)).reviewSummary).toBeNull()
    expect((await card(harborGraphic.id)).reviewSummary).toBeNull()
  })

  it('sameWork: подзаголовок издания — та же книга, адаптация и другой том — нет', () => {
    expect(sameWork('Dune', 'Dune: Book One in the Dune Chronicles')).toBe(true)
    expect(sameWork('Grownup', 'The Grownup (Kindle Single)')).toBe(true)
    expect(sameWork('Sapiens: A Brief History of Humankind', 'Sapiens: A Graphic History, Volume 2: The Pillars of Civilization')).toBe(false)
    expect(sameWork('Dune', 'DUNE: The Graphic Novel, Book 2: Muad’Dib')).toBe(false)
    expect(sameWork('Moon Saga: Part 2', 'Moon Saga: Part II')).toBe(true)
    expect(sameWork('Moon Saga', 'Moon Saga: Part Two')).toBe(false)
    expect(sameWork('Confessions: The Murder of an Angel (Confessions, 4)', 'Confessions: The Private School Murders (Confessions, 2)')).toBe(false)
    expect(sameWork('Gone Girl: A Novel', 'Gone Girl')).toBe(true)
    expect(sameWork('Moon Tale: A Novel', 'Moon Tale: The 10th Anniversary Edition')).toBe(true)
    expect(sameWork('Batman: The Resurrection of Ra’s Al Ghul', 'Batman: Arkham Asylum Anniversary Edition')).toBe(false)
    expect(sameWork('Fancy Nancy: JoJo and the Magic Trick (My First I Can Read)', 'Fancy Nancy')).toBe(false)
    expect(sameWork('A Test of Wills', 'A Test of Wills: The First Inspector Ian Rutledge Mystery')).toBe(true)
  })

  it('у своих русских и казахских книг сводки нет', async () => {
    expect(await prisma.reviewSummary.findUnique({ where: { bookId: ownRu.id } })).not.toBeNull()
    expect((await card(ownRu.id)).reviewSummary).toBeNull()
  })
})
