// Мои действия и кабинет (2.2, 4.2). Все запросы — только после входа.
import { Router } from 'express'
import { z } from 'zod'
import { Prisma, prisma } from '../db.js'
import { checkPassword, hashPassword, publicUser, requireAuth } from '../lib/auth.js'
import { bookColumns, ensureBook, toBook } from '../lib/books.js'
import { HttpError, pageSchema, parse } from '../lib/http.js'
import { sectionLabel } from '../lib/sections.js'
import { loadProfile } from '../services/recommender.js'
import { emailSchema, nameSchema, passwordSchema } from './auth.js'

export const router = Router()
router.use(requireAuth)

const SHELVES = ['want', 'reading', 'read']
const key = (req) => ({ userId_bookId: { userId: req.user.id, bookId: req.params.bookId } })

// Книга на полке; updatedAt меняется, только если книга переехала на другую полку
async function putOnShelf(userId, bookId, shelf, db = prisma) {
  const now = new Date()
  await db.$executeRaw`
    INSERT INTO shelves (user_id, book_id, shelf, created_at, updated_at)
    VALUES (${userId}, ${bookId}, ${shelf}::shelf_kind, ${now}, ${now})
    ON CONFLICT (user_id, book_id) DO UPDATE SET shelf = EXCLUDED.shelf, updated_at = EXCLUDED.updated_at
    WHERE shelves.shelf <> EXCLUDED.shelf`
}

// ——— Оценки ———

const ratingSchema = z.object({ value: z.number().int().min(1).max(5) })

// Оценка ставит книгу на полку «Прочитал» — так же ведёт себя фронтенд (5.2)
router.put('/ratings/:bookId', async (req, res) => {
  const { value } = parse(ratingSchema, req.body)
  await ensureBook(req.params.bookId)
  await prisma.$transaction(async (tx) => {
    await tx.rating.upsert({
      where: key(req),
      create: { userId: req.user.id, bookId: req.params.bookId, value },
      update: { value },
    })
    await putOnShelf(req.user.id, req.params.bookId, 'read', tx)
  })
  res.json({ bookId: req.params.bookId, rating: value, shelf: 'read' })
})

router.delete('/ratings/:bookId', async (req, res) => {
  await prisma.rating.deleteMany({ where: { userId: req.user.id, bookId: req.params.bookId } })
  res.status(204).end()
})

// ——— Полки ———

const shelfSchema = z.object({ shelf: z.enum(SHELVES) })

router.put('/shelves/:bookId', async (req, res) => {
  const { shelf } = parse(shelfSchema, req.body)
  await ensureBook(req.params.bookId)
  await putOnShelf(req.user.id, req.params.bookId, shelf)
  res.json({ bookId: req.params.bookId, shelf })
})

router.delete('/shelves/:bookId', async (req, res) => {
  await prisma.shelf.deleteMany({ where: { userId: req.user.id, bookId: req.params.bookId } })
  res.status(204).end()
})

// ——— «Не интересно» ———

router.put('/hidden/:bookId', async (req, res) => {
  await ensureBook(req.params.bookId)
  await prisma.hiddenBook.upsert({
    where: key(req),
    create: { userId: req.user.id, bookId: req.params.bookId },
    update: {},
  })
  res.json({ bookId: req.params.bookId, hidden: true })
})

router.delete('/hidden/:bookId', async (req, res) => {
  await prisma.hiddenBook.deleteMany({ where: { userId: req.user.id, bookId: req.params.bookId } })
  res.status(204).end()
})

// ——— Неявные сигналы ———

// view — просмотр карточки, rec_click — клик по рекомендации (payload: { kind, seedId, place }), search — запрос.
// Поиск через GET /search записывается сервером сам; здесь — то, что видит только фронтенд
const eventSchema = z.object({
  type: z.enum(['view', 'rec_click', 'search']),
  bookId: z.string().min(1).max(16).optional(),
  query: z.string().max(200).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
})
const eventsSchema = z.union([eventSchema.transform((e) => [e]), z.object({ events: z.array(eventSchema).min(1).max(50) }).transform((b) => b.events)])

router.post('/events', async (req, res) => {
  const events = parse(eventsSchema, req.body)
  const ids = [...new Set(events.map((e) => e.bookId).filter(Boolean))]
  const found = await prisma.book.count({ where: { id: { in: ids } } })
  if (found !== ids.length) throw new HttpError(404, 'book_not_found', 'Книга не найдена')
  await prisma.event.createMany({ data: events.map((e) => ({ ...e, userId: req.user.id })) })
  res.status(202).json({ saved: events.length })
})

// ——— Кабинет: списки ———

const listShelfSchema = z.object({ shelf: z.enum(SHELVES).optional(), ...pageSchema })

// { items: [{ book, shelf, rating, addedAt }], total, counts: { want, reading, read } }
router.get('/shelves', async (req, res) => {
  const { shelf, limit, offset } = parse(listShelfSchema, req.query)
  const userId = req.user.id
  const where = shelf ? Prisma.sql`AND s.shelf = ${shelf}::shelf_kind` : Prisma.empty
  const [rows, counts] = await Promise.all([
    prisma.$queryRaw`
      SELECT ${bookColumns('b')}, s.shelf::text AS my_shelf, s.updated_at AS added_at, r.value AS my_rating
      FROM shelves s JOIN books b ON b.id = s.book_id
      LEFT JOIN ratings r ON r.user_id = s.user_id AND r.book_id = s.book_id
      WHERE s.user_id = ${userId} ${where}
      ORDER BY s.updated_at DESC, s.book_id LIMIT ${limit} OFFSET ${offset}`,
    prisma.shelf.groupBy({ by: ['shelf'], where: { userId }, _count: true }),
  ])
  const byShelf = Object.fromEntries(SHELVES.map((s) => [s, 0]))
  for (const c of counts) byShelf[c.shelf] = c._count
  res.json({
    items: rows.map((r) => ({ book: toBook(r), shelf: r.my_shelf, rating: r.my_rating, addedAt: r.added_at })),
    total: shelf ? byShelf[shelf] : Object.values(byShelf).reduce((a, b) => a + b, 0),
    counts: byShelf,
  })
})

// { items: [{ book, rating, ratedAt }], total }
router.get('/ratings', async (req, res) => {
  const { limit, offset } = parse(z.object(pageSchema), req.query)
  const userId = req.user.id
  const [rows, total] = await Promise.all([
    prisma.$queryRaw`
      SELECT ${bookColumns('b')}, r.value AS my_rating, r.updated_at AS rated_at
      FROM ratings r JOIN books b ON b.id = r.book_id
      WHERE r.user_id = ${userId}
      ORDER BY r.updated_at DESC, r.book_id LIMIT ${limit} OFFSET ${offset}`,
    prisma.rating.count({ where: { userId } }),
  ])
  res.json({ items: rows.map((r) => ({ book: toBook(r), rating: r.my_rating, ratedAt: r.rated_at })), total })
})

// { items: [{ book, hiddenAt }], total }
router.get('/hidden', async (req, res) => {
  const { limit, offset } = parse(z.object(pageSchema), req.query)
  const userId = req.user.id
  const [rows, total] = await Promise.all([
    prisma.$queryRaw`
      SELECT ${bookColumns('b')}, h.created_at AS hidden_at
      FROM hidden_books h JOIN books b ON b.id = h.book_id
      WHERE h.user_id = ${userId}
      ORDER BY h.created_at DESC, h.book_id LIMIT ${limit} OFFSET ${offset}`,
    prisma.hiddenBook.count({ where: { userId } }),
  ])
  res.json({ items: rows.map((r) => ({ book: toBook(r), hiddenAt: r.hidden_at })), total })
})

// ——— Профиль вкусов (2.2, п. 3) ———

const topicLabel = (kind, value) => (kind === 'section' ? sectionLabel(value) : value)

// { items: [{ kind, value, label, source, weight }], rejected: [{ kind, value, label }] }
// Выбранное в онбординге + выведенное из понравившихся книг; weight — сколько понравившихся книг в теме
async function taste(userId) {
  const [profile, topics] = await Promise.all([loadProfile(userId), prisma.userTopic.findMany({ where: { userId } })])
  const items = new Map()
  const add = (kind, value, source, weight = 0) => {
    if (!value || profile.rejected[kind].has(value)) return
    const k = `${kind}:${value}`
    const item = items.get(k) ?? { kind, value, label: topicLabel(kind, value), source, weight: 0 }
    item.weight += weight
    items.set(k, item)
  }
  for (const t of topics) if (!t.rejected) add(t.kind, t.value, t.source)
  for (const b of profile.liked) {
    add('section', b.section, 'profile', 1)
    add('subsection', b.subsection, 'profile', 1)
    add('author', b.author, 'profile', 1)
  }
  // Выведенные пункты с одной книгой — шум, кроме разделов
  const list = [...items.values()]
    .filter((i) => i.source === 'onboarding' || i.kind === 'section' || i.weight >= 2)
    .sort((a, b) => (a.source === 'onboarding' ? -1 : 0) - (b.source === 'onboarding' ? -1 : 0) || b.weight - a.weight)
  const rejected = topics.filter((t) => t.rejected).map((t) => ({ kind: t.kind, value: t.value, label: topicLabel(t.kind, t.value) }))
  return { items: list, rejected }
}

router.get('/taste', async (req, res) => {
  res.json(await taste(req.user.id))
})

// «Это не про меня» — { kind, value, rejected: true }; вернуть — rejected: false
const tasteSchema = z.object({
  kind: z.enum(['section', 'subsection', 'author']),
  value: z.string().trim().min(1).max(200),
  rejected: z.boolean(),
})

router.patch('/taste', async (req, res) => {
  const { kind, value, rejected } = parse(tasteSchema, req.body)
  const userId = req.user.id
  await prisma.userTopic.upsert({
    where: { userId_kind_value: { userId, kind, value } },
    create: { userId, kind, value, rejected, source: 'profile' },
    update: { rejected },
  })
  res.json(await taste(userId))
})

// ——— Статистика и цель (2.2, п. 5) ———

const statsSchema = z.object({ year: z.coerce.number().int().min(1900).max(2100).optional() })

// Дата прочтения — когда книга попала на полку «Прочитал»
router.get('/stats', async (req, res) => {
  const userId = req.user.id
  const year = parse(statsSchema, req.query).year ?? new Date().getFullYear()
  const [byMonth, bySection, ratings, readTotal, goal] = await Promise.all([
    prisma.$queryRaw`
      SELECT extract(month FROM updated_at)::int AS month, count(*)::int AS count FROM shelves
      WHERE user_id = ${userId} AND shelf = 'read' AND extract(year FROM updated_at) = ${year}
      GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw`
      SELECT coalesce(b.section, b.category) AS section, count(*)::int AS count
      FROM shelves s JOIN books b ON b.id = s.book_id
      WHERE s.user_id = ${userId} AND s.shelf = 'read' AND coalesce(b.section, b.category) IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
    prisma.rating.groupBy({ by: ['value'], where: { userId }, _count: true }),
    prisma.shelf.count({ where: { userId, shelf: 'read' } }),
    prisma.readingGoal.findUnique({ where: { userId_year: { userId, year } } }),
  ])
  const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, count: 0 }))
  for (const m of byMonth) months[m.month - 1].count = m.count
  const readThisYear = months.reduce((s, m) => s + m.count, 0)
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  for (const r of ratings) distribution[r.value] = r._count
  const ratingsCount = ratings.reduce((s, r) => s + r._count, 0)
  const ratingsSum = ratings.reduce((s, r) => s + r.value * r._count, 0)

  res.json({
    year,
    readTotal,
    readThisYear,
    byMonth: months,
    bySection: bySection.map((s) => ({ ...s, label: sectionLabel(s.section) })),
    ratings: {
      count: ratingsCount,
      average: ratingsCount ? Math.round((ratingsSum / ratingsCount) * 100) / 100 : null,
      distribution,
    },
    goal: goal ? { year, target: goal.target, done: readThisYear } : null,
  })
})

const goalSchema = z.object({
  target: z.number().int().min(1).max(1000),
  year: z.number().int().min(2000).max(2100).optional(),
})

router.put('/goal', async (req, res) => {
  const { target, year = new Date().getFullYear() } = parse(goalSchema, req.body)
  const userId = req.user.id
  await prisma.readingGoal.upsert({
    where: { userId_year: { userId, year } },
    create: { userId, year, target },
    update: { target },
  })
  const done = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM shelves
    WHERE user_id = ${userId} AND shelf = 'read' AND extract(year FROM updated_at) = ${year}`
  res.json({ year, target, done: done[0].n })
})

// ——— Профиль и аккаунт (2.2, п. 6) ———

// Смена email или пароля — только с текущим паролем
const profileSchema = z.object({
  name: nameSchema.optional(),
  email: emailSchema.optional(),
  password: passwordSchema.optional(),
  currentPassword: z.string().optional(),
})

router.patch('/profile', async (req, res) => {
  const { name, email, password, currentPassword } = parse(profileSchema, req.body)
  const user = req.user
  const sensitive = (email && email !== user.email) || password
  if (sensitive && !(currentPassword && (await checkPassword(currentPassword, user.passwordHash)))) {
    throw new HttpError(403, 'wrong_password', 'Неверный текущий пароль')
  }
  if (email && email !== user.email && (await prisma.user.findUnique({ where: { email } }))) {
    throw new HttpError(409, 'email_taken', 'Этот email уже зарегистрирован')
  }
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { name, email, ...(password && { passwordHash: await hashPassword(password) }) },
  })
  res.json({ user: publicUser(updated) })
})

// Удаление аккаунта вместе со всеми данными (каскад по внешним ключам)
router.delete('/', async (req, res) => {
  const { password } = parse(z.object({ password: z.string().min(1) }), req.body ?? {})
  if (!(await checkPassword(password, req.user.passwordHash))) {
    throw new HttpError(403, 'wrong_password', 'Неверный пароль')
  }
  await prisma.user.delete({ where: { id: req.user.id } })
  res.status(204).end()
})
