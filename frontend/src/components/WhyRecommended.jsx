import { Sparkles } from 'lucide-react'
import { cn } from '../lib/format.js'

// Фирменная плашка «почему рекомендовано» (5.1). compact — строка под карточкой книги в ленте
export function WhyRecommended({ reason, compact = false, className }) {
  if (!reason) return null

  if (compact) {
    return (
      <p className={cn('flex min-h-[2lh] gap-1.5 text-xs leading-snug text-smart-text', className)} title={reason.text}>
        <Sparkles size={13} className="mt-px shrink-0 text-smart" aria-hidden />
        <span className="line-clamp-2">{reason.text}</span>
      </p>
    )
  }

  return (
    <div className={cn('flex gap-3 rounded-lg bg-smart-soft px-4 py-3', className)}>
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-smart text-paper">
        <Sparkles size={14} aria-hidden />
      </span>
      <div className="text-sm leading-relaxed">
        <p className="font-medium text-smart-text">Почему рекомендовано</p>
        <p className="text-ink">{reason.text}</p>
      </div>
    </div>
  )
}
