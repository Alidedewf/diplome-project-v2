import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { BOOKS } from './fixtures.js'
import { app, registerUser } from './helpers.js'

const ids = (feed) => [
  ...feed.forYou.map((r) => r.book.id),
  ...feed.becauseYouLiked.flatMap((g) => g.items.map((r) => r.book.id)),
]
const SCIFI = 'Science Fiction & Fantasy'

describe('лента рекомендаций', () => {
  it('гостю — популярное с объяснением', async () => {
    const res = await request(app).get('/api/recommendations?limit=5').expect(200)
    expect(res.body.forYou).toHaveLength(5)
    expect(res.body.forYou[0].reason).toEqual({ kind: 'popular', text: 'Популярно у читателей' })
    expect(res.body.becauseYouLiked).toEqual([])
  })

  it('скрытая книга не попадает ни в ленту, ни в похожие; после «Вернуть» — снова видна', async () => {
    const u = await registerUser()
    const liked = BOOKS.find((b) => b.subsection === 'Fantasy')
    await request(app).put(`/api/me/ratings/${liked.id}`).set(u.auth).send({ value: 5 }).expect(200)

    const before = await request(app).get('/api/recommendations?limit=20').set(u.auth).expect(200)
    const target = before.body.forYou[0].book.id
    expect(ids(before.body)).toContain(target)

    await request(app).put(`/api/me/hidden/${target}`).set(u.auth).expect(200)
    const after = await request(app).get('/api/recommendations?limit=20').set(u.auth).expect(200)
    expect(ids(after.body)).not.toContain(target)
    const similar = await request(app).get(`/api/books/${liked.id}/similar`).set(u.auth).expect(200)
    expect(similar.body.map((b) => b.id)).not.toContain(target)

    const hidden = await request(app).get('/api/me/hidden').set(u.auth).expect(200)
    expect(hidden.body.items.map((i) => i.book.id)).toEqual([target])

    await request(app).delete(`/api/me/hidden/${target}`).set(u.auth).expect(204)
    const back = await request(app).get('/api/recommendations?limit=20').set(u.auth).expect(200)
    expect(ids(back.body)).toContain(target)
  })

  it('оценённые книги не рекомендуются, «Потому что вам понравилась» — с seedId', async () => {
    const u = await registerUser()
    const liked = BOOKS.find((b) => b.subsection === 'Mystery')
    await request(app).put(`/api/me/ratings/${liked.id}`).set(u.auth).send({ value: 5 }).expect(200)
    const res = await request(app).get('/api/recommendations?limit=20').set(u.auth).expect(200)
    expect(ids(res.body)).not.toContain(liked.id)

    const group = res.body.becauseYouLiked[0]
    expect(group.seed.id).toBe(liked.id)
    expect(group.items.length).toBeGreaterThan(0)
    expect(group.items[0].reason).toEqual({ kind: 'similar', text: `Похожа на «${liked.title}»`, seedId: liked.id })
    // Похожие — сначала из того же подраздела
    expect(group.items[0].book.subsection).toBe('Mystery')
  })

  it('темы онбординга задают ленту; «Это не про меня» убирает тему', async () => {
    const u = await registerUser()
    await request(app).post('/api/onboarding/answers').set(u.auth)
      .send({ topics: [{ kind: 'section', value: SCIFI }], completed: true }).expect(200)
    const feed = await request(app).get('/api/recommendations?limit=5').set(u.auth).expect(200)
    expect(feed.body.forYou.every((r) => r.book.section === SCIFI)).toBe(true)
    expect(feed.body.forYou[0].reason.kind).toBe('topic')

    await request(app).patch('/api/me/taste').set(u.auth).send({ kind: 'section', value: SCIFI, rejected: true }).expect(200)
    const after = await request(app).get('/api/recommendations?limit=5').set(u.auth).expect(200)
    expect(after.body.forYou.every((r) => r.reason.kind === 'popular')).toBe(true)
  })

  it('раунды онбординга не повторяют уже показанные книги', async () => {
    const u = await registerUser()
    await request(app).post('/api/onboarding/answers').set(u.auth).send({ topics: [{ kind: 'section', value: SCIFI }] })
    const r1 = await request(app).get('/api/onboarding/next-round').set(u.auth).expect(200)
    expect(r1.body).toMatchObject({ round: 1, done: false })
    expect(r1.body.items.length).toBeGreaterThan(0)
    // Раунд 1 — разведка: сначала по книге из каждого подраздела
    expect(new Set(r1.body.items.slice(0, 2).map((i) => i.book.subsection)).size).toBe(2)

    const answers = r1.body.items.map((i, k) => ({ bookId: i.book.id, answer: k === 0 ? 'like' : 'unread' }))
    await request(app).post('/api/onboarding/answers').set(u.auth).send({ round: 1, answers }).expect(200)
    const r2 = await request(app).get('/api/onboarding/next-round').set(u.auth).expect(200)
    expect(r2.body.round).toBe(2)
    const shown = new Set(answers.map((a) => a.bookId))
    expect(r2.body.items.some((i) => shown.has(i.book.id))).toBe(false)
  })
})
