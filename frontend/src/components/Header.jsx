import { BookMarked, LogOut, Moon, Sparkles, Sun, UserRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router'
import { loginPath, useAuth } from '../auth/context.js'
import { useTheme } from '../theme/context.js'
import { BookAutocomplete } from './BookAutocomplete.jsx'
import { Button } from './Button.jsx'

function Logo() {
  return (
    <Link to="/" className="col-start-1 row-start-1 flex shrink-0 items-center gap-2" aria-label="BookMind — на главную">
      <img src="/favicon.svg" alt="" className="size-7" />
      <span className="font-serif text-xl font-semibold tracking-tight">BookMind</span>
    </Link>
  )
}

function SearchBox({ className }) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { pathname } = useLocation()
  const current = pathname === '/search' ? (params.get('q') ?? '') : ''

  return (
    <div role="search" className={className}>
      <BookAutocomplete
        // новое значение из адреса (переход на /search?q=…) — новое поле
        key={current}
        initialValue={current}
        label="Поиск книг"
        placeholder="Название, автор или ISBN"
        onSelect={(book) => navigate(`/book/${book.id}`)}
        onSubmitQuery={(q) => navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search')}
      />
    </div>
  )
}

const initials = (name = '') =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?'

function UserMenu({ user, onLogout }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const close = (e) => {
      if (e.type === 'keydown' ? e.key === 'Escape' : !ref.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  const item = 'flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm hover:bg-surface-2'

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Меню пользователя ${user.name}`}
        onClick={() => setOpen(!open)}
        className="flex size-9 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-fg ring-offset-2 ring-offset-paper transition hover:ring-2 hover:ring-accent"
      >
        {initials(user.name)}
      </button>
      {open && (
        <div role="menu" className="absolute top-full right-0 z-30 mt-2 w-60 rounded-xl border border-line bg-surface py-1 shadow-lg" onClick={() => setOpen(false)}>
          <div className="border-b border-line px-4 py-3">
            <p className="truncate font-medium">{user.name}</p>
            <p className="truncate text-xs text-muted">{user.email}</p>
          </div>
          <Link role="menuitem" to="/me" className={item}>
            <BookMarked size={16} className="text-muted" /> Мои полки
          </Link>
          <Link role="menuitem" to="/me/taste" className={item}>
            <Sparkles size={16} className="text-muted" /> Профиль вкусов
          </Link>
          <Link role="menuitem" to="/me/settings" className={item}>
            <UserRound size={16} className="text-muted" /> Профиль и аккаунт
          </Link>
          <button role="menuitem" type="button" onClick={onLogout} className={`${item} border-t border-line`}>
            <LogOut size={16} className="text-muted" /> Выйти
          </button>
        </div>
      )}
    </div>
  )
}

export function Header() {
  const { theme, toggle } = useTheme()
  const { user, isLoading, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const dark = theme === 'dark'
  const onAuthPage = ['/login', '/register'].includes(location.pathname)

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-paper/90 backdrop-blur">
      <div className="mx-auto grid max-w-[1200px] grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-3 px-4 py-3 sm:grid-cols-[minmax(max-content,1fr)_minmax(0,32rem)_minmax(max-content,1fr)]">
        {/* колонки заданы явно: элемент с одной лишь row-start грид ставит раньше остальных */}
        <Logo />
        <SearchBox className="col-span-3 row-start-2 sm:col-span-1 sm:col-start-2 sm:row-start-1" />
        <div className="col-start-3 row-start-1 flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            aria-label={dark ? 'Светлая тема' : 'Тёмная тема'}
            title={dark ? 'Светлая тема' : 'Тёмная тема'}
          >
            {dark ? <Sun size={19} /> : <Moon size={19} />}
          </Button>
          {user ? (
            <UserMenu
              user={user}
              onLogout={() => {
                logout()
                navigate('/')
              }}
            />
          ) : isLoading ? (
            <span className="size-9 animate-pulse rounded-full bg-surface-2" aria-hidden />
          ) : (
            !onAuthPage && (
              <Button as={Link} to={loginPath(location)} variant="primary" size="sm">
                Войти
              </Button>
            )
          )}
        </div>
      </div>
    </header>
  )
}
