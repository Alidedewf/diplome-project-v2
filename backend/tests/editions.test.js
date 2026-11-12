import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { editionKey } from '../src/lib/books.js'
import { app, registerUser } from './helpers.js'

// Детский раздел: два издания одной книги, подростковая книга (10+) и книга для малышей (картонная).
// Оценок мало (но не меньше порога ленты «Для вас» — 20) — в популярное для гостя и чужие тесты не попадают
const CHILDREN = "Children's Books"
const base = { section: CHILDREN, category: CHILDREN, subsection: 'Growing Up & Facts of Life', year: 2015, rating: 4.5, weightedRating: 4.4, cover: 'https://example.com/c.jpg' }
const BOOKS = [
  { id: 'K000000001', title: 'Moon Tale', author: 'Ivy Lark', ratingsCount: 29 },
  { id: 'K000000002', title: 'Moon Tale: The Illustrated Edition', author: 'Ivy Lark', ratingsCount: 28 },
  { id: 'K000000003', title: 'Arena Games', author: 'Teen Writer', ratingsCount: 27, readingAgeMin: 10 },
  { id: 'K000000004', title: 'Tiny Bear Says Goodnight', author: 'Toddler Writer', ratingsCount: 26, format: 'Board book' },
  { id: 'K000000005', title: 'Pond Friends', author: 'Picture Writer', ratingsCount: 25, readingAgeMin: 2, readingAgeMax: 5 },
].map((b) => ({ ...base, ...b }))
const [moon, moonIllustrated, arena, tinyBear, pond] = BOOKS

// Серия: четыре книги, второе издание первой, подарочный набор и неофициальный путеводитель другого автора
const TEEN = { ...base, section: 'Teen & Young Adult', category: 'Teen & Young Adult', subsection: 'Literature & Fiction' }
const SERIES = [
  { id: 'S000000001', title: 'Moon Saga and the First Door (Moon Saga Book 1)', year: 2001, ratingsCount: 60 },
  { id: 'S000000002', title: 'Moon Saga and the Second Door', year: 2002, ratingsCount: 50 },
  { id: 'S000000003', title: 'Moon Saga and the Third Door (Moon Saga Book 3)', year: 2003, ratingsCount: 45 },
  { id: 'S000000004', title: 'Moon Saga and the Fourth Door (Moon Saga Book 4)', year: 2004, ratingsCount: 40 },
  { id: 'S000000005', title: 'Moon Saga and the First Door: The Illustrated Edition', year: 2015, ratingsCount: 30 },
  { id: 'S000000006', title: 'Moon Saga Box Set (Books 1-4)', year: 2010, ratingsCount: 35 },
  { id: 'S000000007', title: 'The Unofficial Moon Saga Guide', year: 2012, ratingsCount: 55, author: 'Fan Writer' },
].map((b) => ({ ...TEEN, author: 'Saga Author', ...b }))
BOOKS.push(...SERIES)

beforeAll(async () => {
  await prisma.book.createMany({ data: BOOKS })
})
afterAll(async () => {
  await prisma.book.deleteMany({ where: { id: { in: BOOKS.map((b) => b.id) } } })
})

describe('одно издание на название', () => {
  it('в популярном раздела — самое популярное издание, страницы без повторов', async () => {
    const list = async (q) => (await request(app).get('/api/books').query({ section: CHILDREN, ...q }).expect(200)).body
    const all = await list({})
    expect(all.items.map((b) => b.id)).toEqual([moon.id, arena.id, tinyBear.id, pond.id])
    const first = await list({ limit: 2 })
    const second = await list({ limit: 2, offset: 2 })
    expect([...first.items, ...second.items].map((b) => b.id)).toEqual(all.items.map((b) => b.id))
    expect(all.items.map((b) => b.id)).not.toContain(moonIllustrated.id)
  })
})

describe('хвосты изданий', () => {
  it("«…, Collector's Edition», «… (New Edition)», «… Boxed Set» — одно название", () => {
    const key = editionKey('The Tales of Beedle the Bard')
    expect(editionKey("The Tales of Beedle the Bard, Collector's Edition")).toBe(key)
    expect(editionKey('The Tales of Beedle the Bard (New Edition)')).toBe(key)
    expect(editionKey('Dune 40th Anniversary Edition')).toBe(editionKey('Dune'))
    expect(editionKey('Moon Saga Paperback Boxed Set')).toBe(editionKey('Moon Saga'))
    expect(editionKey('Special Edition')).toBe('special edition') // одни служебные слова — название не трогаем
  })
})

describe('книги для малышей во взрослой ленте', () => {
  const feedIds = async (u) => (await request(app).get('/api/recommendations?limit=30').set(u.auth).expect(200)).body
    .forYou.map((r) => r.book.id)

  it('понравилась подростковая книга из детского раздела — малышовых нет, остальное из раздела есть', async () => {
    const u = await registerUser()
    await request(app).put(`/api/me/ratings/${arena.id}`).set(u.auth).send({ value: 5 }).expect(200)
    const ids = await feedIds(u)
    expect(ids).toContain(moon.id)
    expect(ids).not.toContain(tinyBear.id)
    expect(ids).not.toContain(pond.id)
  })

  it('сам выбрал детский раздел или понравилась книга для малышей — показываем', async () => {
    const chose = await registerUser()
    await request(app).post('/api/onboarding/answers').set(chose.auth).send({ topics: [{ kind: 'section', value: CHILDREN }] }).expect(200)
    expect(await feedIds(chose)).toEqual(expect.arrayContaining([tinyBear.id, pond.id]))

    const liked = await registerUser()
    await request(app).put(`/api/me/ratings/${pond.id}`).set(liked.auth).send({ value: 5 }).expect(200)
    expect(await feedIds(liked)).toContain(tinyBear.id)
  })
})

describe('другие книги серии', () => {
  it('понравились две книги серии — ряд с остальными: одно издание, по порядку, без наборов и чужих путеводителей', async () => {
    const u = await registerUser()
    for (const b of [SERIES[2], SERIES[3]]) {
      await request(app).put(`/api/me/ratings/${b.id}`).set(u.auth).send({ value: 5 }).expect(200)
    }
    const feed = (await request(app).get('/api/recommendations?limit=30').set(u.auth).expect(200)).body
    expect(feed.series).toHaveLength(1)
    const [row] = feed.series
    expect(row.name).toBe('Moon Saga')
    expect(row.seeds.map((b) => b.id).sort()).toEqual([SERIES[2].id, SERIES[3].id])
    expect(row.items.map((i) => i.book.id)).toEqual([SERIES[0].id, SERIES[1].id])
    expect(row.items[0].reason).toEqual({ kind: 'series', text: 'Из серии «Moon Saga»' })
    // Книги ряда серии в «Для вас» не повторяются
    const forYou = feed.forYou.map((r) => r.book.id)
    expect(forYou).not.toContain(SERIES[0].id)
    expect(forYou).not.toContain(SERIES[1].id)
  })

  it('одна понравившаяся книга серии — ряда нет; гостю — пустой список', async () => {
    const u = await registerUser()
    await request(app).put(`/api/me/ratings/${SERIES[2].id}`).set(u.auth).send({ value: 5 }).expect(200)
    expect((await request(app).get('/api/recommendations').set(u.auth).expect(200)).body.series).toEqual([])
    expect((await request(app).get('/api/recommendations').expect(200)).body.series).toEqual([])
  })
})

