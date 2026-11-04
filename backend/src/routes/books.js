// Книги и разделы: GET /books, GET /books/:id, GET /books/:id/similar, GET /sections
import { Router } from 'express'
import { z } from 'zod'
import { Prisma, prisma } from '../db.js'
import { optionalAuth, prefersRussian } from '../lib/auth.js'
import { config } from '../config.js'
import { bookColumns, oneEdition, toBook } from '../lib/books.js'
import { byTaste } from '../lib/embeddings.js'
import { bookNotFound, pageSchema, parse } from '../lib/http.js'
import { getSimilar, loadProfile, reasonFor } from '../services/recommender.js'

export const router = Router()

// Разделы онбординга с числом книг — каталог не меняется, считаем один раз
let sectionsCache
router.get('/sections', async (_req, res) => {
  sectionsCache ??= prisma.$queryRaw`
    SELECT section AS name, count(*)::int AS "booksCount" FROM books
    WHERE section IS NOT NULL GROUP BY section ORDER BY count(*) DESC`
  try {
    res.json(await sectionsCache)
  } catch (err) {
    sectionsCache = undefined
    throw err
  }
})

const listSchema = z.object({
  section: z.string().min(1).optional(),
  sort: z.enum(['popular', 'rating']).default('popular'),
  source: z.enum(['amazon', 'ru', 'kz']).optional(), // свой каталог русских и казахских книг (1.5)
  ...pageSchema,
})

// { items: Book[], total }; sort: popular — по числу оценок, rating — по взвешенному рейтингу (2.4).
// Читающим по-русски — сначала книги, известные по-русски, за ними остальные (2.8).
// Одно издание на название (обычное и Illustrated Edition — одна книга): страница — из префикса списка, дочитываем,
// пока не наберётся offset + limit разных книг. total — все издания
// Свои книги (source ru / kz) оценок не имеют: по известности, а после входа — по близости к вкусу (вектор понравившихся
// книг), когда у книг есть векторы
router.get('/books', optionalAuth, async (req, res) => {
  const { section, sort, source, limit, offset } = parse(listSchema, req.query)
  const conditions = [section && Prisma.sql`b.section = ${section}`, source && Prisma.sql`b.source = ${source}`].filter(Boolean)
  const where = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty
  const own = source === 'ru' || source === 'kz'
  if (own && req.user) {
    const { liked } = await loadProfile(req.user.id)
    const and = Prisma.sql`AND ${Prisma.join(conditions, ' AND ')}`
    const rows = await byTaste(liked.map((b) => b.id), {
      model: config.embeddingModel, where: and, columns: bookColumns('b'), order: Prisma.sql`b.fame DESC, b.id`, limit, offset,
    }).catch(() => null)
    if (rows) {
      const [{ total }] = await prisma.$queryRaw`SELECT count(*)::int AS total FROM books b ${where}`
      return res.json({ items: rows.map((r) => toBook(r)), total })
    }
  }
  const ruFirst = prefersRussian(req.user) ? Prisma.sql`b.ru_known DESC,` : Prisma.empty
  const order = own ? Prisma.sql`b.fame DESC`
    : sort === 'rating' ? Prisma.sql`${ruFirst} b.weighted_rating DESC` : Prisma.sql`${ruFirst} b.ratings_count DESC`
  const want = offset + limit
  const page = async () => {
    for (let batch = want * 2 + 20; ; batch *= 2) {
      const rows = await prisma.$queryRaw`SELECT ${bookColumns('b')} FROM books b ${where} ORDER BY ${order}, b.id LIMIT ${batch}`
      const books = oneEdition(rows.map((r) => toBook(r)))
      if (books.length >= want || rows.length < batch) return books.slice(offset, want)
    }
  }
  const [items, [{ total }]] = await Promise.all([page(), prisma.$queryRaw`SELECT count(*)::int AS total FROM books b ${where}`])
  res.json({ items, total })
})

// Book & { recommendation: Reason | null, my: { rating, shelf, hidden } | null }
router.get('/books/:id', optionalAuth, async (req, res) => {
  const [row] = await prisma.$queryRaw`SELECT ${bookColumns('b', { full: true })} FROM books b WHERE b.id = ${req.params.id}`
  if (!row) throw bookNotFound(req.params.id)
  const book = toBook(row, { full: true })
  if (!req.user) return res.json({ ...book, recommendation: null, my: null })

  const key = { userId_bookId: { userId: req.user.id, bookId: book.id } }
  const [rating, shelf, hidden, profile] = await Promise.all([
    prisma.rating.findUnique({ where: key }),
    prisma.shelf.findUnique({ where: key }),
    prisma.hiddenBook.findUnique({ where: key }),
    loadProfile(req.user.id),
  ])
  // Уже оценённая книга — не рекомендация
  const recommendation = rating ? null : reasonFor(book, profile, { detailed: true })
  res.json({
    ...book,
    recommendation,
    my: { rating: rating?.value ?? null, shelf: shelf?.shelf ?? null, hidden: Boolean(hidden) },
  })
})

const similarSchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(12) })

// Book[]
router.get('/books/:id/similar', optionalAuth, async (req, res) => {
  const { limit } = parse(similarSchema, req.query)
  const items = await getSimilar(req.params.id, { userId: req.user?.id, ru: prefersRussian(req.user), limit })
  if (!items) throw bookNotFound(req.params.id)
  res.json(items)
})
