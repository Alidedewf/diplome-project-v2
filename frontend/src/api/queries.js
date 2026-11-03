import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getBook,
  getBooks,
  getOnboardingRound,
  getRecommendations,
  getSections,
  getSimilarBooks,
  searchBooks,
  setHidden,
  setRating,
  setShelf,
  suggestBooks,
} from './index.js'

export const useSections = () => useQuery({ queryKey: ['sections'], queryFn: getSections, staleTime: Infinity })

// keepPreviousData — при смене фильтра старый список остаётся на экране, пока грузится новый
export const useBooks = (params = {}, { enabled = true } = {}) =>
  useQuery({ queryKey: ['books', params], queryFn: () => getBooks(params), placeholderData: keepPreviousData, enabled })

export const useBook = (id) => useQuery({ queryKey: ['book', id], queryFn: () => getBook(id), enabled: Boolean(id) })

export const useSimilarBooks = (id) =>
  useQuery({ queryKey: ['book', id, 'similar'], queryFn: () => getSimilarBooks(id), enabled: Boolean(id) })

export const useRecommendations = () => useQuery({ queryKey: ['recommendations'], queryFn: () => getRecommendations() })

// ——— Поиск ———

const SEARCH_PAGE = 24

// Страницы результатов для «Показать ещё»; params — { q, section?, year?, rating?, hideRead? }
export const useSearch = (params) =>
  useInfiniteQuery({
    queryKey: ['search', params],
    queryFn: ({ pageParam, signal }) => searchBooks({ ...params, limit: SEARCH_PAGE, offset: pageParam }, { signal }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0)
      return loaded < last.total && last.items.length ? loaded : undefined
    },
    enabled: Boolean(params.q),
    placeholderData: keepPreviousData,
  })

export const useSuggest = (q) =>
  useQuery({
    queryKey: ['suggest', q],
    queryFn: ({ signal }) => suggestBooks(q, { signal }),
    enabled: q.length >= 2,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  })

// ——— Онбординг ———

export const useOnboardingRound = () =>
  useQuery({ queryKey: ['onboarding', 'round'], queryFn: getOnboardingRound, staleTime: 0, gcTime: 0 })

// ——— Действия с книгой: оценка, полка, «Не интересно» ———

// Как изменится my на сервере (оценка сама кладёт книгу на «Прочитал», 4.3)
function applyAction(my, { kind, value }) {
  const base = my ?? { rating: null, shelf: null, hidden: false }
  if (kind === 'rating') return { ...base, rating: value, shelf: value ? 'read' : base.shelf }
  if (kind === 'shelf') return { ...base, shelf: value }
  return { ...base, hidden: value }
}

const ACTIONS = { rating: setRating, shelf: setShelf, hidden: setHidden }

// Интерфейс меняется сразу (optimistic update); при ошибке — откат и onError(сообщение)
export function useBookAction(id, { onError } = {}) {
  const qc = useQueryClient()
  const key = ['book', id]
  const mutationKey = ['book-action', id]
  return useMutation({
    mutationKey,
    mutationFn: ({ kind, value }) => ACTIONS[kind](id, value),
    onMutate: async (action) => {
      await qc.cancelQueries({ queryKey: key, exact: true })
      const previous = qc.getQueryData(key)
      qc.setQueryData(key, (book) => book && { ...book, my: applyAction(book.my, action) })
      return { previous }
    },
    onError: (error, _action, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous)
      onError?.(error.message)
    },
    onSettled: () => {
      // Пока идут другие действия с этой книгой, не перечитываем её — иначе ответ затрёт их состояние
      if (qc.isMutating({ mutationKey }) > 1) return
      // Лента, похожие и поиск зависят от оценок и скрытых книг; карточку сверяем с сервером
      qc.invalidateQueries({ queryKey: key, exact: true })
      qc.invalidateQueries({ queryKey: ['recommendations'] })
      qc.invalidateQueries({ queryKey: ['search'] })
    },
  })
}
