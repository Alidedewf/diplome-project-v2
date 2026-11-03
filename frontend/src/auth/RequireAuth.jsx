import { Navigate, Outlet, useLocation } from 'react-router'
import { Spinner } from '../components/Spinner.jsx'
import { loginPath, useAuth } from './context.js'

// Защищённые маршруты (/me/*, /onboarding): без входа — на /login с возвратом обратно.
// Если пользователь только что вышел сам (меню, удаление аккаунта) — на главную
export function RequireAuth() {
  const { user, isLoading, signedOut } = useAuth()
  const location = useLocation()
  if (isLoading) return <Spinner className="py-24" />
  if (!user) return <Navigate to={signedOut ? '/' : loginPath(location)} replace />
  return <Outlet />
}
