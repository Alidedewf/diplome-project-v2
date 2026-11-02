// Книги и разделы: GET /books, GET /books/:id, GET /books/:id/similar, GET /sections
import { Router } from 'express'
import { z } from 'zod'
import { Prisma, prisma } from '../db.js'
import { optionalAuth } from '../lib/auth.js'
import { bookColumns, toBook } from '../lib/books.js'
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
  ...pageSchema,
})

// { items: Book[], total }; sort: popular — по числу оценок, rating — по взвешенному рейтингу (2.4)
router.get('/books', async (req, res) => {
  const { section, sort, limit, offset } = parse(listSchema, req.query)
  const where = section ? Prisma.sql`WHERE b.section = ${section}` : Prisma.empty
  const order = sort === 'rating' ? Prisma.sql`b.weighted_rating DESC` : Prisma.sql`b.ratings_count DESC`
  const [rows, [{ total }]] = await Promise.all([
    prisma.$queryRaw`SELECT ${bookColumns('b')} FROM books b ${where} ORDER BY ${order}, b.id LIMIT ${limit} OFFSET ${offset}`,
    prisma.$queryRaw`SELECT count(*)::int AS total FROM books b ${where}`,
  ])
  res.json({ items: rows.map((r) => toBook(r)), total })
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
  const items = await getSimilar(req.params.id, { userId: req.user?.id, limit })
  if (!items) throw bookNotFound(req.params.id)
  res.json(items)
})
