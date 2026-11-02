// Книга в форме слоя данных фронтенда (frontend/src/api/index.js):
//   Book { id, title, author, year, section, subsection, cover, rating, ratingsCount, annotation }
import { Prisma, prisma } from '../db.js'
import { bookNotFound } from './http.js'

// В списках аннотация обрезается, как в моках фронтенда; на странице книги — целиком
const LIST_ANNOTATION_MAX = 700

// Колонки книги для сырых запросов; alias — имя таблицы в запросе
export const bookColumns = (alias = 'b', { full = false } = {}) => {
  const t = Prisma.raw(alias)
  const annotation = full ? Prisma.sql`${t}.annotation` : Prisma.sql`left(${t}.annotation, ${LIST_ANNOTATION_MAX + 1})`
  return Prisma.sql`${t}.id, ${t}.title, ${t}.author, ${t}.year, ${t}.section, ${t}.category, ${t}.subsection,
    ${t}.cover, ${t}.rating, ${t}.ratings_count, ${annotation} AS annotation`
}

function cutAnnotation(text) {
  if (text.length <= LIST_ANNOTATION_MAX) return text
  return text.slice(0, LIST_ANNOTATION_MAX - 1).replace(/\s+\S*$/, '').trimEnd() + '…'
}

// Строка из сырого запроса (snake_case) или объект Prisma (camelCase) → Book
export function toBook(row, { full = false } = {}) {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    year: row.year,
    // У книг служебных разделов (Textbooks, Boxed Sets…) раздела онбординга нет — показываем раздел Amazon
    section: row.section ?? row.category,
    subsection: row.subsection,
    cover: row.cover,
    rating: row.rating == null ? null : Math.round(row.rating * 10) / 10,
    ratingsCount: row.ratings_count ?? row.ratingsCount,
    annotation: full ? row.annotation : cutAnnotation(row.annotation),
  }
}

export async function ensureBook(id) {
  const book = await prisma.book.findUnique({ where: { id }, select: { id: true } })
  if (!book) throw bookNotFound(id)
}

// Название без серии в скобках и без «: A Novel» — для подписей «Похожа на «…»» (как frontend/src/lib/format.js)
export function shortTitle(title) {
  return title
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/:\s*a novel$/i, '')
    .trim()
}

// Не больше max книг одного автора в выдаче (правило ленты, 3.3)
export function capPerAuthor(books, max = 2) {
  const seen = new Map()
  return books.filter((b) => {
    if (!b.author) return true
    const n = seen.get(b.author) ?? 0
    seen.set(b.author, n + 1)
    return n < max
  })
}
