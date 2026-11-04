// Слой данных. Компоненты ходят только сюда (через хуки из ./queries.js).
// По умолчанию — настоящий API (VITE_API_URL, по умолчанию http://localhost:3000/api);
// VITE_USE_MOCKS=1 — запасной режим без сервера на shared/mock/books_sample.json.
//
// Формы ответов (backend/README.md):
//   Book           { id, source: 'amazon' | 'ru' | 'kz', title, titleRu?, author?, authorRu?, year?, section?, subsection?, cover?,
//                    rating: number | null, ratingsCount, annotation }   у своих книг (ru, kz) оценок нет: rating null, ratingsCount 0
//   Reason         { kind: 'similar' | 'topic' | 'popular' | 'series', text, seedId? }
//   User           { id, email, name, createdAt, onboardingCompleted, readingLanguages: ('ru' | 'kk' | 'en')[] }
//   register / login       → { token, user }; getMe → User
//   getSections()          → [{ name, booksCount }]
//   getBooks(p)            → { items: Book[], total }   p: { section?, source?: 'ru' | 'kz', sort?: 'popular' | 'rating', limit?, offset? }
//   getBook(id)            → Book & { annotationRu, annotationSource: 'wikipedia' | 'mt' | null, annotationUrl, recommendation: Reason | null, my: { rating, shelf, hidden } | null }
//   getSimilarBooks(id, p) → Book[]
//   getRecommendations(p)  → { forYou: [{ book, reason }], becauseYouLiked: [{ seed: Book, items: [{ book, reason }] }],
//                              series: [{ name, seeds: Book[], items: [{ book, reason }] }], local: [{ source: 'ru' | 'kz', items: [{ book, reason }] }] }
//   searchBooks(p)         → { items: Book[], total, fuzzy, mode: 'hybrid' | 'keyword' | 'semantic' }   p: { q, section?, year?: '2015' | '2010-2015', rating?, hideRead?, limit?, offset? }
//   suggestBooks(q)        → [{ id, title, titleRu, author, authorRu, year, cover }]
//   getOnboardingRound()   → { session, round, done, items: [{ book, reason }] }
//   sendOnboardingAnswers({ topics?, description?, readingLanguages?, round?, answers?: [{ bookId, answer: 'like' | 'dislike' | 'unread', source?: 'round' | 'search' }], completed? }) → { saved, user }
//   setRating(id, 1–5 | null), setShelf(id, 'want' | 'reading' | 'read' | null), setHidden(id, bool)
//   getShelves(p)          → { items: [{ book, shelf, rating, addedAt }], total, counts: { want, reading, read } }   p: { shelf?, limit?, offset? }
//   getRatings(p)          → { items: [{ book, rating, ratedAt }], total };  getHidden(p) → { items: [{ book, hiddenAt }], total }
//   getTaste()             → { items: [{ kind, value, label, source: 'onboarding' | 'profile', weight }], rejected: [{ kind, value, label }] }
//   updateTaste({ kind: 'section' | 'subsection' | 'author', value, rejected }) → как getTaste
//   getStats(year?)        → { year, readTotal, readThisYear, byMonth: [{ month, count }], bySection: [{ section, label, count }],
//                              ratings: { count, average, distribution: { 1..5 } }, goal: { year, target, done } | null }
//   setGoal({ target, year? }) → { year, target, done }
//   updateProfile({ name?, email?, password?, currentPassword?, readingLanguages? }) → User;  deleteAccount(password) → null
//   sendEvents([{ type: 'view' | 'rec_click', bookId, payload? }], { keepalive? }) → { saved }
// Ошибки — ApiError { status, code, message (по-русски, для пользователя), details? }.
import * as mock from './mock.js'
import * as server from './server.js'

export const USE_MOCKS = ['1', 'true'].includes(import.meta.env.VITE_USE_MOCKS)
const api = USE_MOCKS ? mock : server

export const {
  register,
  login,
  getMe,
  getSections,
  getBooks,
  getBook,
  getSimilarBooks,
  getRecommendations,
  searchBooks,
  suggestBooks,
  getOnboardingRound,
  sendOnboardingAnswers,
  setRating,
  setShelf,
  setHidden,
  getShelves,
  getRatings,
  getHidden,
  getTaste,
  updateTaste,
  getStats,
  setGoal,
  updateProfile,
  deleteAccount,
  sendEvents,
} = api

export { ApiError, getToken, setToken, setUnauthorizedHandler } from './http.js'
