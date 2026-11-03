import { Construction } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '../components/Button.jsx'

// Заглушка для экранов, которые ещё не сделаны. children — что будет на экране; soon={false} — для 404
export function Placeholder({ title, children, soon = true }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-muted">
        <Construction size={22} />
      </span>
      <h1 className="text-2xl font-semibold sm:text-3xl">{title}</h1>
      <div className="flex flex-col gap-1 text-muted">
        {children && <p>{children}</p>}
        {soon && <p>Этот экран появится на следующих шагах.</p>}
      </div>
      <Button as={Link} to="/" variant="secondary">
        На главную
      </Button>
    </div>
  )
}
