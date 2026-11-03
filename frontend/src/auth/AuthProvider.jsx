import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { dropEvents, flushEvents } from '../api/events.js'
import * as api from '../api/index.js'
import { AuthContext } from './context.js'

const ME_KEY = ['auth', 'me']

// Токен — в localStorage (bookmind-token), пользователь — в кэше TanStack Query.
// При входе и выходе кэш очищается: лента, карточки книг и поиск у гостя и у пользователя разные.
export function AuthProvider({ children }) {
  const queryClient = useQueryClient()
  const [token, setTokenState] = useState(api.getToken)
  // Вышел сам (меню, удаление аккаунта) — защищённые страницы ведут на главную, а не на вход;
  // сессия истекла (401) — на вход с возвратом обратно
  const [signedOut, setSignedOut] = useState(false)

  const me = useQuery({ queryKey: ME_KEY, queryFn: api.getMe, enabled: Boolean(token), staleTime: Infinity, retry: false })

  const applyToken = useCallback(
    (next, user) => {
      flushEvents()
      api.setToken(next)
      setTokenState(next)
      queryClient.clear()
      if (user) queryClient.setQueryData(ME_KEY, user)
    },
    [queryClient],
  )

  // Сервер ответил 401 на запрос с токеном — сессия истекла
  useEffect(() => {
    api.setUnauthorizedHandler(() => {
      dropEvents()
      applyToken(null)
    })
    return () => api.setUnauthorizedHandler(() => {})
  }, [applyToken])

  const value = useMemo(
    () => ({
      user: token ? (me.data ?? null) : null,
      isLoading: Boolean(token) && me.isPending,
      signedOut,
      login: async (credentials) => {
        const { token: t, user } = await api.login(credentials)
        setSignedOut(false)
        applyToken(t, user)
        return user
      },
      register: async (data) => {
        const { token: t, user } = await api.register(data)
        setSignedOut(false)
        applyToken(t, user)
        return user
      },
      logout: () => {
        setSignedOut(true)
        applyToken(null)
      },
      updateUser: (user) => queryClient.setQueryData(ME_KEY, user),
    }),
    [token, me.data, me.isPending, signedOut, applyToken, queryClient],
  )

  return <AuthContext value={value}>{children}</AuthContext>
}
