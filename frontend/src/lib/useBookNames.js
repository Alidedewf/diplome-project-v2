import { useAuth } from '../auth/context.js'
import { bookNames, readerOf, readsRussian } from './bookNames.js'

// Читает ли текущий пользователь по-русски (см. bookNames.js)
export function useReadsRussian() {
  return readsRussian(useAuth().user)
}

// { ru, kk } — для bookNames
export function useReader() {
  const { user } = useAuth()
  return readerOf(user)
}

// Названия книги для показа текущему пользователю
export function useBookNames(book) {
  return bookNames(book, useReader())
}
