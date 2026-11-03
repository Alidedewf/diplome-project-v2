import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { BOOKS } from './fixtures.js'
import { app, registerUser } from './helpers.js'

const SCIFI = 'Science Fiction & Fantasy'
const MYSTERY = 'Mystery, Thriller & Suspense'
const topic = (value) => ({ kind: 'section', value })

const answer = (u, body) => request(app).post('/api/onboarding/answers').set(u.auth).send(body).expect(200)
const nextRound = async (u) => (await request(app).get('/api/onboarding/next-round').set(u.auth).expect(200)).body
const events = (u, type) => prisma.event.findMany({ where: { userId: u.user.id, type }, orderBy: { id: 'asc' } })

describe('онбординг', () => {
  it('описание своими словами сохраняется, новое заменяет прежнее; длиннее 500 символов — 400', async () => {
    const u = await registerUser()
    await answer(u, { topics: [topic(SCIFI)], description: '  люблю космические оперы  ' })
    await answer(u, { description: 'про драконов и магию' })
    const saved = await events(u, 'onboarding_description')
    expect(saved.map((e) => e.query)).toEqual(['про драконов и магию'])

    const res = await request(app).post('/api/onboarding/answers').set(u.auth).send({ description: 'я'.repeat(501) }).expect(400)
    expect(res.body.error.details).toEqual([{ path: 'description', message: 'Не длиннее 500 символов' }])
  })

  it('книга из поиска помечается source: search, раунд не продвигает, но идёт в профиль', async () => {
    const u = await registerUser()
    const found = BOOKS.find((b) => b.subsection === 'Mystery')
    await answer(u, { topics: [topic(SCIFI)], round: 1, answers: [{ bookId: found.id, answer: 'like', source: 'search' }] })

    const [saved] = await events(u, 'onboarding_answer')
    expect(saved.payload).toEqual({ answer: 'like', round: 1, session: 1, source: 'search' })
    expect(await nextRound(u)).toMatchObject({ session: 1, round: 1, done: false })
    const feed = await request(app).get('/api/recommendations').set(u.auth).expect(200)
    expect(feed.body.becauseYouLiked[0].seed.id).toBe(found.id)
  })

  it('«Пропустить» не завершает онбординг: возврат продолжает со следующего раунда (2.3)', async () => {
    const u = await registerUser()
    await answer(u, { topics: [topic(SCIFI)] })
    const r1 = await nextRound(u)
    const [a, b] = r1.items
    const res = await answer(u, { round: 1, answers: [{ bookId: a.book.id, answer: 'like' }, { bookId: b.book.id, answer: 'unread' }] })
    expect(res.body.user.onboardingCompleted).toBe(false)
    expect(await nextRound(u)).toMatchObject({ session: 1, round: 2, done: false })
  })

  it('после завершения онбординг проходится заново: новая сессия с раунда 1 (ONB-14)', async () => {
    const u = await registerUser()
    await answer(u, { topics: [topic(SCIFI)] })
    const r1 = await nextRound(u)
    // 5 «Нравится» — раунды этой сессии закончены
    const answers = r1.items.map((i, k) => ({ bookId: i.book.id, answer: k < 5 ? 'like' : 'dislike' }))
    await answer(u, { round: 1, answers })
    expect(await nextRound(u)).toMatchObject({ session: 1, done: true, items: [] })
    const done = await answer(u, { completed: true })
    expect(done.body.user.onboardingCompleted).toBe(true)

    // Повторный заход: темы заменяются, раунды снова есть, отвеченные книги не повторяются
    await answer(u, { topics: [topic(MYSTERY)] })
    const again = await nextRound(u)
    expect(again).toMatchObject({ session: 2, round: 1, done: false })
    const shown = new Set(answers.map((x) => x.bookId))
    expect(again.items.length).toBeGreaterThan(0)
    expect(again.items.some((i) => shown.has(i.book.id))).toBe(false)
    expect(again.items.every((i) => i.book.section === MYSTERY)).toBe(true)

    // Ответы первой сессии остаются в профиле: лайки — в «Потому что вам понравилась», «Не моё» — не в ленте
    const feed = await request(app).get('/api/recommendations?limit=20').set(u.auth).expect(200)
    const feedIds = feed.body.forYou.map((r) => r.book.id)
    expect(answers.some((x) => feedIds.includes(x.bookId))).toBe(false)
    expect(feed.body.becauseYouLiked.length).toBeGreaterThan(0)

    // Повторный completed: true без новых ответов не открывает лишних сессий; флаг остаётся
    await answer(u, { completed: true })
    expect(await nextRound(u)).toMatchObject({ session: 2, round: 1 })
    const me = await request(app).get('/api/auth/me').set(u.auth).expect(200)
    expect(me.body.user.onboardingCompleted).toBe(true)
  })

  it('completed: false флаг не снимает', async () => {
    const u = await registerUser()
    await answer(u, { completed: true })
    const res = await answer(u, { completed: false })
    expect(res.body.user.onboardingCompleted).toBe(true)
  })
})
