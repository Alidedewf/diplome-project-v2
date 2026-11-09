import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { app, registerUser } from './helpers.js'

// Свой каталог (1.5): русские и казахские книги из Wikidata, без оценок, с известностью (fame)
const own = { language: 'Russian', category: 'Literature & Fiction', section: 'Literature & Fiction', subsection: 'World Literature', ratingsCount: 0, rating: null, weightedRating: 4, ruKnown: true }
const BOOKS = [
  { id: 'wd:Q100001', title: 'Мастер и Маргарита', author: 'Михаил Булгаков', year: 1967, fame: 90, source: 'ru', wikidataQid: 'Q100001' },
  { id: 'wd:Q100002', title: 'Белая гвардия', author: 'Михаил Булгаков', year: 1925, fame: 40, source: 'ru', wikidataQid: 'Q100002' },
  { id: 'wd:Q100003', title: 'Пикник на обочине', author: 'Стругацкие', year: 1972, fame: 60, source: 'ru', wikidataQid: 'Q100003',
    section: 'Science Fiction & Fantasy', category: 'Science Fiction & Fantasy', subsection: null },
  { id: 'wd:Q100004', title: 'Абай жолы', titleRu: 'Путь Абая', author: 'Мұхтар Әуезов', authorRu: 'Мухтар Ауэзов', year: 1942, fame: 30,
    source: 'kz', language: 'Kazakh', wikidataQid: 'Q100004', annotation: 'Роман-эпопея.', annotationRu: 'Роман-эпопея.', annotationSource: 'wikipedia',
    annotationUrl: 'https://ru.wikipedia.org/wiki/Путь_Абая' },
].map((b) => ({ ...own, ...b }))
const [master, guard, picnic, abai] = BOOKS

beforeAll(async () => {
  await prisma.book.createMany({ data: BOOKS })
})
afterAll(async () => {
  await prisma.book.deleteMany({ where: { id: { in: BOOKS.map((b) => b.id) } } })
})

describe('свой каталог русских и казахских книг', () => {
  it('книга — с источником; у своих оценок нет; казахская — оригинал и русское название', async () => {
    const card = (await request(app).get(`/api/books/${encodeURIComponent(abai.id)}`).expect(200)).body
    expect(card).toMatchObject({ source: 'kz', originalLanguage: 'kk', title: 'Абай жолы', titleRu: 'Путь Абая', author: 'Мұхтар Әуезов', authorRu: 'Мухтар Ауэзов',
      rating: null, ratingsCount: 0, annotationRu: 'Роман-эпопея.', annotationSource: 'wikipedia' })
    const amazon = (await request(app).get('/api/books').query({ limit: 1, section: 'Mystery, Thriller & Suspense' }).expect(200)).body.items[0]
    expect(amazon).toMatchObject({ source: 'amazon', originalLanguage: null })
    const ru = (await request(app).get(`/api/books/${encodeURIComponent(master.id)}`).expect(200)).body
    expect(ru.originalLanguage).toBe('ru')
  })

  it('GET /books?source= — по известности; неизвестный источник — 400', async () => {
    const ids = async (q) => (await request(app).get('/api/books').query(q).expect(200)).body
    const ru = await ids({ source: 'ru' })
    expect(ru.items.map((b) => b.id)).toEqual([master.id, picnic.id, guard.id])
    expect(ru.total).toBe(3)
    expect((await ids({ source: 'kz' })).items.map((b) => b.id)).toEqual([abai.id])
    expect((await ids({ source: 'ru', section: 'Science Fiction & Fantasy' })).items.map((b) => b.id)).toEqual([picnic.id])
    await request(app).get('/api/books').query({ source: 'xx' }).expect(400)
  })

  it('лента: ряды «Русская литература» и «Казахская литература»; темы пользователя — первыми', async () => {
    const guest = (await request(app).get('/api/recommendations').expect(200)).body
    expect(guest.local.map((r) => r.source)).toEqual(['ru', 'kz'])
    expect(guest.local[0].items.map((i) => i.book.id)).toEqual([master.id, picnic.id, guard.id])
    expect(guest.local[0].items[0].reason).toEqual({ kind: 'popular', text: 'Известное' })

    const u = await registerUser()
    await request(app).post('/api/onboarding/answers').set(u.auth)
      .send({ topics: [{ kind: 'section', value: 'Science Fiction & Fantasy' }] }).expect(200)
    const feed = (await request(app).get('/api/recommendations').set(u.auth).expect(200)).body
    const [ru] = feed.local
    expect(ru.items[0]).toEqual({ book: expect.objectContaining({ id: picnic.id }), reason: { kind: 'topic', text: 'По вашим темам' } })
    // Оценённая своя книга в ряду больше не показывается
    await request(app).put(`/api/me/ratings/${encodeURIComponent(master.id)}`).set(u.auth).send({ value: 5 }).expect(200)
    const after = (await request(app).get('/api/recommendations').set(u.auth).expect(200)).body
    expect(after.local[0].items.map((i) => i.book.id)).not.toContain(master.id)
  })
})
