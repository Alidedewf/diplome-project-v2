import { CircleAlert, X } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { ToastContext } from './toast-context.js'

// Короткие сообщения об ошибках внизу экрана (например, оценка не сохранилась и откатилась)
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const dismiss = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), [])
  const show = useCallback(
    (message) => {
      const id = Date.now() + Math.random()
      setToasts((list) => [...list.slice(-2), { id, message }])
      setTimeout(() => dismiss(id), 5000)
    },
    [dismiss],
  )
  const value = useMemo(() => show, [show])

  return (
    <ToastContext value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm shadow-lg"
          >
            <CircleAlert size={18} className="mt-px shrink-0 text-smart" aria-hidden />
            <p className="flex-1">{t.message}</p>
            <button type="button" className="text-muted hover:text-ink" aria-label="Закрыть" onClick={() => dismiss(t.id)}>
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext>
  )
}
