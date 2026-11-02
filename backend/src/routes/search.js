// Обычный поиск (2.5, уровень 1): название, автор, ISBN; автодополнение; запасной поиск с опечатками.
// Смысловая часть гибридного поиска появится вместе с ML-сервисом и эмбеддингами.
import { Router } from 'express'
import { z } from 'zod'
import { Prisma, prisma } from '../db.js'
import { optionalAuth } from '../lib/auth.js'
import { bookColumns, toBook } from '../lib/books.js'
import { pageSchema, parse } from '../lib/http.js'

export const router = Router()

// Меньше стольких точных совпадений — подмешиваем похожие по написанию
const FUZZY_BELOW = 5

// year: «2015» или диапазон «2010-2015»
const yearSchema = z.string().regex(/^\d{4}(-\d{4})?$/, 'Год: 2015 или 2010-2015').transform((s) => {
  const [from, to = from] = s.split('-').map(Number)
  return { from, to }
})

const searchSchema = z.object({
  q: z.string().trim().min(1, 'Пустой запрос').max(200),
  section: z.string().min(1).optional(),
  year: yearSchema.optional(),
  rating: z.coerce.number().min(1).max(5).optional(), // минимальная средняя оценка
  hideRead: z.enum(['1', 'true', '0', 'false']).transform((v) => v === '1' || v === 'true').optional(),
  ...pageSchema,
})

// ISBN-10 → ISBN-13 (в базе хранится 13-значный)
function isbn13(raw) {
  const s = raw.replace(/[-\s]/g, '').toUpperCase()
  if (/^\d{13}$/.test(s)) return s
  if (!/^\d{9}[\dX]$/.test(s)) return null
  const core = '978' + s.slice(0, 9)
  const sum = [...core].reduce((acc, d, i) => acc + Number(d) * (i % 2 ? 3 : 1), 0)
  return core + ((10 - (sum % 10)) % 10)
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c)

// Префиксный tsquery для автодополнения: «atomic hab» → atomic:* & hab:*
function prefixTsQuery(q) {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return words.length ? words.map((w) => `${w}:*`).join(' & ') : null
}

function filters({ section, year, rating, hideRead }, user) {
  const parts = []
  if (section) parts.push(Prisma.sql`b.section = ${section}`)
  if (year) parts.push(Prisma.sql`b.year BETWEEN ${year.from} AND ${year.to}`)
  if (rating) parts.push(Prisma.sql`b.rating >= ${rating}`)
  if (hideRead && user) {
    parts.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM shelves s WHERE s.user_id = ${user.id} AND s.book_id = b.id AND s.shelf = 'read')`)
  }
  return parts.length ? Prisma.sql`AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty
}

// GET /search?q=&section=&year=&rating=&hideRead= → { items: Book[], total, fuzzy }
// fuzzy: true — точных совпадений мало, к ним добавлены похожие написания (исправление опечаток)
router.get('/search', optionalAuth, async (req, res) => {
  const params = parse(searchSchema, req.query)
  const { q, limit, offset } = params
  const extra = filters(params, req.user)
  const like = `%${escapeLike(q)}%`
  const isbn = isbn13(q)

  // Совпадение по словам (стемминг), по подстроке названия/автора, по ISBN или ASIN.
  // Порядок: точное название → начало названия → релевантность → популярность
  const match = Prisma.sql`(
    b.search_vector @@ websearch_to_tsquery('english', ${q})
    OR b.title ILIKE ${like} OR b.author ILIKE ${like}
    ${isbn ? Prisma.sql`OR b.isbn13 = ${isbn}` : Prisma.empty}
    OR b.id = ${q.toUpperCase()})`
  const score = Prisma.sql`(
    3 * (lower(b.title) = lower(${q}))::int
    + 2 * (b.title ILIKE ${escapeLike(q) + '%'})::int
    + 5 * (${isbn ? Prisma.sql`coalesce(b.isbn13 = ${isbn}, false) OR` : Prisma.empty} b.id = ${q.toUpperCase()})::int
    + ts_rank(b.search_vector, websearch_to_tsquery('english', ${q}))
    + word_similarity(${q}, b.title) + 0.5 * word_similarity(${q}, coalesce(b.author, ''))
    + 0.1 * ln(1 + b.ratings_count))`

  const [{ total: exact }] = await prisma.$queryRaw`SELECT count(*)::int AS total FROM books b WHERE ${match} ${extra}`

  // Точных совпадений мало — добавляем похожие по написанию (опечатки; триграммы, индекс gin_trgm_ops).
  // Порог word_similarity снижен с 0,6 до 0,45: «gillain flyn» → «Gillian Flynn» — 0,47
  const fuzzy = exact < FUZZY_BELOW && q.length >= 3 && !isbn
  const where = fuzzy ? Prisma.sql`(${match} OR ${q} <% b.title OR ${q} <% b.author)` : match
  const order = fuzzy
    ? Prisma.sql`${score} + 2 * greatest(word_similarity(${q}, b.title), word_similarity(${q}, coalesce(b.author, '')))`
    : score
  const [rows, [{ total }]] = await prisma.$transaction(async (tx) => {
    if (fuzzy) await tx.$executeRaw`SET LOCAL pg_trgm.word_similarity_threshold = 0.45`
    const found = await tx.$queryRaw`SELECT ${bookColumns('b')} FROM books b WHERE ${where} ${extra}
      ORDER BY ${order} DESC, b.id LIMIT ${limit} OFFSET ${offset}`
    const count = fuzzy ? await tx.$queryRaw`SELECT count(*)::int AS total FROM books b WHERE ${where} ${extra}` : [{ total: exact }]
    return [found, count]
  })

  // Поисковый запрос — неявный сигнал для рекомендаций (2.5); пишем только первую страницу
  if (req.user && offset === 0) {
    await prisma.event.create({ data: { userId: req.user.id, type: 'search', query: q, payload: { total, fuzzy } } })
  }

  res.json({ items: rows.map((r) => toBook(r)), total, fuzzy })
})

const suggestSchema = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(20).default(8),
})

// GET /search/suggest?q= → [{ id, title, author, year, cover }] — автодополнение при вводе
router.get('/search/suggest', async (req, res) => {
  const { q, limit } = parse(suggestSchema, req.query)
  const tsq = prefixTsQuery(q)
  const rows = await prisma.$queryRaw`
    SELECT b.id, b.title, b.author, b.year, b.cover FROM books b
    WHERE b.title ILIKE ${escapeLike(q) + '%'}
      ${tsq ? Prisma.sql`OR b.search_vector @@ to_tsquery('english', ${tsq})` : Prisma.empty}
    ORDER BY (b.title ILIKE ${escapeLike(q) + '%'}) DESC, b.ratings_count DESC
    LIMIT ${limit}`
  res.json(rows)
})
