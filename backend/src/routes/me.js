// Мои действия и кабинет (2.2, 4.2). Все запросы — только после входа.
import { Router } from 'express'
import { z } from 'zod'
import { Prisma, prisma } from '../db.js'
import { checkPassword, hashPassword, publicUser, readingLanguagesSchema, requireAuth } from '../lib/auth.js'
import { bookColumns, ensureBook, toBook } from '../lib/books.js'
import { HttpError, pageSchema, parse } from '../lib/http.js'
import { SECTION_NAMES, sectionLabel } from '../lib/sections.js'
import { loadProfile } from '../services/recommender.js'
import { emailSchema, nameSchema, passwordSchema } from './auth.js'

export const router = Router()
router.use(requireAuth)

const SHELVES = ['want', 'reading', 'read']
const key = (req) => ({ userId_bookId: { userId: req.user.id, bookId: req.params.bookId } })

// Книга на полке; updatedAt меняется, только если книга переехала на другую полку.
// readAt — дата прочтения: при первом попадании на «Прочитал» — сейчас, при переездах сохраняется,
// переданная явно — заменяет прежнюю. Возвращает итоговый readAt
async function putOnShelf(userId, bookId, shelf, db = prisma, readAt = null) {
  const now = new Date()
  await db.$executeRaw`
    INSERT INTO shelves (user_id, book_id, shelf, created_at, updated_at, read_at)
    VALUES (${userId}, ${bookId}, ${shelf}::shelf_kind, ${now}, ${now}, ${shelf === 'read' ? (readAt ?? now) : null})
    ON CONFLICT (user_id, book_id) DO UPDATE SET
      shelf = EXCLUDED.shelf,
      updated_at = CASE WHEN shelves.shelf <> EXCLUDED.shelf THEN EXCLUDED.updated_at ELSE shelves.updated_at END,
      read_at = CASE WHEN ${readAt}::timestamptz IS NOT NULL THEN ${readAt}::timestamptz
                     WHEN EXCLUDED.shelf = 'read' THEN coalesce(shelves.read_at, EXCLUDED.updated_at)
                     ELSE shelves.read_at END
    WHERE shelves.shelf <> EXCLUDED.shelf OR ${readAt}::timestamptz IS NOT NULL`
  const [row] = await db.$queryRaw`SELECT read_at FROM shelves WHERE user_id = ${userId} AND book_id = ${bookId}`
  return row.read_at
}

// Дата прочтения вручную: «2025-12-31» (день — полдень UTC, чтобы в любом поясе остался тем же днём)
// или полная дата со временем; не раньше 1900 года и не в будущем
const readAtSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })])
  .transform((s) => new Date(s.length === 10 ? `${s}T12:00:00Z` : s))
  .refine((d) => d.getUTCFullYear() >= 1900 && d.getTime() <= Date.now() + 24 * 3600 * 1000, 'Дата прочтения — не раньше 1900 года и не в будущем')

// ——— Оценки ———

const ratingSchema = z.object({ value: z.number().int().min(1).max(5) })

// Оценка ставит книгу на полку «Прочитал» — так же ведёт себя фронтенд (5.2)
router.put('/ratings/:bookId', async (req, res) => {
  const { value } = parse(ratingSchema, req.body)
  await ensureBook(req.params.bookId)
  const readAt = await prisma.$transaction(async (tx) => {
    await tx.rating.upsert({
      where: key(req),
      create: { userId: req.user.id, bookId: req.params.bookId, value },
      update: { value },
    })
    return putOnShelf(req.user.id, req.params.bookId, 'read', tx)
  })
  res.json({ bookId: req.params.bookId, rating: value, shelf: 'read', readAt })
})

router.delete('/ratings/:bookId', async (req, res) => {
  await prisma.rating.deleteMany({ where: { userId: req.user.id, bookId: req.params.bookId } })
  res.status(204).end()
})

// ——— Полки ———

// { shelf, readAt? } — readAt только для «Прочитал»
const shelfSchema = z.object({ shelf: z.enum(SHELVES), readAt: readAtSchema.optional() })
  .refine((b) => !b.readAt || b.shelf === 'read', { path: ['readAt'], message: 'Дату прочтения можно задать только для полки «Прочитал»' })

// → { bookId, shelf, readAt } (readAt — null, если книга ни разу не была прочитана)
router.put('/shelves/:bookId', async (req, res) => {
  const { shelf, readAt } = parse(shelfSchema, req.body)
  await ensureBook(req.params.bookId)
  const saved = await putOnShelf(req.user.id, req.params.bookId, shelf, prisma, readAt)
  res.json({ bookId: req.params.bookId, shelf, readAt: saved })
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

// Сортировка списков кабинета: date — сначала новые (по умолчанию), title — по названию, rating — по моей оценке
const SHELF_ORDER = {
  date: Prisma.sql`s.updated_at DESC`,
  readDate: Prisma.sql`s.read_at DESC NULLS LAST, s.updated_at DESC`, // date на полке «Прочитал»
  title: Prisma.sql`lower(b.title)`,
  rating: Prisma.sql`r.value DESC NULLS LAST, s.updated_at DESC`,
}
const listShelfSchema = z.object({ shelf: z.enum(SHELVES).optional(), sort: z.enum(['date', 'title', 'rating']).default('date'), ...pageSchema })

// { items: [{ book, shelf, rating, addedAt, readAt }], total, counts: { want, reading, read } }
// addedAt — когда книга попала на эту полку, readAt — дата прочтения (null, если не читал).
// На полке «Прочитал» sort=date — по дате прочтения
router.get('/shelves', async (req, res) => {
  const { shelf, sort, limit, offset } = parse(listShelfSchema, req.query)
  const userId = req.user.id
  const where = shelf ? Prisma.sql`AND s.shelf = ${shelf}::shelf_kind` : Prisma.empty
  const order = SHELF_ORDER[sort === 'date' && shelf === 'read' ? 'readDate' : sort]
  const [rows, counts] = await Promise.all([
    prisma.$queryRaw`
      SELECT ${bookColumns('b')}, s.shelf::text AS my_shelf, s.updated_at AS added_at, s.read_at, r.value AS my_rating
      FROM shelves s JOIN books b ON b.id = s.book_id
      LEFT JOIN ratings r ON r.user_id = s.user_id AND r.book_id = s.book_id
      WHERE s.user_id = ${userId} ${where}
      ORDER BY ${order}, s.book_id LIMIT ${limit} OFFSET ${offset}`,
    prisma.shelf.groupBy({ by: ['shelf'], where: { userId }, _count: true }),
  ])
  const byShelf = Object.fromEntries(SHELVES.map((s) => [s, 0]))
  for (const c of counts) byShelf[c.shelf] = c._count
  res.json({
    items: rows.map((r) => ({ book: toBook(r), shelf: r.my_shelf, rating: r.my_rating, addedAt: r.added_at, readAt: r.read_at })),
    total: shelf ? byShelf[shelf] : Object.values(byShelf).reduce((a, b) => a + b, 0),
    counts: byShelf,
  })
})

const RATING_ORDER = { date: Prisma.sql`r.updated_at DESC`, rating: Prisma.sql`r.value DESC, r.updated_at DESC` }
const listRatingsSchema = z.object({ sort: z.enum(['date', 'rating']).default('date'), ...pageSchema })

// { items: [{ book, rating, ratedAt }], total }
router.get('/ratings', async (req, res) => {
  const { sort, limit, offset } = parse(listRatingsSchema, req.query)
  const userId = req.user.id
  const [rows, total] = await Promise.all([
    prisma.$queryRaw`
      SELECT ${bookColumns('b')}, r.value AS my_rating, r.updated_at AS rated_at
      FROM ratings r JOIN books b ON b.id = r.book_id
      WHERE r.user_id = ${userId}
      ORDER BY ${RATING_ORDER[sort]}, r.book_id LIMIT ${limit} OFFSET ${offset}`,
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

// { items: [{ kind, value, label, source, weight }], rejected: [{ kind, value, label }], description }
// Выбранное в онбординге + выведенное из понравившихся книг; weight — сколько понравившихся книг в теме.
// description — последнее «Опишите своими словами» из онбординга (или null)
async function taste(userId) {
  const [profile, topics, lastDescription] = await Promise.all([
    loadProfile(userId),
    prisma.userTopic.findMany({ where: { userId } }),
    prisma.event.findFirst({ where: { userId, type: 'onboarding_description' }, orderBy: { id: 'desc' }, select: { query: true } }),
  ])
  const items = new Map()
  const explicit = new Set()
  const add = (kind, value, source, weight = 0) => {
    if (!value || profile.rejected[kind].has(value)) return
    const k = `${kind}:${value}`
    const item = items.get(k) ?? { kind, value, label: topicLabel(kind, value), source, weight: 0 }
    item.weight += weight
    items.set(k, item)
  }
  for (const t of topics) {
    if (t.rejected) continue
    explicit.add(`${t.kind}:${t.value}`)
    add(t.kind, t.value, t.source)
  }
  for (const b of profile.liked) {
    add('section', b.section, 'profile', 1)
    add('subsection', b.subsection, 'profile', 1)
    add('author', b.author, 'profile', 1)
  }
  // Выведенные пункты с одной книгой — шум, кроме разделов и пунктов, которые пользователь выбрал или вернул сам
  const list = [...items.values()]
    .filter((i) => explicit.has(`${i.kind}:${i.value}`) || i.kind === 'section' || i.weight >= 2)
    .sort((a, b) => (a.source === 'onboarding' ? -1 : 0) - (b.source === 'onboarding' ? -1 : 0) || b.weight - a.weight)
  const rejected = topics.filter((t) => t.rejected).map((t) => ({ kind: t.kind, value: t.value, label: topicLabel(t.kind, t.value) }))
  return { items: list, rejected, description: lastDescription?.query ?? null }
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

// Год и месяц прочтения считаются в часовом поясе пользователя (tz=Asia/Almaty, по умолчанию UTC):
// иначе книга, отмеченная 1 января в 01:00 по Алматы, попала бы в прошлый год.
// Список поясов — из самой базы, чтобы неизвестное имя давало 400, а не ошибку SQL
let timeZones
async function knownTimeZone(tz) {
  timeZones ??= new Set((await prisma.$queryRaw`SELECT name FROM pg_timezone_names`).map((r) => r.name))
  return timeZones.has(tz)
}
const tzSchema = z.string().min(1).max(64).default('UTC')
async function parseTimeZone(tz) {
  if (!(await knownTimeZone(tz))) {
    throw new HttpError(400, 'validation_error', 'Некорректные данные запроса', [{ path: 'tz', message: 'Неизвестный часовой пояс' }])
  }
  return tz
}
// Текущий год в поясе пользователя
const yearNow = (tz) => Number(new Intl.DateTimeFormat('en', { timeZone: tz, year: 'numeric' }).format(new Date()))
const localYear = (column, tz) => Prisma.sql`extract(year FROM ${Prisma.raw(column)} AT TIME ZONE ${tz})::int`

async function readInYear(userId, year, tz) {
  const [{ n }] = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM shelves
    WHERE user_id = ${userId} AND shelf = 'read' AND ${localYear('read_at', tz)} = ${year}`
  return n
}

const OTHER_SECTION = 'Другое'
const statsSchema = z.object({ year: z.coerce.number().int().min(1900).max(2100).optional(), tz: tzSchema })

// Всё, кроме readTotal, — за выбранный год. Дата прочтения — read_at (первое попадание на «Прочитал»
// или заданная вручную), дата оценки — когда её поставили или изменили.
// Книги без раздела онбординга (служебные категории Amazon: «Boxed Sets», «Deals in Books»…) — в «Другое»: section null
// { year, timeZone, years, readTotal, readThisYear, byMonth: [{ month, count }] × 12,
//   bySection: [{ section, label, count, averageRating }], ratings: { count, average, distribution }, goal }
router.get('/stats', async (req, res) => {
  const userId = req.user.id
  const query = parse(statsSchema, req.query)
  const tz = await parseTimeZone(query.tz)
  const year = query.year ?? yearNow(tz)
  const [byMonth, bySection, ratings, readTotal, years, goal] = await Promise.all([
    prisma.$queryRaw`
      SELECT extract(month FROM read_at AT TIME ZONE ${tz})::int AS month, count(*)::int AS count FROM shelves
      WHERE user_id = ${userId} AND shelf = 'read' AND ${localYear('read_at', tz)} = ${year}
      GROUP BY 1 ORDER BY 1`,
    // Любимые разделы: сколько прочитано за год и как я оценил прочитанное в разделе
    prisma.$queryRaw`
      SELECT CASE WHEN b.section IS NOT NULL THEN b.section
                  WHEN b.category = ANY(${Object.keys(SECTION_NAMES)}::text[]) THEN b.category END AS section,
             count(*)::int AS count, round(avg(r.value), 1)::float AS "averageRating"
      FROM shelves s JOIN books b ON b.id = s.book_id
      LEFT JOIN ratings r ON r.user_id = s.user_id AND r.book_id = s.book_id
      WHERE s.user_id = ${userId} AND s.shelf = 'read' AND ${localYear('s.read_at', tz)} = ${year}
      GROUP BY 1 ORDER BY 2 DESC, 3 DESC NULLS LAST`,
    prisma.$queryRaw`
      SELECT value, count(*)::int AS count FROM ratings
      WHERE user_id = ${userId} AND ${localYear('updated_at', tz)} = ${year} GROUP BY 1`,
    prisma.shelf.count({ where: { userId, shelf: 'read' } }),
    // Годы для переключателя: где есть прочитанное, оценки или цель, плюс текущий
    prisma.$queryRaw`
      SELECT ${localYear('read_at', tz)} AS year FROM shelves WHERE user_id = ${userId} AND shelf = 'read'
      UNION SELECT ${localYear('updated_at', tz)} FROM ratings WHERE user_id = ${userId}
      UNION SELECT year FROM reading_goals WHERE user_id = ${userId}`,
    prisma.readingGoal.findUnique({ where: { userId_year: { userId, year } } }),
  ])
  const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, count: 0 }))
  for (const m of byMonth) months[m.month - 1].count = m.count
  const readThisYear = months.reduce((s, m) => s + m.count, 0)
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  for (const r of ratings) distribution[r.value] = r.count
  const ratingsCount = ratings.reduce((s, r) => s + r.count, 0)
  const ratingsSum = ratings.reduce((s, r) => s + r.value * r.count, 0)

  res.json({
    year,
    timeZone: tz,
    years: [...new Set([yearNow(tz), ...years.map((y) => y.year)])].sort((a, b) => b - a),
    readTotal,
    readThisYear,
    byMonth: months,
    // До 10 разделов по числу прочитанного, «Другое» — последним
    bySection: [...bySection.filter((s) => s.section).slice(0, 10), ...bySection.filter((s) => !s.section)].map((s) => ({
      section: s.section, label: s.section ? sectionLabel(s.section) : OTHER_SECTION, count: s.count, averageRating: s.averageRating,
    })),
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
  tz: tzSchema,
})

// { year, target, done } — done считается так же, как readThisYear в статистике
router.put('/goal', async (req, res) => {
  const body = parse(goalSchema, req.body)
  const tz = await parseTimeZone(body.tz)
  const { target, year = yearNow(tz) } = body
  const userId = req.user.id
  await prisma.readingGoal.upsert({
    where: { userId_year: { userId, year } },
    create: { userId, year, target },
    update: { target },
  })
  res.json({ year, target, done: await readInYear(userId, year, tz) })
})

// Убрать цель года (по умолчанию — текущего)
router.delete('/goal', async (req, res) => {
  const query = parse(z.object({ year: z.coerce.number().int().min(2000).max(2100).optional(), tz: tzSchema }), req.query)
  const tz = await parseTimeZone(query.tz)
  await prisma.readingGoal.deleteMany({ where: { userId: req.user.id, year: query.year ?? yearNow(tz) } })
  res.status(204).end()
})

// ——— Профиль и аккаунт (2.2, п. 6) ———

// Смена email или пароля — только с текущим паролем
const profileSchema = z.object({
  name: nameSchema.optional(),
  email: emailSchema.optional(),
  password: passwordSchema.optional(),
  currentPassword: z.string().optional(),
  readingLanguages: readingLanguagesSchema.optional(), // без пароля
})

router.patch('/profile', async (req, res) => {
  const { name, email, password, currentPassword, readingLanguages } = parse(profileSchema, req.body)
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
    data: { name, email, readingLanguages, ...(password && { passwordHash: await hashPassword(password) }) },
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
