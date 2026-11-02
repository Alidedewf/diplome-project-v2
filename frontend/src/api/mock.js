// Временный источник данных: shared/mock/books_sample.json.
// Подменяется настоящим API в src/api/index.js — форма ответов должна остаться той же.
import { shortTitle } from '../lib/format.js'
import { sectionLabel } from '../lib/sections.js'

let dataPromise

function loadData() {
  dataPromise ??= import('@shared/mock/books_sample.json').then(({ default: raw }) => {
    const books = raw.books
    const byId = new Map(books.map((b) => [b.id, b]))
    const meanRating = books.reduce((s, b) => s + b.rating, 0) / books.length
    return { raw, books, byId, meanRating }
  })
  return dataPromise
}

function delay(value, ms = 200 + Math.random() * 250) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

export class NotFoundError extends Error {
  status = 404
}

// Байесовское среднее (2.4): мало оценок → рейтинг тянется к среднему по каталогу
function weightedRating(book, mean, m = 300) {
  const n = book.ratingsCount
  return (n / (n + m)) * book.rating + (m / (n + m)) * mean
}

const byWeighted = (mean) => (a, b) => weightedRating(b, mean) - weightedRating(a, mean)

// Условный пользователь для моков: по одной самой популярной книге из этих тем он «оценил на 5»
const MOCK_PROFILE_SECTIONS = ['Science Fiction & Fantasy', 'Mystery, Thriller & Suspense', 'Business & Money']

function mockLiked({ books }) {
  return MOCK_PROFILE_SECTIONS.map(
    (section) => books.filter((b) => b.section === section).sort((a, b) => b.ratingsCount - a.ratingsCount)[0],
  ).filter(Boolean)
}

// Текст объяснения готовит сервер. В ленте он идёт под обложкой в две строки — поэтому короткий;
// подробный вариант — для плашки на странице книги
function reasonFor(book, liked, { detailed = false } = {}) {
  const twin = liked.find((l) => l.id !== book.id && l.subsection && l.subsection === book.subsection)
  if (twin) {
    const text = `Похожа на «${shortTitle(twin.title)}»`
    return { kind: 'similar', text: detailed ? `${text} — вы оценили её на 5` : text, seedId: twin.id }
  }
  if (liked.some((l) => l.section === book.section)) {
    const section = sectionLabel(book.section)
    const text = detailed
      ? `Из вашей темы «${section}», читатели оценивают её в ${book.rating.toFixed(1)}`
      : `Ваша тема: ${section}`
    return { kind: 'topic', text }
  }
  return null
}

export async function getSections() {
  const { raw } = await loadData()
  return delay(raw.sections.map((s) => ({ name: s.name, booksCount: s.books })))
}

export async function getBooks({ section, sort = 'popular', limit = 20, offset = 0 } = {}) {
  const { books, meanRating } = await loadData()
  const list = section ? books.filter((b) => b.section === section) : [...books]
  list.sort(sort === 'rating' ? byWeighted(meanRating) : (a, b) => b.ratingsCount - a.ratingsCount)
  return delay({ items: list.slice(offset, offset + limit), total: list.length })
}

export async function getBook(id) {
  const data = await loadData()
  const book = data.byId.get(id)
  if (!book) {
    await delay()
    throw new NotFoundError(`Книга ${id} не найдена`)
  }
  return delay({ ...book, recommendation: reasonFor(book, mockLiked(data), { detailed: true }) })
}

export async function getSimilarBooks(id, { limit = 12 } = {}) {
  const { books, byId, meanRating } = await loadData()
  const book = byId.get(id)
  if (!book) return delay([])
  const score = (b) => (b.subsection && b.subsection === book.subsection ? 2 : 0) + (b.section === book.section ? 1 : 0)
  const list = books
    .filter((b) => b.id !== id && score(b) > 0)
    .sort((a, b) => score(b) - score(a) || byWeighted(meanRating)(a, b))
  return delay(list.slice(0, limit))
}

export async function getRecommendations({ limit = 16 } = {}) {
  const data = await loadData()
  const { books, meanRating } = data
  const liked = mockLiked(data)
  const likedIds = new Set(liked.map((b) => b.id))

  // «Для вас»: по очереди из тем профиля, внутри темы — по взвешенному рейтингу
  const queues = MOCK_PROFILE_SECTIONS.map((s) =>
    books.filter((b) => b.section === s && !likedIds.has(b.id)).sort(byWeighted(meanRating)),
  )
  const forYou = []
  for (let i = 0; forYou.length < limit && queues.some((q) => q[i]); i++) {
    for (const q of queues) if (q[i] && forYou.length < limit) forYou.push(q[i])
  }

  const becauseYouLiked = liked.slice(0, 2).map((seed) => ({
    seed,
    items: books
      .filter((b) => b.id !== seed.id && b.section === seed.section)
      .sort(byWeighted(meanRating))
      .slice(0, 12)
      .map((book) => ({ book, reason: { kind: 'similar', text: `Похожа на «${shortTitle(seed.title)}»`, seedId: seed.id } })),
  }))

  return delay({
    forYou: forYou.map((book) => ({ book, reason: reasonFor(book, liked) })),
    becauseYouLiked,
  })
}
