import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadEmbeddings } from '../scripts/load-embeddings.js'
import { prisma } from '../src/db.js'
import { resetMl } from '../src/services/ml.js'
import { BOOKS } from './fixtures.js'
import { app, registerUser } from './helpers.js'

// Векторы книг — точки на окружности: соседи по номеру — соседи по смыслу. У первой книги вектора нет
// (как у книг «из одного названия») — для неё старое правило
const MODEL = 'test/content-8' // = EMBEDDING_MODEL в vitest.config.js
const vectorOf = (k) => [Math.cos(k * 0.2), Math.sin(k * 0.2), 0, 0, 0, 0, 0, 0.1]
const [noVector] = BOOKS
const fantasy3 = BOOKS.find((b) => b.title === 'Fantasy Book 3') // номер 7
const dir = mkdtempSync(path.join(tmpdir(), 'bookmind-similar-'))

beforeAll(async () => {
  const file = path.join(dir, 'emb.parquet').replaceAll('\\', '/')
  const values = BOOKS.map((b, k) => [b, k]).filter(([b]) => b !== noVector)
    .map(([b, k]) => `('${b.id}', [${vectorOf(k).join(',')}]::FLOAT[], '${MODEL}')`).join(',')
  const duck = await (await DuckDBInstance.create(':memory:')).connect()
  await duck.run(`COPY (SELECT * FROM (VALUES ${values}) t(book_id, embedding, model)) TO '${file}' (FORMAT parquet)`)
  await loadEmbeddings({ file, databaseUrl: process.env.DATABASE_URL, log: () => {} })
})

afterAll(async () => {
  await prisma.embeddingModel.deleteMany({ where: { name: MODEL } })
  rmSync(dir, { recursive: true, force: true })
})

const similar = (book, auth = {}) => request(app).get(`/api/books/${book.id}/similar`).set(auth).expect(200).then((r) => r.body)

describe('похожие книги по векторам', () => {
  it('ближайшие по вектору; «франшиза» самой книги — не больше 2', async () => {
    const items = await similar(fantasy3)
    // Соседи 6 и 8 — тоже «Fantasy Book …» (одна франшиза по названию), 5 и 9 уже не помещаются
    expect(new Set(items.slice(0, 2).map((b) => b.id))).toEqual(new Set([BOOKS[6].id, BOOKS[8].id]))
    expect(items.filter((b) => b.title.startsWith('Fantasy Book'))).toHaveLength(2)
    // Дальше — соседи на расстоянии 3: «Science Fiction Book 5» (4) и «Thrillers & Suspense Book 1» (10)
    expect(new Set(items.slice(2, 4).map((b) => b.id))).toEqual(new Set([BOOKS[4].id, BOOKS[10].id]))
    expect(items).toHaveLength(12)
  })

  it('скрытая книга в похожих не показывается', async () => {
    const u = await registerUser()
    await request(app).put(`/api/me/hidden/${BOOKS[6].id}`).set(u.auth).expect(200)
    const items = await similar(fantasy3, u.auth)
    expect(items.map((b) => b.id)).not.toContain(BOOKS[6].id)
    expect(items[0].id).toBe(BOOKS[8].id)
  })

  it('у книги нет вектора — старое правило: тот же подраздел', async () => {
    const items = await similar(noVector)
    expect(items.length).toBeGreaterThan(0)
    expect(items[0].subsection).toBe(noVector.subsection)
  })

  it('«Потому что вам понравилась» — соседи по вектору, объяснение прежнее', async () => {
    const u = await registerUser()
    await request(app).put(`/api/me/ratings/${fantasy3.id}`).set(u.auth).send({ value: 5 }).expect(200)
    const feed = await request(app).get('/api/recommendations?limit=20').set(u.auth).expect(200)
    const group = feed.body.becauseYouLiked[0]
    expect(group.seed.id).toBe(fantasy3.id)
    expect(group.items[0].reason).toEqual({ kind: 'similar', text: `Похожа на «${fantasy3.title}»`, seedId: fantasy3.id })
    expect([BOOKS[6].id, BOOKS[8].id]).toContain(group.items[0].book.id)
  })
})

describe('свой каталог по вкусу', () => {
  // Две свои книги: одна рядом с Fantasy Book 3 (номер 7), другая — далеко; известнее та, что далеко
  const near = { id: 'wd:Q900001', title: 'Ближняя', fame: 10, k: 7.2 }
  const far = { id: 'wd:Q900002', title: 'Дальняя', fame: 99, k: 20 }
  beforeAll(async () => {
    for (const b of [near, far]) {
      await prisma.book.create({ data: { id: b.id, title: b.title, author: 'Автор', section: 'Literature & Fiction', category: 'Literature & Fiction', source: 'ru', fame: b.fame, ruKnown: true } })
      await prisma.$executeRawUnsafe(`INSERT INTO book_embeddings (book_id, model, embedding) VALUES ($1, $2, $3::vector)`, b.id, MODEL, `[${vectorOf(b.k).join(',')}]`)
    }
  })
  afterAll(async () => {
    await prisma.book.deleteMany({ where: { id: { in: [near.id, far.id] } } })
  })

  it('похожие своей книги — свой каталог и Amazon через одного; у книги Amazon читающему по-русски — свои на 4-м и 8-м месте', async () => {
    const own = await similar(near)
    expect(own[0]).toMatchObject({ id: far.id, source: 'ru' })
    expect(own[1]).toMatchObject({ id: fantasy3.id, source: 'amazon' })

    const u = await registerUser()
    const amazon = await similar(fantasy3, u.auth) // язык не выбран — читающий по-русски
    expect(amazon[3].id).toBe(near.id)
    expect(amazon[7].id).toBe(far.id)
    await request(app).patch('/api/me/profile').set(u.auth).send({ readingLanguages: ['en'] }).expect(200)
    expect((await similar(fantasy3, u.auth)).some((b) => b.source !== 'amazon')).toBe(false)
  })

  it('«Для вас»: свои книги на 4-м и 9-м месте по близости к понравившимся; в рядах своих книг не повторяются', async () => {
    const u = await registerUser()
    await request(app).put(`/api/me/ratings/${fantasy3.id}`).set(u.auth).send({ value: 5 }).expect(200)
    const forYou = async () => (await request(app).get('/api/recommendations').set(u.auth).expect(200)).body
    const ru = await forYou() // язык не выбран — читающий по-русски
    expect(ru.forYou).toHaveLength(16)
    // Свои книги из другого раздела (Literature & Fiction, а Fantasy Book 3 — фантастика) — без зерна
    expect(ru.forYou[3]).toEqual({ book: expect.objectContaining({ id: near.id, source: 'ru' }), reason: { kind: 'own_catalog' } })
    expect(ru.forYou[8].book.id).toBe(far.id)
    expect(ru.forYou.filter((r) => r.reason?.kind === 'own_catalog')).toHaveLength(2)
    const inRows = ru.local.flatMap((row) => row.items.map((i) => i.book.id))
    expect(inRows).not.toContain(near.id)
    expect(inRows).not.toContain(far.id)

    // Только казахский — казахских книг нет, слота нет; английский — тоже
    for (const readingLanguages of [['kk'], ['en']]) {
      await request(app).patch('/api/me/profile').set(u.auth).send({ readingLanguages }).expect(200)
      expect((await forYou()).forYou.some((r) => r.reason?.kind === 'own_catalog')).toBe(false)
    }
  })

  it('«Похожа на» в слоте — только своя книга того же раздела, заметно ближе остальных своих', async () => {
    // Своя фантастика рядом с Fantasy Book 3 и 20 своих книг далеко — на их фоне она выделяется (z ≥ 2,5)
    const close = { id: 'wd:Q900010', title: 'Близкая фантастика', author: 'Другой автор', k: 7.05 }
    const fillers = Array.from({ length: 20 }, (_, i) => ({ id: `wd:Q9001${String(i).padStart(2, '0')}`, title: `Далёкая ${i}`, author: `Наполнитель ${i}`, k: 16 }))
    const extra = [close, ...fillers]
    try {
      for (const b of extra) {
        await prisma.book.create({ data: { id: b.id, title: b.title, author: b.author, section: 'Science Fiction & Fantasy', category: 'Science Fiction & Fantasy', source: 'ru', fame: 1, ruKnown: true } })
        await prisma.$executeRawUnsafe(`INSERT INTO book_embeddings (book_id, model, embedding) VALUES ($1, $2, $3::vector)`, b.id, MODEL, `[${vectorOf(b.k).join(',')}]`)
      }
      const u = await registerUser()
      await request(app).put(`/api/me/ratings/${fantasy3.id}`).set(u.auth).send({ value: 5 }).expect(200)
      const { forYou } = (await request(app).get('/api/recommendations').set(u.auth).expect(200)).body
      const seed = { id: fantasy3.id, title: fantasy3.title, titleRu: null, author: fantasy3.author, authorRu: null }
      expect(forYou[3]).toEqual({ book: expect.objectContaining({ id: close.id }), reason: { kind: 'own_catalog', seed, seedId: fantasy3.id } })
      // Вторая — другого автора (near), из другого раздела — без зерна
      expect(forYou[8]).toEqual({ book: expect.objectContaining({ id: near.id }), reason: { kind: 'own_catalog' } })
    } finally {
      await prisma.book.deleteMany({ where: { id: { in: extra.map((b) => b.id) } } })
    }
  })

  it('после входа — ближе к понравившимся книгам; гостю — по известности', async () => {
    const u = await registerUser()
    await request(app).put(`/api/me/ratings/${fantasy3.id}`).set(u.auth).send({ value: 5 }).expect(200)
    // С английским — без слота своего каталога в «Для вас», иначе обе книги ушли бы туда из ряда
    await request(app).patch('/api/me/profile').set(u.auth).send({ readingLanguages: ['en'] }).expect(200)
    const list = async (auth) => (await request(app).get('/api/books').query({ source: 'ru' }).set(auth).expect(200)).body.items.map((b) => b.id)
    expect(await list(u.auth)).toEqual([near.id, far.id])
    expect(await list({})).toEqual([far.id, near.id])
    const feed = (await request(app).get('/api/recommendations').set(u.auth).expect(200)).body
    expect(feed.local[0].items[0]).toEqual({ book: expect.objectContaining({ id: near.id }), reason: { kind: 'similar', text: 'По вашему вкусу' } })
  })
})

describe('онбординг: описание своими словами', () => {
  const mystery = BOOKS.find((b) => b.title === 'Mystery Book 3') // номер 17
  const topics = [{ kind: 'section', value: 'Mystery, Thriller & Suspense' }, { kind: 'section', value: 'Science Fiction & Fantasy' }]
  let mlUp
  let vectorFor

  beforeEach(() => {
    resetMl()
    mlUp = true
    vectorFor = vectorOf(17)
    const realFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (!String(url).endsWith('/embed')) return realFetch(url, init)
      if (!mlUp) throw new TypeError('fetch failed')
      // Описание «про» Mystery Book 3
      return new Response(JSON.stringify({ model: MODEL, dim: 8, vectors: [vectorFor] }))
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('в первом раунде — книги, ближайшие к описанию, в выбранных темах', async () => {
    const u = await registerUser()
    await request(app).post('/api/onboarding/answers').set(u.auth).send({ topics, description: 'запутанные детективы' }).expect(200)
    const round = (await request(app).get('/api/onboarding/next-round').set(u.auth).expect(200)).body
    const described = round.items.filter((i) => i.reason.text === 'Близко к вашему описанию')
    expect(described.length).toBeGreaterThan(0)
    expect(described.length).toBeLessThanOrEqual(4)
    expect(described[0].book.id).toBe(mystery.id)
    expect(described.every((i) => i.reason.kind === 'topic')).toBe(true)
    expect(round.items.length).toBeLessThanOrEqual(12)
    expect(new Set(round.items.map((i) => i.book.id)).size).toBe(round.items.length)
  })

  const describedIn = async (send) => {
    const u = await registerUser()
    await request(app).post('/api/onboarding/answers').set(u.auth).send(send).expect(200)
    const round = (await request(app).get('/api/onboarding/next-round').set(u.auth).expect(200)).body
    return { round, described: round.items.filter((i) => i.reason.text === 'Близко к вашему описанию').map((i) => i.book) }
  }

  it('книги по описанию — узнаваемые: сначала с 200+ оценками, меньше 50 — не берём', async () => {
    // Описание «про» The Mara Quill Collection (номер 22, 20 оценок)
    vectorFor = vectorOf(22)
    const { described } = await describedIn({ topics: [{ kind: 'section', value: 'Literature & Fiction' }], description: 'про Мару Квилл' })
    const ids = described.map((b) => b.id)
    // Q3 (20 оценок) — нет; из книг Mara Quill (одна на автора) — ближайшая узнаваемая Q2 (200); дальше — 200+ из всего
    // каталога (соседи 19, 18…), а Q4 (150) не помещается
    expect(ids[0]).toBe('Q000000002')
    expect(ids).not.toContain('Q000000003')
    expect(described.every((b) => b.ratingsCount >= 200)).toBe(true)
  })

  it('описание ищет по всему каталогу: тема выбрана другая, ближайшая книга вне её — находится', async () => {
    const { described } = await describedIn({ topics: [{ kind: 'section', value: 'Literature & Fiction' }], description: 'запутанные детективы' })
    expect(described[0].id).toBe(mystery.id)
  })

  it('темы необязательны: раунд строится от описания — разведка в разделах найденных книг', async () => {
    const { round, described } = await describedIn({ description: 'запутанные детективы' })
    expect(described[0].id).toBe(mystery.id)
    const sections = new Set(described.map((b) => b.section))
    expect(round.items.every((i) => sections.has(i.book.section))).toBe(true)
  })

  it('темы необязательны: любимая книга из поиска — уже в первом раунде похожие на неё', async () => {
    mlUp = false
    const u = await registerUser()
    await request(app).post('/api/onboarding/answers').set(u.auth)
      .send({ round: 1, answers: [{ bookId: fantasy3.id, answer: 'like', source: 'search' }] }).expect(200)
    const round = (await request(app).get('/api/onboarding/next-round').set(u.auth).expect(200)).body
    expect(round.round).toBe(1)
    const similarItems = round.items.filter((i) => i.reason.seedId === fantasy3.id)
    expect(similarItems.length).toBeGreaterThan(0)
    expect(round.items.map((i) => i.book.id)).not.toContain(fantasy3.id)
  })

  it('ML-сервис недоступен — раунд как раньше, без ошибки', async () => {
    mlUp = false
    const u = await registerUser()
    await request(app).post('/api/onboarding/answers').set(u.auth).send({ topics, description: 'запутанные детективы' }).expect(200)
    const round = (await request(app).get('/api/onboarding/next-round').set(u.auth).expect(200)).body
    expect(round.items.length).toBeGreaterThan(0)
    expect(round.items.some((i) => i.reason.text === 'Близко к вашему описанию')).toBe(false)
  })
})
