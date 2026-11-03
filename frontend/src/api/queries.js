import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  deleteAccount,
  getBook,
  getBooks,
  getHidden,
  getOnboardingRound,
  getRatings,
  getRecommendations,
  getSections,
  getShelves,
  getSimilarBooks,
  getStats,
  getTaste,
  searchBooks,
  setGoal,
  setHidden,
  setRating,
  setShelf,
  suggestBooks,
  updateProfile,
  updateTaste,
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

const PAGE = 24

// Страницы для «Показать ещё»: следующая начинается после уже загруженных
const nextPage = (last, pages) => {
  const loaded = pages.reduce((n, p) => n + p.items.length, 0)
  return loaded < last.total && last.items.length ? loaded : undefined
}

// params — { q, section?, year?, rating?, hideRead? }
export const useSearch = (params) =>
  useInfiniteQuery({
    queryKey: ['search', params],
    queryFn: ({ pageParam, signal }) => searchBooks({ ...params, limit: PAGE, offset: pageParam }, { signal }),
    initialPageParam: 0,
    getNextPageParam: nextPage,
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

// Списки кабинета — ['me', 'shelves', shelf], ['me', 'ratings'], ['me', 'hidden']: книга меняется в списке
// или уходит из него, если ей там больше не место. null — убрать из списка
function patchListItem(list, filter, item, { kind, value }) {
  if (list === 'shelves') {
    const next =
      kind === 'shelf' ? { ...item, shelf: value } : kind === 'rating' ? { ...item, rating: value, shelf: value ? 'read' : item.shelf } : item
    return next.shelf && (!filter || next.shelf === filter) ? next : null
  }
  if (list === 'ratings' && kind === 'rating') return value ? { ...item, rating: value } : null
  if (list === 'hidden' && kind === 'hidden') return value ? item : null
  return item
}

// prevShelf — где книга стояла до действия (undefined — неизвестно: счётчики полок не трогаем)
function patchLists(qc, id, action, prevShelf) {
  const nextShelf = action.kind === 'shelf' ? action.value : action.kind === 'rating' && action.value ? 'read' : prevShelf
  const moved = prevShelf !== undefined && prevShelf !== nextShelf
  for (const [key, data] of qc.getQueriesData({ queryKey: ['me'] })) {
    const [, list, filter] = key
    if (!['shelves', 'ratings', 'hidden'].includes(list) || !data?.pages) continue
    const pages = data.pages.map((page) => {
      let removed = 0
      const items = page.items.flatMap((it) => {
        if (it.book.id !== id) return [it]
        const next = patchListItem(list, filter, it, action)
        if (!next) removed++
        return next ? [next] : []
      })
      const counts = page.counts && moved ? { ...page.counts } : page.counts
      if (counts && moved) {
        if (prevShelf) counts[prevShelf] -= 1
        if (nextShelf) counts[nextShelf] += 1
      }
      return { ...page, items, total: page.total - removed, ...(counts && { counts }) }
    })
    qc.setQueryData(key, { ...data, pages })
  }
}

// Где книга стоит сейчас: из карточки книги или из загруженных полок
function knownShelf(qc, id) {
  const book = qc.getQueryData(['book', id])
  if (book?.my) return book.my.shelf
  for (const [, data] of qc.getQueriesData({ queryKey: ['me', 'shelves'] })) {
    const found = data?.pages?.flatMap((p) => p.items).find((it) => it.book.id === id)
    if (found) return found.shelf
  }
  return undefined
}

// Интерфейс меняется сразу (optimistic update); при ошибке — откат и onError(сообщение)
export function useBookAction(id, { onError } = {}) {
  const qc = useQueryClient()
  const key = ['book', id]
  const mutationKey = ['book-action', id]
  return useMutation({
    mutationKey,
    mutationFn: ({ kind, value }) => ACTIONS[kind](id, value),
    onMutate: async (action) => {
      await Promise.all([qc.cancelQueries({ queryKey: key, exact: true }), qc.cancelQueries({ queryKey: ['me'] })])
      const previous = qc.getQueryData(key)
      const lists = qc.getQueriesData({ queryKey: ['me'] })
      patchLists(qc, id, action, knownShelf(qc, id))
      qc.setQueryData(key, (book) => book && { ...book, my: applyAction(book.my, action) })
      return { previous, lists }
    },
    onError: (error, _action, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous)
      for (const [k, data] of ctx?.lists ?? []) qc.setQueryData(k, data)
      onError?.(error.message)
    },
    onSettled: () => {
      // Пока идут другие действия с этой книгой, не перечитываем её — иначе ответ затрёт их состояние
      if (qc.isMutating({ mutationKey }) > 1) return
      // Лента, похожие и поиск зависят от оценок и скрытых книг; карточку сверяем с сервером
      qc.invalidateQueries({ queryKey: key, exact: true })
      qc.invalidateQueries({ queryKey: ['recommendations'] })
      qc.invalidateQueries({ queryKey: ['search'] })
      // Кабинет уже поправлен на месте; открытый список не перечитываем, чтобы строки не прыгали
      // (сервер упорядочивает по времени изменения) — остальное обновится при следующем открытии
      qc.invalidateQueries({ queryKey: ['me'], refetchType: 'none' })
    },
  })
}

// ——— Кабинет ———

const useMyList = (key, fn, options) =>
  useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => fn({ limit: PAGE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: nextPage,
    staleTime: 0,
    ...options,
  })

// placeholderData — при смене вкладки счётчики полок остаются на месте, пока грузится новая
export const useMyShelf = (shelf) =>
  useMyList(['me', 'shelves', shelf], (page) => getShelves({ shelf, ...page }), { placeholderData: keepPreviousData })
export const useMyRatings = () => useMyList(['me', 'ratings'], getRatings)
export const useMyHidden = () => useMyList(['me', 'hidden'], getHidden)

// Темы и интересы пользователя; staleTime 0 — после онбординга и оценок сразу свежие
export const useTaste = () => useQuery({ queryKey: ['me', 'taste'], queryFn: getTaste, staleTime: 0 })

// «Это не про меня» и возврат: пункт сразу переезжает между списками; ответ сервера — новый профиль
export function useTasteUpdate({ onError } = {}) {
  const qc = useQueryClient()
  const key = ['me', 'taste']
  const mutationKey = ['taste-update']
  return useMutation({
    mutationKey,
    mutationFn: updateTaste,
    onMutate: async ({ kind, value, rejected }) => {
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData(key)
      qc.setQueryData(key, (t) => {
        if (!t) return t
        const same = (i) => i.kind === kind && i.value === value
        if (rejected) {
          const item = t.items.find(same)
          return { items: t.items.filter((i) => !same(i)), rejected: item ? [...t.rejected, item] : t.rejected }
        }
        // вернувшийся пункт встанет на своё место после ответа сервера
        return { items: t.items, rejected: t.rejected.filter((i) => !same(i)) }
      })
      return { previous }
    },
    onError: (error, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous)
      onError?.(error.message)
    },
    onSuccess: (taste) => {
      // пока идут другие правки, ответ этой не должен затирать их оптимистичное состояние
      if (qc.isMutating({ mutationKey }) <= 1) qc.setQueryData(key, taste)
    },
    onSettled: () => {
      if (qc.isMutating({ mutationKey }) > 1) return
      qc.invalidateQueries({ queryKey: ['recommendations'] })
    },
  })
}

export const useStats = (year) =>
  useQuery({ queryKey: ['me', 'stats', year], queryFn: () => getStats(year), staleTime: 0, placeholderData: keepPreviousData })

export function useSetGoal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: setGoal,
    onSuccess: (goal) => qc.setQueryData(['me', 'stats', goal.year], (s) => s && { ...s, goal }),
  })
}

export const useUpdateProfile = () => useMutation({ mutationFn: updateProfile })
export const useDeleteAccount = () => useMutation({ mutationFn: deleteAccount })
