import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { BOOKS } from './fixtures.js'
import { app, registerUser } from './helpers.js'

const [book, other] = BOOKS

describe('оценки и полки', () => {
  it('оценка ставит книгу на полку «Прочитал», меняется и удаляется', async () => {
    const u = await registerUser()
    const put = await request(app).put(`/api/me/ratings/${book.id}`).set(u.auth).send({ value: 4 }).expect(200)
    expect(put.body).toEqual({ bookId: book.id, rating: 4, shelf: 'read' })
    await request(app).put(`/api/me/ratings/${book.id}`).set(u.auth).send({ value: 5 }).expect(200)

    const card = await request(app).get(`/api/books/${book.id}`).set(u.auth).expect(200)
    expect(card.body.my).toEqual({ rating: 5, shelf: 'read', hidden: false })

    const ratings = await request(app).get('/api/me/ratings').set(u.auth).expect(200)
    expect(ratings.body.total).toBe(1)
    expect(ratings.body.items[0]).toMatchObject({ rating: 5, book: { id: book.id } })

    await request(app).delete(`/api/me/ratings/${book.id}`).set(u.auth).expect(204)
    const after = await request(app).get(`/api/books/${book.id}`).set(u.auth).expect(200)
    expect(after.body.my).toEqual({ rating: null, shelf: 'read', hidden: false })
  })

  it('оценка вне 1–5 и несуществующая книга отклоняются', async () => {
    const u = await registerUser()
    await request(app).put(`/api/me/ratings/${book.id}`).set(u.auth).send({ value: 6 }).expect(400)
    await request(app).put(`/api/me/ratings/${book.id}`).set(u.auth).send({ value: 3.5 }).expect(400)
    await request(app).put('/api/me/ratings/NOPE').set(u.auth).send({ value: 3 }).expect(404)
  })

  it('книга стоит на одной полке; списки полок со счётчиками', async () => {
    const u = await registerUser()
    await request(app).put(`/api/me/shelves/${book.id}`).set(u.auth).send({ shelf: 'want' }).expect(200)
    await request(app).put(`/api/me/shelves/${book.id}`).set(u.auth).send({ shelf: 'reading' }).expect(200)
    await request(app).put(`/api/me/shelves/${other.id}`).set(u.auth).send({ shelf: 'want' }).expect(200)
    await request(app).put(`/api/me/shelves/${other.id}`).set(u.auth).send({ shelf: 'shelf-of-mine' }).expect(400)

    const all = await request(app).get('/api/me/shelves').set(u.auth).expect(200)
    expect(all.body.counts).toEqual({ want: 1, reading: 1, read: 0 })
    expect(all.body.total).toBe(2)

    const reading = await request(app).get('/api/me/shelves?shelf=reading').set(u.auth).expect(200)
    expect(reading.body.items.map((i) => [i.book.id, i.shelf])).toEqual([[book.id, 'reading']])

    await request(app).delete(`/api/me/shelves/${book.id}`).set(u.auth).expect(204)
    const left = await request(app).get('/api/me/shelves').set(u.auth).expect(200)
    expect(left.body.counts).toEqual({ want: 1, reading: 0, read: 0 })
  })

  it('статистика и цель на год считают прочитанное', async () => {
    const u = await registerUser()
    await request(app).put(`/api/me/ratings/${book.id}`).set(u.auth).send({ value: 5 }).expect(200)
    await request(app).put(`/api/me/shelves/${other.id}`).set(u.auth).send({ shelf: 'read' }).expect(200)
    const goal = await request(app).put('/api/me/goal').set(u.auth).send({ target: 12 }).expect(200)
    expect(goal.body).toMatchObject({ target: 12, done: 2 })

    const stats = await request(app).get('/api/me/stats').set(u.auth).expect(200)
    expect(stats.body).toMatchObject({ readTotal: 2, readThisYear: 2, goal: { target: 12, done: 2 } })
    expect(stats.body.ratings).toMatchObject({ count: 1, average: 5 })
    expect(stats.body.byMonth).toHaveLength(12)
  })

  it('события сохраняются, неизвестный тип отклоняется', async () => {
    const u = await registerUser()
    const res = await request(app).post('/api/me/events').set(u.auth)
      .send({ events: [{ type: 'view', bookId: book.id }, { type: 'rec_click', bookId: other.id, payload: { place: 'forYou' } }] })
      .expect(202)
    expect(res.body.saved).toBe(2)
    await request(app).post('/api/me/events').set(u.auth).send({ type: 'hack' }).expect(400)
  })
})
