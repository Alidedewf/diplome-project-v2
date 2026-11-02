import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { getBook, getBooks, getRecommendations, getSections, getSimilarBooks } from './index.js'

export const useSections = () => useQuery({ queryKey: ['sections'], queryFn: getSections, staleTime: Infinity })

// keepPreviousData — при смене фильтра старый список остаётся на экране, пока грузится новый
export const useBooks = (params = {}) =>
  useQuery({ queryKey: ['books', params], queryFn: () => getBooks(params), placeholderData: keepPreviousData })

export const useBook = (id) => useQuery({ queryKey: ['book', id], queryFn: () => getBook(id), enabled: Boolean(id) })

export const useSimilarBooks = (id) =>
  useQuery({ queryKey: ['book', id, 'similar'], queryFn: () => getSimilarBooks(id), enabled: Boolean(id) })

export const useRecommendations = () => useQuery({ queryKey: ['recommendations'], queryFn: () => getRecommendations() })
