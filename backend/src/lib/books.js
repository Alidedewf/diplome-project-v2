// Книга в форме слоя данных фронтенда (frontend/src/api/index.js):
//   Book { id, title, titleRu, author, authorRu, year, section, subsection, cover, rating, ratingsCount, annotation, source }
// source — 'amazon' | 'ru' | 'kz' (свой каталог, 1.5: оценок нет — rating null, ratingsCount 0); originalLanguage — язык
// оригинала своих книг ('ru' | 'kk', из Wikidata P407), у книг Amazon — null
// titleRu / authorRu — из Wikidata (2.8), чаще всего null. На странице книги (full) ещё annotationRu,
// annotationSource ('wikipedia' | 'mt' | null) и annotationUrl (статья Википедии)
import { Prisma, prisma } from '../db.js'
import { bookNotFound } from './http.js'

// В списках аннотация обрезается, как в моках фронтенда; на странице книги — целиком
const LIST_ANNOTATION_MAX = 700

// Колонки книги для сырых запросов; alias — имя таблицы в запросе
export const bookColumns = (alias = 'b', { full = false } = {}) => {
  const t = Prisma.raw(alias)
  const annotation = full
    ? Prisma.sql`${t}.annotation, ${t}.annotation_ru, ${t}.annotation_source, ${t}.annotation_url`
    : Prisma.sql`left(${t}.annotation, ${LIST_ANNOTATION_MAX + 1}) AS annotation`
  return Prisma.sql`${t}.id, ${t}.title, ${t}.author, ${t}.year, ${t}.section, ${t}.category, ${t}.subsection,
    ${t}.cover, ${t}.rating, ${t}.ratings_count, ${annotation}, ${t}.title_ru, ${t}.author_ru, ${t}.ru_known, ${t}.source, ${t}.language`
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
    titleRu: row.title_ru ?? row.titleRu ?? null,
    author: row.author,
    authorRu: row.author_ru ?? row.authorRu ?? null,
    year: row.year,
    // У книг служебных разделов (Textbooks, Boxed Sets…) раздела онбординга нет — показываем раздел Amazon
    section: row.section ?? row.category,
    subsection: row.subsection,
    cover: row.cover,
    rating: row.rating == null ? null : Math.round(row.rating * 10) / 10,
    ratingsCount: row.ratings_count ?? row.ratingsCount,
    annotation: full ? row.annotation : cutAnnotation(row.annotation),
    source: row.source ?? 'amazon',
    originalLanguage: (row.source ?? 'amazon') === 'amazon' ? null : ({ Kazakh: 'kk', Russian: 'ru' }[row.language] ?? null),
    ...(full && {
      annotationRu: row.annotation_ru ?? row.annotationRu ?? null,
      annotationSource: row.annotation_source ?? row.annotationSource ?? null,
      annotationUrl: row.annotation_url ?? row.annotationUrl ?? null,
    }),
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

// Слова названия: без подзаголовка, скобок, хвоста «, Book 6» и второго названия через « / », только буквы и цифры;
// типографский апостроф — как обычный (Sorcerer’s = Sorcerer's)
export const titleWords = (title) => title.toLowerCase().replace(/[’‘]/g, "'").replace(/\(.*?\)|\[.*?\]/g, ' ')
  .split(/[:;/]/)[0].replace(/,\s*(?:book|vol\.?|volume)\s*\d+\s*$/, '').match(/[\p{L}\p{N}']+/gu) ?? []
// Хвост издания без двоеточия и скобок: «…, Collector's Edition», «… 10th Anniversary Edition», «… Paperback Boxed Set»
const EDITION_WORDS = new Set(['new', 'revised', 'special', 'deluxe', 'illustrated', 'anniversary', 'gift', 'limited', 'expanded',
  'updated', 'unabridged', 'abridged', 'annotated', 'definitive', 'international', 'mass', 'market', 'paperback', 'hardcover',
  'movie', 'tie', 'in', 'first', 'second', 'third', 'large', 'print', 'signed', 'exclusive', 'edition', 'the', 'a', 'an'])
const isEditionWord = (w) => EDITION_WORDS.has(w) || /'s$/.test(w) || /^\d+(st|nd|rd|th)?$/.test(w)
function dropEditionTail(words) {
  let end = words.length
  if (words[end - 1] === 'edition') end -= 1
  else if (words[end - 1] === 'set' && ['box', 'boxed'].includes(words[end - 2])) end -= 2
  else return words
  while (end > 0 && words.length - end < 6 && isEditionWord(words[end - 1])) end -= 1
  return end > 0 ? words.slice(0, end) : words
}
// Название для сравнения изданий: «The Martian» = «Martian, The» = «The Martian (Movie Tie-in)»,
// «Harry Potter and the Sorcerer's Stone» = «…: The Illustrated Edition» = «…, Collector's Edition»
export const editionKey = (title) => dropEditionTail(titleWords(title))
  .filter((w, i, all) => !((i === 0 || i === all.length - 1) && ['the', 'a', 'an'].includes(w))).join(' ')

// Одно издание на название и автора — первое в порядке списка (самое популярное). Первые n книг результата зависят
// только от первых строк списка, поэтому страницы можно считать по префиксу
export function oneEdition(books) {
  const seen = new Set()
  return books.filter((b) => {
    const key = `${editionKey(b.title)}|${b.author ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// Книга для малышей и дошкольников: картонная или по возрасту читателя (Amazon «Reading age») — до 8 лет,
// либо «от N лет» при N ≤ 3. Во взрослую ленту они попадали через раздел Children's Books, где лежат и
// «Голодные игры» (решения.md 4.8)
export const LITTLE_KIDS_MAX_AGE = 8
export const littleKids = (alias = 'b') => {
  const t = Prisma.raw(alias)
  return Prisma.sql`(coalesce(${t}.format = 'Board book', false) OR coalesce(${t}.reading_age_max <= ${LITTLE_KIDS_MAX_AGE}, false)
    OR (${t}.reading_age_max IS NULL AND coalesce(${t}.reading_age_min <= 3, false)))`
}

