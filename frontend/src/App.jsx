import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { AuthProvider } from './auth/AuthProvider.jsx'
import { RequireAuth } from './auth/RequireAuth.jsx'
import { ToastProvider } from './components/Toast.jsx'
import { LoginPage, RegisterPage } from './pages/AuthPages.jsx'
import { BookPage } from './pages/BookPage.jsx'
import { HomePage } from './pages/HomePage.jsx'
import { Layout } from './pages/Layout.jsx'
import { OnboardingPage } from './pages/OnboardingPage.jsx'
import { Placeholder } from './pages/Placeholder.jsx'
import { SearchPage } from './pages/SearchPage.jsx'
import { ThemeProvider } from './theme/ThemeProvider.jsx'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      // Ошибки клиента (404, 400, 401) повторять бессмысленно; сеть и 5xx — ещё пару раз
      retry: (count, error) => !(error?.status >= 400 && error?.status < 500) && count < 2,
    },
  },
})

const stub = (title, text, soon) => ({ element: <Placeholder title={title} soon={soon}>{text}</Placeholder> })

// Экраны из решения.md, раздел 2. Кабинет (/me/*) пока заглушки
const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'book/:id', element: <BookPage /> },
      { path: 'search', element: <SearchPage /> },
      { path: 'login', element: <LoginPage /> },
      { path: 'register', element: <RegisterPage /> },
      // Только после входа: без него — на /login с возвратом обратно
      {
        element: <RequireAuth />,
        children: [
          { path: 'onboarding', element: <OnboardingPage /> },
          {
            path: 'me',
            children: [
              { index: true, ...stub('Мои полки', 'Хочу прочитать, Читаю, Прочитал.') },
              { path: 'ratings', ...stub('Мои оценки') },
              { path: 'taste', ...stub('Профиль вкусов', 'Что система думает о ваших интересах.') },
              { path: 'hidden', ...stub('Скрытые книги', 'Всё, что вы отметили «Не интересно».') },
              { path: 'stats', ...stub('Статистика чтения') },
              { path: 'settings', ...stub('Профиль и аккаунт') },
            ],
          },
        ],
      },
      { path: '*', ...stub('Страница не найдена', 'Такой страницы нет.', false) },
    ],
  },
])

export default function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  )
}
