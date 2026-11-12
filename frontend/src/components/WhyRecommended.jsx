import { Sparkles } from 'lucide-react'
import { Link } from 'react-router'
import { cn } from '../lib/format.js'
import { reasonParts } from '../lib/reasons.js'
import { useReader } from '../lib/useBookNames.js'

// Подпись по частям: название книги-зерна — ссылка на её страницу
function Parts({ parts }) {
  return parts.map((p, i) =>
    typeof p === 'string' ? (
      p
    ) : (
      <Link
        key={i}
        to={`/book/${p.seed.id}`}
        className="font-medium underline decoration-current/30 underline-offset-2 hover:decoration-current"
      >
        {p.text}
      </Link>
    ),
  )
}

// Фирменная плашка «почему рекомендовано» (5.1). compact — строка под карточкой книги в ленте (короткий текст),
// иначе — плашка на странице книги (подробный). Текст — из reason.text или по типу причины (lib/reasons.js);
// book — сама рекомендованная книга (год для «Новинка … года»). Метка слота своего каталога — на обложке (OriginChip).
// reason = null — ничего, без пустого места
export function WhyRecommended({ reason, book, compact = false, className }) {
  const reader = useReader()
  const parts = reasonParts(reason, { detailed: !compact, reader, book })
  if (!parts) return null

  if (compact) {
    return (
      <p
        className={cn('flex min-h-[2lh] gap-1.5 text-xs leading-snug text-smart-text', className)}
        title={parts.map((p) => (typeof p === 'string' ? p : p.text)).join('')}
      >
        <Sparkles size={13} className="mt-px shrink-0 text-smart" aria-hidden />
        <span className="line-clamp-2">
          <Parts parts={parts} />
        </span>
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
        <p className="text-ink">
          <Parts parts={parts} />
        </p>
      </div>
    </div>
  )
}
