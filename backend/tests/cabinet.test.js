import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { BOOKS, UNSECTIONED_BOOKS } from './fixtures.js'
import { app, registerUser } from './helpers.js'

const [a, b, c] = BOOKS
const ids = (res) => res.body.items.map((i) => i.book.id)

// Сдвинуть дату полки и оценки — чтобы проверить статистику по годам и месяцам
async function backdate(u, bookId, iso) {
  await prisma.$executeRaw`UPDATE shelves SET updated_at = ${new Date(iso)}, read_at = ${new Date(iso)} WHERE user_id = ${u.user.id} AND book_id = ${bookId}`
  await prisma.$executeRaw`UPDATE ratings SET updated_at = ${new Date(iso)} WHERE user_id = ${u.user.id} AND book_id = ${bookId}`
}

describe('кабинет', () => {
  it('полки и оценки: пагинация и сортировка по дате, названию, оценке', async () => {
    const u = await registerUser()
    await request(app).put(`/api/me/ratings/${b.id}`).set(u.auth).send({ value: 3 }).expect(200)
    await request(app).put(`/api/me/shelves/${c.id}`).set(u.auth).send({ shelf: 'read' }).expect(200)
    await request(app).put(`/api/me/ratings/${a.id}`).set(u.auth).send({ value: 5 }).expect(200)
    await backdate(u, b.id, '2026-01-01T00:00:00Z')
    await backdate(u, c.id, '2026-02-01T00:00:00Z')

    const page1 = await request(app).get('/api/me/shelves?shelf=read&limit=2').set(u.auth).expect(200)
    expect(ids(page1)).toEqual([a.id, c.id])
    expect(page1.body.total).toBe(3)
    const page2 = await request(app).get('/api/me/shelves?shelf=read&limit=2&offset=2').set(u.auth).expect(200)
    expect(ids(page2)).toEqual([b.id])

    const byRating = await request(app).get('/api/me/shelves?sort=rating').set(u.auth).expect(200)
    expect(byRating.body.items.map((i) => i.rating)).toEqual([5, 3, null])
    const byTitle = await request(app).get('/api/me/shelves?sort=title').set(u.auth).expect(200)
    expect(byTitle.body.items.map((i) => i.book.title)).toEqual([a, b, c].map((x) => x.title).sort())

    const ratings = await request(app).get('/api/me/ratings?sort=rating').set(u.auth).expect(200)
    expect(ratings.body.items.map((i) => [i.book.id, i.rating])).toEqual([[a.id, 5], [b.id, 3]])
    await request(app).get('/api/me/shelves?sort=random').set(u.auth).expect(400)
  })

  it('статистика за выбранный год в часовом поясе пользователя', async () => {
    const u = await registerUser()
    await request(app).put(`/api/me/ratings/${a.id}`).set(u.auth).send({ value: 4 }).expect(200)
    await request(app).put(`/api/me/ratings/${b.id}`).set(u.auth).send({ value: 2 }).expect(200)
    // 31 декабря 22:30 UTC — уже 1 января 01:30 по Москве
    await backdate(u, a.id, '2025-12-31T22:30:00Z')
    await backdate(u, b.id, '2025-06-15T12:00:00Z')
    const stats = (query) => request(app).get('/api/me/stats').query(query).set(u.auth).expect(200).then((r) => r.body)

    const utc = await stats({ year: 2025 })
    expect(utc).toMatchObject({ year: 2025, timeZone: 'UTC', readTotal: 2, readThisYear: 2 })
    expect(utc.byMonth[11].count).toBe(1)
    expect(utc.byMonth[5].count).toBe(1)

    const moscow2025 = await stats({ year: 2025, tz: 'Europe/Moscow' })
    expect(moscow2025.readThisYear).toBe(1)
    expect(moscow2025.ratings).toMatchObject({ count: 1, average: 2 })
    const moscow2026 = await stats({ year: 2026, tz: 'Europe/Moscow' })
    expect(moscow2026.byMonth[0].count).toBe(1)
    expect(moscow2026.bySection).toEqual([{ section: a.section, label: 'Фантастика и фэнтези', count: 1, averageRating: 4 }])
    expect(moscow2026.years).toEqual([2026, 2025])

    // В году без чтения — пустые разделы и оценки, а не данные за всё время
    const empty = await stats({ year: 2020 })
    expect(empty).toMatchObject({ readThisYear: 0, bySection: [], ratings: { count: 0, average: null } })

    const bad = await request(app).get('/api/me/stats?tz=Mars/Base').set(u.auth).expect(400)
    expect(bad.body.error.details).toEqual([{ path: 'tz', message: 'Неизвестный часовой пояс' }])
  })

  it('дата прочтения: ставится один раз, переживает переезд между полками, задаётся вручную', async () => {
    const u = await registerUser()
    const shelf = (body) => request(app).put(`/api/me/shelves/${a.id}`).set(u.auth).send(body)
    const first = await shelf({ shelf: 'read' }).expect(200)
    expect(first.body.readAt).toBeTruthy()
    await backdate(u, a.id, '2024-05-10T10:00:00Z')

    // «Читаю» → снова «Прочитал» (и оценка, которая тоже кладёт на «Прочитал») — дата прежняя
    expect((await shelf({ shelf: 'reading' }).expect(200)).body.readAt).toBe('2024-05-10T10:00:00.000Z')
    expect((await shelf({ shelf: 'read' }).expect(200)).body.readAt).toBe('2024-05-10T10:00:00.000Z')
    const rated = await request(app).put(`/api/me/ratings/${a.id}`).set(u.auth).send({ value: 4 }).expect(200)
    expect(rated.body.readAt).toBe('2024-05-10T10:00:00.000Z')

    // Вручную: день → полдень UTC; статистика считает по дате прочтения
    expect((await shelf({ shelf: 'read', readAt: '2023-03-08' }).expect(200)).body.readAt).toBe('2023-03-08T12:00:00.000Z')
    const stats = await request(app).get('/api/me/stats?year=2023').set(u.auth).expect(200)
    expect(stats.body.byMonth[2].count).toBe(1)
    const list = await request(app).get('/api/me/shelves?shelf=read').set(u.auth).expect(200)
    expect(list.body.items[0].readAt).toBe('2023-03-08T12:00:00.000Z')

    const bad = await shelf({ shelf: 'want', readAt: '2023-03-08' }).expect(400)
    expect(bad.body.error.details).toEqual([{ path: 'readAt', message: 'Дату прочтения можно задать только для полки «Прочитал»' }])
    await shelf({ shelf: 'read', readAt: '2999-01-01' }).expect(400)
    await shelf({ shelf: 'read', readAt: 'вчера' }).expect(400)
  })

  it('книги без раздела: категория из словаря — по-русски, служебная — «Другое» в конце', async () => {
    const u = await registerUser()
    const [boxed, romance] = UNSECTIONED_BOOKS
    for (const book of [a, boxed, romance]) {
      await request(app).put(`/api/me/shelves/${book.id}`).set(u.auth).send({ shelf: 'read' }).expect(200)
    }
    const stats = await request(app).get('/api/me/stats').set(u.auth).expect(200)
    const sections = stats.body.bySection
    expect(sections.slice(0, 2).map((s) => [s.section, s.label])).toEqual(expect.arrayContaining([
      [a.section, 'Фантастика и фэнтези'], ['Romance', 'Любовные романы'],
    ]))
    expect(sections).toHaveLength(3)
    expect(sections[2]).toEqual({ section: null, label: 'Другое', count: 1, averageRating: null })
  })

  it('профиль вкусов отдаёт последнее описание своими словами', async () => {
    const u = await registerUser()
    expect((await request(app).get('/api/me/taste').set(u.auth).expect(200)).body.description).toBeNull()
    await request(app).post('/api/onboarding/answers').set(u.auth).send({ description: 'люблю космос' }).expect(200)
    await request(app).post('/api/onboarding/answers').set(u.auth).send({ description: 'теперь — детективы' }).expect(200)
    expect((await request(app).get('/api/me/taste').set(u.auth).expect(200)).body.description).toBe('теперь — детективы')
  })

  it('цель года: прогресс в часовом поясе, удаление цели', async () => {
    const u = await registerUser()
    await request(app).put(`/api/me/shelves/${a.id}`).set(u.auth).send({ shelf: 'read' }).expect(200)
    await backdate(u, a.id, '2025-12-31T22:30:00Z')
    const goal = await request(app).put('/api/me/goal').set(u.auth).send({ target: 10, year: 2026, tz: 'Europe/Moscow' }).expect(200)
    expect(goal.body).toEqual({ year: 2026, target: 10, done: 1 })

    await request(app).delete('/api/me/goal?year=2026').set(u.auth).expect(204)
    const stats = await request(app).get('/api/me/stats?year=2026').set(u.auth).expect(200)
    expect(stats.body.goal).toBeNull()
  })

  it('пункт профиля вкусов, возвращённый после «Это не про меня», снова виден', async () => {
    const u = await registerUser()
    await request(app).put(`/api/me/ratings/${a.id}`).set(u.auth).send({ value: 5 }).expect(200)
    const author = { kind: 'author', value: a.author }
    const rejected = await request(app).patch('/api/me/taste').set(u.auth).send({ ...author, rejected: true }).expect(200)
    expect(rejected.body.rejected).toEqual([{ ...author, label: a.author }])
    const back = await request(app).patch('/api/me/taste').set(u.auth).send({ ...author, rejected: false }).expect(200)
    expect(back.body.rejected).toEqual([])
    expect(back.body.items).toContainEqual(expect.objectContaining(author))
  })
})
