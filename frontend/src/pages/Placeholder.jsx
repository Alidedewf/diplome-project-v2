import { Construction } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '../components/Button.jsx'

// Заглушка для экранов, которые ещё не сделаны
export function Placeholder({ title, children }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-muted">
        <Construction size={22} />
      </span>
      <h1 className="text-2xl font-semibold sm:text-3xl">{title}</h1>
      <p className="text-muted">{children ?? 'Этот экран появится на следующих шагах.'}</p>
      <Button as={Link} to="/" variant="secondary">
        На главную
      </Button>
    </div>
  )
}
