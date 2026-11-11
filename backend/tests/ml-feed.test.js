// «Для вас» из ML-сервиса (решения.md 3.8, 4.11) и «Похожие» по соседям ItemKNN. ML-сервис — мок fetch
import request from 'supertest'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../src/db.js'
import { resetMl } from '../src/services/ml.js'
import { AUTHOR_BOOKS, BOOKS } from './fixtures.js'
import { app, registerUser } from './helpers.js'

const book = (title) => BOOKS.find((b) => b.title === title)
const MODEL = 'e3-test'

let fetchSpy
let answer // (body) => Response | Error
let requests
beforeEach(() => {
  resetMl()
  requests = []
  answer = () => Response.json({ modelVersion: MODEL, items: [] })
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (!String(url).endsWith('/recommend')) throw new TypeError('fetch failed')
    const body = JSON.parse(init.body)
    requests.push(body)
    const out = answer(body)
    if (out instanceof Error) throw out
    return out
  })
})
afterEach(() => fetchSpy.mockRestore())

const items = (list) => Response.json({
  modelVersion: MODEL,
  items: list.map(([id, reasons = []], i) => ({ bookId: id, score: 10 - i, reasons })),
})
const feed = (u, limit = 6) => request(app).get(`/api/recommendations?limit=${limit}`).set(u.auth).expect(200).then((r) => r.body)

describe('«Для вас» из ML-сервиса', () => {
  it('события и исключения в запросе; порядок сервиса; подписи с книгой-зерном', async () => {
    const u = await registerUser()
    const [rated, liked, wanted, hidden, disliked] = ['Mystery Book 1', 'Fantasy Book 1', 'Fantasy Book 2', 'Mystery Book 5', 'Fantasy Book 5'].map(book)
    await request(app).put(`/api/me/ratings/${rated.id}`).set(u.auth).send({ value: 4 }).expect(200)
    await request(app).post('/api/onboarding/answers').set(u.auth)
      .send({ answers: [{ bookId: liked.id, answer: 'like' }, { bookId: disliked.id, answer: 'dislike' }] }).expect(200)
    await request(app).put(`/api/me/shelves/${wanted.id}`).set(u.auth).send({ shelf: 'want' }).expect(200)
    await request(app).put(`/api/me/hidden/${hidden.id}`).set(u.auth).expect(200)

    const [a, b, c] = ['Science Fiction Book 1', 'Science Fiction Book 2', 'Thrillers & Suspense Book 1'].map(book)
    answer = () => items([
      [a.id, [{ type: 'similar', bookId: liked.id }]],
      [b.id, [{ type: 'author', bookId: rated.id }]],
      [c.id, []],
      [hidden.id, [{ type: 'trending', section: 'Mystery, Thriller & Suspense' }]], // скрытая — бэкенд уберёт
    ])
    const res = await feed(u)

    const [body] = requests
    expect(body.n).toBe(100)
    const kinds = Object.fromEntries(body.events.map((e) => [e.bookId, [e.kind, e.value]]))
    expect(kinds).toEqual({
      [rated.id]: ['rating', 4], [liked.id]: ['like', undefined], [wanted.id]: ['want', undefined], [disliked.id]: ['dislike', undefined],
    })
    expect(body.events.every((e) => !Number.isNaN(Date.parse(e.at)))).toBe(true)
    expect(body.exclude).toEqual(expect.arrayContaining([hidden.id, rated.id, liked.id, wanted.id, disliked.id]))

    expect(res.forYouSource).toBe('ml')
    expect(res.modelVersion).toBe(MODEL)
    expect(res.forYou.slice(0, 3).map((r) => r.book.id)).toEqual([a.id, b.id, c.id])
    expect(res.forYou.map((r) => r.book.id)).not.toContain(hidden.id)
    const seedOf = (x) => ({ id: x.id, title: x.title, titleRu: null, author: x.author, authorRu: null })
    expect(res.forYou[0].reason).toEqual({ kind: 'similar', seed: seedOf(liked), seedId: liked.id })
    expect(res.forYou[1].reason).toEqual({ kind: 'same_author', seed: seedOf(rated), seedId: rated.id })
    expect(res.forYou[2].reason).toBeNull()
    // Мало книг от сервиса — добор лентой на правилах
    expect(res.forYou).toHaveLength(6)
  })

  it('не больше 2 книг одного автора', async () => {
    const u = await registerUser()
    await request(app).put(`/api/me/ratings/${book('Mystery Book 1').id}`).set(u.auth).send({ value: 5 }).expect(200)
    answer = () => items(AUTHOR_BOOKS.filter((b) => b.author === 'Mara Quill').map((b) => [b.id]))
    const res = await feed(u)
    expect(res.forYouSource).toBe('ml')
    expect(res.forYou.filter((r) => r.book.author === 'Mara Quill')).toHaveLength(2)
  })

  it('сервис недоступен — лента на правилах, следующие запросы его не ждут', async () => {
    const u = await registerUser()
    await request(app).put(`/api/me/ratings/${book('Mystery Book 1').id}`).set(u.auth).send({ value: 5 }).expect(200)
    answer = () => new TypeError('fetch failed')
    const first = await feed(u)
    expect(first.forYouSource).toBe('rules')
    expect(first.forYou).toHaveLength(6)
    await feed(u)
    expect(fetchSpy).toHaveBeenCalledTimes(1) // пауза после сбоя
  })

  it('нет истории (до онбординга) — сервис не спрашиваем; 204 — правила', async () => {
    const u = await registerUser()
    expect((await feed(u)).forYouSource).toBe('rules')
    expect(fetchSpy).not.toHaveBeenCalled()

    await request(app).put(`/api/me/ratings/${book('Mystery Book 1').id}`).set(u.auth).send({ value: 5 }).expect(200)
    answer = () => new Response(null, { status: 204 })
    expect((await feed(u)).forYouSource).toBe('rules')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('одна и та же история — ответ из кэша; новое действие — новый запрос', async () => {
    const u = await registerUser()
    await request(app).put(`/api/me/ratings/${book('Mystery Book 1').id}`).set(u.auth).send({ value: 5 }).expect(200)
    answer = () => items([[book('Fantasy Book 3').id]])
    await feed(u)
    await feed(u)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await request(app).put(`/api/me/ratings/${book('Mystery Book 2').id}`).set(u.auth).send({ value: 3 }).expect(200)
    await feed(u)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

describe('«Похожие» по соседям ItemKNN', () => {
  const seed = book('Science Fiction Book 1') // 1000 оценок
  const rare = AUTHOR_BOOKS.find((b) => b.ratingsCount < 30) // 20 оценок — соседям не верим
  const neighbours = ['Mystery Book 3', 'Thrillers & Suspense Book 4', 'Fantasy Book 2', 'Mystery Book 1', 'Thrillers & Suspense Book 2', 'Fantasy Book 5']
    .map((t) => book(t).id)
  const rows = (bookId) => neighbours.map((neighborId, i) => ({ bookId, rank: i + 1, neighborId, score: 100 - i }))

  beforeEach(async () => {
    await prisma.itemNeighbor.deleteMany()
    await prisma.itemNeighbor.createMany({ data: [...rows(seed.id), ...rows(rare.id)] })
  })
  afterAll(() => prisma.itemNeighbor.deleteMany())

  it('сначала соседи ItemKNN по порядку, затем добор', async () => {
    const res = await request(app).get(`/api/books/${seed.id}/similar`).expect(200)
    expect(res.body.slice(0, neighbours.length).map((b) => b.id)).toEqual(neighbours)
    expect(res.body.length).toBeGreaterThan(neighbours.length)
  })

  it('скрытый сосед не показывается; соседей меньше 5 — не используем', async () => {
    const u = await registerUser()
    await request(app).put(`/api/me/hidden/${neighbours[0]}`).set(u.auth).expect(200)
    const res = await request(app).get(`/api/books/${seed.id}/similar`).set(u.auth).expect(200)
    expect(res.body[0].id).toBe(neighbours[1])

    await prisma.itemNeighbor.deleteMany({ where: { bookId: seed.id, rank: { gt: 4 } } })
    const few = await request(app).get(`/api/books/${seed.id}/similar`).expect(200)
    expect(few.body[0].subsection).toBe(seed.subsection) // старое правило: тот же подраздел
  })

  it('у книги мало оценок — соседи ItemKNN не используются', async () => {
    const res = await request(app).get(`/api/books/${rare.id}/similar`).expect(200)
    expect(res.body.map((b) => b.id)).not.toContain(neighbours[0])
    expect(res.body[0].subsection).toBe(rare.subsection)
  })
})
