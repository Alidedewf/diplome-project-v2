import { Navigate, Outlet, useLocation } from 'react-router'
import { Spinner } from '../components/Spinner.jsx'
import { loginPath, useAuth } from './context.js'

// Защищённые маршруты (/me/*, /onboarding): без входа — на /login с возвратом обратно
export function RequireAuth() {
  const { user, isLoading } = useAuth()
  const location = useLocation()
  if (isLoading) return <Spinner className="py-24" />
  if (!user) return <Navigate to={loginPath(location)} replace />
  return <Outlet />
}
