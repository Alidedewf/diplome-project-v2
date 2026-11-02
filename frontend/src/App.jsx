import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, RouterProvider, useSearchParams } from 'react-router'
import { BookPage } from './pages/BookPage.jsx'
import { HomePage } from './pages/HomePage.jsx'
import { Layout } from './pages/Layout.jsx'
import { Placeholder } from './pages/Placeholder.jsx'
import { ThemeProvider } from './theme/ThemeProvider.jsx'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      // 404 повторять бессмысленно — сразу показываем «не найдено»
      retry: (count, error) => error?.status !== 404 && count < 2,
    },
  },
})

function SearchStub() {
  const [params] = useSearchParams()
  const q = params.get('q')
  return (
    <Placeholder title="Поиск">
      {q ? `Запрос: «${q}». ` : ''}Обычный и смысловой поиск с фильтрами появятся на следующих шагах.
    </Placeholder>
  )
}

const stub = (title, text) => ({ element: <Placeholder title={title}>{text}</Placeholder> })

// Экраны из решения.md, раздел 2. Пока сделаны главная и карточка книги
const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'book/:id', element: <BookPage /> },
      { path: 'search', element: <SearchStub /> },
      { path: 'onboarding', ...stub('Расскажите, что вы любите читать', 'Выбор тем и книг для первых рекомендаций.') },
      { path: 'login', ...stub('Вход') },
      { path: 'register', ...stub('Регистрация') },
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
      { path: '*', ...stub('Страница не найдена', 'Такой страницы нет.') },
    ],
  },
])

export default function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  )
}
