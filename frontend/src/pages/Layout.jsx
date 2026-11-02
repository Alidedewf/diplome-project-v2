import { Outlet, ScrollRestoration } from 'react-router'
import { Header } from '../components/Header.jsx'

export function Layout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 pt-6 pb-16 sm:pt-8">
        <Outlet />
      </main>
      <footer className="border-t border-line">
        <p className="mx-auto max-w-[1200px] px-4 py-6 text-xs text-muted">
          BookMind — дипломный проект. Данные: Amazon Reviews 2023 (McAuley Lab), категория Books.
        </p>
      </footer>
      <ScrollRestoration />
    </div>
  )
}
