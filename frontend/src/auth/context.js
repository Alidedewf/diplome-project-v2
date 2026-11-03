import { createContext, useContext } from 'react'

export const AuthContext = createContext(null)

// { user, isLoading, login, register, logout, updateUser }
export const useAuth = () => useContext(AuthContext)

// Ссылка на вход с возвратом на текущую страницу
export const loginPath = (location) => `/login?next=${encodeURIComponent(location.pathname + location.search)}`
