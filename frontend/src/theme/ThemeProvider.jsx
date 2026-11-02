import { useCallback, useEffect, useState } from 'react'
import { ThemeContext } from './context.js'

const STORAGE_KEY = 'bookmind-theme'

// начальную тему уже выставил скрипт в index.html (до первой отрисовки)
const readTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(readTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // приватный режим — просто не запоминаем
    }
  }, [theme])

  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), [])

  return <ThemeContext value={{ theme, toggle }}>{children}</ThemeContext>
}
