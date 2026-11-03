// Настоящий API (backend/README.md). Формы ответов — как описано в ./index.js
import { request } from './http.js'

const enc = encodeURIComponent

// ——— Вход ———
export const register = (body) => request('/auth/register', { method: 'POST', body })
export const login = (body) => request('/auth/login', { method: 'POST', body })
export const getMe = () => request('/auth/me').then((r) => r.user)

// ——— Книги ———
export const getSections = () => request('/sections')
export const getBooks = (params = {}) => request('/books', { params })
export const getBook = (id) => request(`/books/${enc(id)}`)
export const getSimilarBooks = (id, { limit = 12 } = {}) => request(`/books/${enc(id)}/similar`, { params: { limit } })
export const getRecommendations = ({ limit = 16 } = {}) => request('/recommendations', { params: { limit } })

// ——— Поиск ———
export const searchBooks = ({ q, section, year, rating, hideRead, limit = 20, offset = 0 }, { signal } = {}) =>
  request('/search', { params: { q, section, year, rating, hideRead, limit, offset }, signal })
export const suggestBooks = (q, { signal } = {}) => request('/search/suggest', { params: { q }, signal })

// ——— Онбординг ———
export const getOnboardingRound = () => request('/onboarding/next-round')
export const sendOnboardingAnswers = (body) => request('/onboarding/answers', { method: 'POST', body })

// ——— Мои действия с книгой ———
export const setRating = (bookId, value) =>
  value ? request(`/me/ratings/${enc(bookId)}`, { method: 'PUT', body: { value } }) : request(`/me/ratings/${enc(bookId)}`, { method: 'DELETE' })
export const setShelf = (bookId, shelf) =>
  shelf ? request(`/me/shelves/${enc(bookId)}`, { method: 'PUT', body: { shelf } }) : request(`/me/shelves/${enc(bookId)}`, { method: 'DELETE' })
export const setHidden = (bookId, hidden) => request(`/me/hidden/${enc(bookId)}`, { method: hidden ? 'PUT' : 'DELETE' })

// ——— Кабинет ———
export const getTaste = () => request('/me/taste')
