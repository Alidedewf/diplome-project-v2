import { cn } from '../lib/format.js'

// Полоска-заглушка высотой ровно в строку текста: шрифт и межстрочный интервал берёт у родителя,
// поэтому скелет занимает столько же места, сколько потом займёт текст, и ряды не прыгают
export function SkeletonLine({ className }) {
  return (
    <span className="flex h-[1lh] items-center" aria-hidden>
      <span className={cn('h-[0.7em] rounded bg-surface-2', className)} />
    </span>
  )
}
