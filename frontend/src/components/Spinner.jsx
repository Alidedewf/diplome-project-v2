import { LoaderCircle } from 'lucide-react'
import { cn } from '../lib/format.js'

export function Spinner({ className, label = 'Загрузка…' }) {
  return (
    <div className={cn('flex justify-center text-muted', className)} role="status">
      <LoaderCircle size={24} className="animate-spin" aria-hidden />
      <span className="sr-only">{label}</span>
    </div>
  )
}
