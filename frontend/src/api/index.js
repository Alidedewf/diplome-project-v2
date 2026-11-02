// Слой данных. Компоненты ходят только сюда (через хуки из ./queries.js).
// Сейчас всё берётся из моков; при переходе на бэкенд меняется только этот файл.
//
// Формы ответов:
//   Book           { id, title, author, year, section, subsection, cover, rating, ratingsCount, annotation }
//   Reason         { kind: 'similar' | 'topic' | 'popular', text, seedId? }
//   getSections()          → [{ name, booksCount }]
//   getBooks(p)            → { items: Book[], total }   p: { section?, sort?: 'popular' | 'rating', limit?, offset? }
//   getBook(id)            → Book & { recommendation: Reason | null }; нет книги — NotFoundError
//   getSimilarBooks(id, p) → Book[]
//   getRecommendations(p)  → { forYou: [{ book, reason }], becauseYouLiked: [{ seed: Book, items: [{ book, reason }] }] }
export { getSections, getBooks, getBook, getSimilarBooks, getRecommendations, NotFoundError } from './mock.js'
