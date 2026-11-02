import { Moon, Search, Sun, User } from 'lucide-react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useTheme } from '../theme/context.js'
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

  const onSubmit = (e) => {
    e.preventDefault()
    const q = new FormData(e.currentTarget).get('q').trim()
    navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search')
  }

  return (
    <form role="search" onSubmit={onSubmit} className={className}>
      <label className="flex h-10 items-center gap-2 rounded-full border border-line bg-surface px-4 transition-colors focus-within:border-accent">
        <Search size={17} className="shrink-0 text-muted" aria-hidden />
        <input
          key={params.get('q')}
          name="q"
          type="search"
          defaultValue={params.get('q') ?? ''}
          placeholder="Название, автор или о чём книга"
          aria-label="Поиск книг"
          className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted"
        />
      </label>
    </form>
  )
}

export function Header() {
  const { theme, toggle } = useTheme()
  const dark = theme === 'dark'

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
          <Link
            to="/me"
            aria-label="Личный кабинет"
            title="Личный кабинет"
            className="flex size-9 items-center justify-center rounded-full bg-accent-soft text-accent-text ring-1 ring-line transition hover:ring-accent"
          >
            <User size={18} />
          </Link>
        </div>
      </div>
    </header>
  )
}
