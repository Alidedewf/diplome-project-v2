// Слой данных. Компоненты ходят только сюда (через хуки из ./queries.js).
// По умолчанию — настоящий API (VITE_API_URL, по умолчанию http://localhost:3000/api);
// VITE_USE_MOCKS=1 — запасной режим без сервера на shared/mock/books_sample.json.
//
// Формы ответов (backend/README.md):
//   Book           { id, title, author?, year?, section?, subsection?, cover?, rating, ratingsCount, annotation }
//   Reason         { kind: 'similar' | 'topic' | 'popular', text, seedId? }
//   User           { id, email, name, createdAt, onboardingCompleted }
//   register / login       → { token, user }; getMe → User
//   getSections()          → [{ name, booksCount }]
//   getBooks(p)            → { items: Book[], total }   p: { section?, sort?: 'popular' | 'rating', limit?, offset? }
//   getBook(id)            → Book & { recommendation: Reason | null, my: { rating, shelf, hidden } | null }
//   getSimilarBooks(id, p) → Book[]
//   getRecommendations(p)  → { forYou: [{ book, reason }], becauseYouLiked: [{ seed: Book, items: [{ book, reason }] }] }
//   searchBooks(p)         → { items: Book[], total, fuzzy }   p: { q, section?, year?: '2015' | '2010-2015', rating?, hideRead?, limit?, offset? }
//   suggestBooks(q)        → [{ id, title, author, year, cover }]
//   getOnboardingRound()   → { session, round, done, items: [{ book, reason }] }
//   sendOnboardingAnswers({ topics?, description?, round?, answers?: [{ bookId, answer: 'like' | 'dislike' | 'unread', source?: 'round' | 'search' }], completed? }) → { saved, user }
//   setRating(id, 1–5 | null), setShelf(id, 'want' | 'reading' | 'read' | null), setHidden(id, bool)
//   getTaste()             → { items: [{ kind, value, label, source, weight }], rejected }
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
  getTaste,
} = api

export { ApiError, getToken, setToken, setUnauthorizedHandler } from './http.js'
