import { BarChart3, BookMarked, EyeOff, Sparkles, Star, UserRound } from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router'
import { useAuth } from '../../auth/context.js'
import { cn } from '../../lib/format.js'
import { useScrollToActive } from './useScrollToActive.js'

// Разделы кабинета (2.2)
const SECTIONS = [
  { to: '/me', label: 'Мои полки', icon: BookMarked, end: true },
  { to: '/me/ratings', label: 'Оценки', icon: Star },
  { to: '/me/taste', label: 'Профиль вкусов', icon: Sparkles },
  { to: '/me/hidden', label: 'Скрытые книги', icon: EyeOff },
  { to: '/me/stats', label: 'Статистика', icon: BarChart3 },
  { to: '/me/settings', label: 'Аккаунт', icon: UserRound },
]

// Навигация: на телефоне — прокручиваемая строка над разделом, с md — колонка слева
export function MeLayout() {
  const { user } = useAuth()
  const navRef = useScrollToActive(useLocation().pathname, '[aria-current=page]')
  return (
    <div className="flex flex-col gap-6 md:flex-row md:gap-10">
      <aside className="md:sticky md:top-24 md:w-52 md:shrink-0 md:self-start">
        <p className="mb-3 hidden truncate px-3 text-sm text-muted md:block">{user.name}</p>
        <nav ref={navRef} aria-label="Разделы кабинета" className="scrollbar-none -mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
          <ul className="flex gap-1 md:flex-col">
            {SECTIONS.map(({ to, label, icon: Icon, end }) => (
              <li key={to} className="shrink-0">
                <NavLink
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    cn(
                      'flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm whitespace-nowrap transition-colors',
                      isActive ? 'bg-accent-soft font-medium text-accent-text' : 'text-muted hover:bg-surface-2 hover:text-ink',
                    )
                  }
                >
                  <Icon size={16} aria-hidden /> {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  )
}
