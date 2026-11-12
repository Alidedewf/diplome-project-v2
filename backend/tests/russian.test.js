import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadAnnotations } from '../scripts/load-annotations-ru.js'
import { resolveTitle } from '../scripts/load-wikidata-ru.js'
import { prisma } from '../src/db.js'
import { fuse } from '../src/routes/search.js'
import { BOOKS } from './fixtures.js'
import { app, registerUser } from './helpers.js'

// Книга, известная по-русски (2.8): в своём разделе не самая популярная; взвешенный рейтинг 4,3 — с добавкой
// для читающих по-русски обходит Thrillers & Suspense Book 1 (тоже 4,3)
const known = BOOKS.find((b) => b.id === 'T000000017') // Mystery Book 3
const MYSTERY = 'Mystery, Thriller & Suspense'
const RU = { titleRu: 'Тайна пятая', authorRu: 'Автор Четырнадцать', ruKnown: true }

beforeAll(async () => {
  await prisma.book.update({ where: { id: known.id }, data: RU })
})
afterAll(async () => {
  await prisma.book.update({ where: { id: known.id }, data: { titleRu: null, authorRu: null, ruKnown: false } })
})

async function reader(readingLanguages) {
  const u = await registerUser()
  if (readingLanguages) {
    await request(app).patch('/api/me/profile').set(u.auth).send({ readingLanguages }).expect(200)
  }
  return u
}

describe('языки чтения', () => {
  it('в профиле: без пароля, повторы убираются, неизвестный язык — 400', async () => {
    const u = await registerUser()
    expect(u.user.readingLanguages).toEqual([])
    const res = await request(app).patch('/api/me/profile').set(u.auth).send({ readingLanguages: ['kk', 'ru', 'ru'] }).expect(200)
    expect(res.body.user.readingLanguages).toEqual(['ru', 'kk'])
    expect((await request(app).get('/api/auth/me').set(u.auth).expect(200)).body.user.readingLanguages).toEqual(['ru', 'kk'])
    await request(app).patch('/api/me/profile').set(u.auth).send({ readingLanguages: ['de'] }).expect(400)
  })

  it('в онбординге: и без completed; пустой список — сброс', async () => {
    const u = await registerUser()
    const set = (readingLanguages) => request(app).post('/api/onboarding/answers').set(u.auth).send({ readingLanguages }).expect(200)
    expect((await set(['en'])).body.user).toMatchObject({ readingLanguages: ['en'], onboardingCompleted: false })
    expect((await set([])).body.user.readingLanguages).toEqual([])
  })
})

describe('русское название и имя автора', () => {
  it('в книге, в подсказках и в поиске по русскому названию', async () => {
    const book = (await request(app).get(`/api/books/${known.id}`).expect(200)).body
    expect(book).toMatchObject({ title: known.title, titleRu: RU.titleRu, authorRu: RU.authorRu })
    expect((await request(app).get(`/api/books/${BOOKS[0].id}`).expect(200)).body).toMatchObject({ titleRu: null, authorRu: null })

    const suggest = (await request(app).get('/api/search/suggest').query({ q: 'тайна' }).expect(200)).body
    expect(suggest[0]).toMatchObject({ id: known.id, titleRu: RU.titleRu, authorRu: RU.authorRu })

    const found = (await request(app).get('/api/search').query({ q: 'Тайна пятая', mode: 'keyword' }).expect(200)).body
    expect(found.items[0].id).toBe(known.id)
  })
})

describe('русское название из Wikidata: произведение, а не цикл', () => {
  const book = { title: 'Dune', author: 'Frank Herbert' }
  const herbert = ['Frank Herbert']
  const series = { qid: 'Q6095696', ru: 'Хроники Дюны', authors: herbert }
  const film = { qid: 'Q60834962', ru: 'Дюна', authors: herbert }
  const novel = { qid: 'Q190192', ru: 'Дюна (роман)', authors: herbert }
  const types = { Q6095696: ['Q1667921'], Q60834962: ['Q11424'], Q190192: ['Q7725634'] }

  it('сначала произведение, затем что угодно, кроме цикла; только цикл — без названия', () => {
    expect(resolveTitle(book, [series, film, novel], types)).toEqual({ ru: 'Дюна', qid: 'Q190192' })
    expect(resolveTitle(book, [series, film], types)).toEqual({ ru: 'Дюна', qid: 'Q60834962' })
    expect(resolveTitle(book, [series], types)).toBeNull()
    expect(resolveTitle({ ...book, author: 'Kevin J. Anderson' }, [novel], types)).toBeNull() // фамилия автора другая
  })
})

describe('читающим по-русски — сначала известные по-русски', () => {
  it('популярное в разделе: сначала известные по-русски — и для гостя, и без выбранного языка; с английским — как раньше', async () => {
    const first = async (auth) => (await request(app).get('/api/books').query({ section: MYSTERY }).set(auth).expect(200)).body.items
    for (const langs of [['ru'], ['kk'], []]) expect((await first((await reader(langs)).auth))[0].id).toBe(known.id)
    expect((await first({}))[0].id).toBe(known.id)
    const en = await first((await reader(['en'])).auth)
    expect(en[0].id).not.toBe(known.id)
    expect((await first((await reader(['ru', 'en'])).auth)).map((b) => b.id)).toEqual(en.map((b) => b.id))
  })

  it('«Для вас»: мягкое повышение — книга выше, чем у читающего по-английски', async () => {
    const place = async (u) => {
      await request(app).post('/api/onboarding/answers').set(u.auth).send({ topics: [{ kind: 'section', value: MYSTERY }] }).expect(200)
      const feed = (await request(app).get('/api/recommendations?limit=10').set(u.auth).expect(200)).body
      return feed.forYou.findIndex((r) => r.book.id === known.id)
    }
    const ruPlace = await place(await reader(['ru']))
    const enPlace = await place(await reader(['en']))
    expect(ruPlace).toBeGreaterThanOrEqual(0)
    expect(ruPlace).toBeLessThan(enPlace)
  })

  it('объяснение «Похожа на…» — русским названием', async () => {
    const u = await reader(['ru'])
    await request(app).put(`/api/me/ratings/${known.id}`).set(u.auth).send({ value: 5 }).expect(200)
    const feed = (await request(app).get('/api/recommendations').set(u.auth).expect(200)).body
    const group = feed.becauseYouLiked.find((g) => g.seed.id === known.id)
    expect(group.seed.titleRu).toBe(RU.titleRu)
    for (const item of group.items) expect(item.reason.text).toBe(`Похожа на «${RU.titleRu}»`)
  })

  it('онбординг: в разведке раздела сначала известные по-русски', async () => {
    const u = await reader(['ru'])
    await request(app).post('/api/onboarding/answers').set(u.auth).send({ topics: [{ kind: 'section', value: MYSTERY }] }).expect(200)
    const round = (await request(app).get('/api/onboarding/next-round').set(u.auth).expect(200)).body
    expect(round.items[0].book.id).toBe(known.id)
  })

  it('смешивание RRF: добавка известным по-русски, точные совпадения всё равно сверху', () => {
    const keyword = [{ id: 'A' }, { id: 'B' }]
    expect(fuse(keyword, [], 2)).toEqual(['A', 'B'])
    expect(fuse(keyword, [], 2, new Set(['B']))).toEqual(['B', 'A'])
    expect(fuse([{ id: 'X', pinned: true }, ...keyword], [], 2, new Set(['B']))[0]).toBe('X')
  })
})

describe('русское описание', () => {
  const [wiki, translated] = [BOOKS[1], BOOKS[2]]
  const dir = mkdtempSync(path.join(tmpdir(), 'bookmind-ann-'))
  afterAll(async () => {
    await prisma.book.updateMany({ where: { id: { in: [wiki.id, translated.id] } }, data: { annotationRu: null, annotationSource: null, annotationUrl: null } })
    rmSync(dir, { recursive: true, force: true })
  })

  it('машинный перевод из файла ML: Википедию не перетирает; на карточке — с источником, в списках — нет', async () => {
    await prisma.book.update({ where: { id: wiki.id }, data: { annotationRu: 'Из Википедии', annotationSource: 'wikipedia', annotationUrl: 'https://ru.wikipedia.org/wiki/X' } })
    const file = path.join(dir, 'mt.parquet').replaceAll('\\', '/')
    const duck = await (await DuckDBInstance.create(':memory:')).connect()
    await duck.run(`COPY (SELECT * FROM (VALUES ('${wiki.id}', 'Перевод 1'), ('${translated.id}', 'Перевод 2'), ('NOPE', 'x'))
      t(book_id, annotation_ru)) TO '${file}' (FORMAT parquet)`)
    const result = await loadAnnotations({ file, databaseUrl: process.env.DATABASE_URL, log: () => {} })
    expect(result).toEqual({ rows: 3, written: 1 })

    const card = async (b) => (await request(app).get(`/api/books/${b.id}`).expect(200)).body
    expect(await card(wiki)).toMatchObject({ annotationRu: 'Из Википедии', annotationSource: 'wikipedia', annotationUrl: 'https://ru.wikipedia.org/wiki/X' })
    expect(await card(translated)).toMatchObject({ annotationRu: 'Перевод 2', annotationSource: 'mt', annotationUrl: null })
    const list = (await request(app).get('/api/books').query({ section: translated.section, limit: 50 }).expect(200)).body.items
    expect(list.find((b) => b.id === translated.id)).not.toHaveProperty('annotationRu')
  })
})

