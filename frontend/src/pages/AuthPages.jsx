import { CircleAlert } from 'lucide-react'
import { useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { useAuth } from '../auth/context.js'
import { Button } from '../components/Button.jsx'
import { TextField } from '../components/TextField.jsx'

// Куда вернуться после входа: только внутренние адреса
function useNext() {
  const [params] = useSearchParams()
  const next = params.get('next')
  return next?.startsWith('/') && !next.startsWith('//') ? next : null
}

// Ошибки по полям из details сервера: [{ path, message }] → { email: '…' }
const fieldErrors = (error) => Object.fromEntries((error?.details ?? []).map((d) => [d.path, d.message]))

function AuthLayout({ title, subtitle, children, footer }) {
  return (
    <div className="mx-auto flex max-w-sm flex-col gap-6 py-6 sm:py-12">
      <div className="flex flex-col gap-2 text-center">
        <h1 className="text-3xl font-semibold">{title}</h1>
        <p className="text-muted">{subtitle}</p>
      </div>
      <div className="rounded-2xl border border-line bg-surface p-5 sm:p-6">{children}</div>
      <p className="text-center text-sm text-muted">{footer}</p>
    </div>
  )
}

function FormError({ error }) {
  // Ошибки отдельных полей показываются у полей; здесь — общая
  if (!error || error.details?.length) return null
  return (
    <p role="alert" className="flex items-start gap-2 rounded-lg bg-smart-soft px-3 py-2.5 text-sm text-smart-text">
      <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
      {error.message}
    </p>
  )
}

function useSubmit(action) {
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    setError(null)
    setPending(true)
    try {
      await action(Object.fromEntries(new FormData(e.currentTarget)))
    } catch (err) {
      setError(err)
      setPending(false)
    }
  }
  return { submit, error, pending }
}

export function LoginPage() {
  const { user, login } = useAuth()
  const navigate = useNavigate()
  const next = useNext()
  const { submit, error, pending } = useSubmit(async (data) => {
    await login(data)
    // Онбординг не навязываем (2.3): незавершённый — баннер на главной, а не переход
    navigate(next ?? '/', { replace: true })
  })
  if (user && !pending) return <Navigate to={next ?? '/'} replace />
  const errors = fieldErrors(error)

  return (
    <AuthLayout
      title="Вход"
      subtitle="Ваши полки, оценки и подборки под ваш вкус"
      footer={
        <>
          Нет аккаунта?{' '}
          <Link to={`/register${next ? `?next=${encodeURIComponent(next)}` : ''}`} className="font-medium text-accent-text hover:underline">
            Зарегистрироваться
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <FormError error={error} />
        <TextField label="Email" name="email" type="email" autoComplete="email" required autoFocus error={errors.email} />
        <TextField label="Пароль" name="password" type="password" autoComplete="current-password" required error={errors.password} />
        <Button type="submit" variant="primary" className="mt-2 h-11" disabled={pending}>
          {pending ? 'Входим…' : 'Войти'}
        </Button>
      </form>
    </AuthLayout>
  )
}

export function RegisterPage() {
  const { user, register } = useAuth()
  const navigate = useNavigate()
  const next = useNext()
  const { submit, error, pending } = useSubmit(async (data) => {
    await register(data)
    // Сразу после регистрации — онбординг (2.3)
    navigate('/onboarding', { replace: true })
  })
  if (user && !pending) return <Navigate to={next ?? '/'} replace />
  const errors = fieldErrors(error)

  return (
    <AuthLayout
      title="Регистрация"
      subtitle="Пара вопросов о вкусах — и подборки готовы"
      footer={
        <>
          Уже есть аккаунт?{' '}
          <Link to={`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`} className="font-medium text-accent-text hover:underline">
            Войти
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <FormError error={error} />
        <TextField label="Имя" name="name" autoComplete="name" required autoFocus error={errors.name} />
        <TextField label="Email" name="email" type="email" autoComplete="email" required error={errors.email} />
        <TextField
          label="Пароль"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          hint="Не короче 8 символов"
          error={errors.password}
        />
        <Button type="submit" variant="primary" className="mt-2 h-11" disabled={pending}>
          {pending ? 'Создаём аккаунт…' : 'Зарегистрироваться'}
        </Button>
      </form>
    </AuthLayout>
  )
}
