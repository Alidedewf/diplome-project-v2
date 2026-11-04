import { cn } from '../lib/format.js'

// Пометка языка оригинала у своих русских и казахских книг (1.5). У книг Amazon (английских) — ничего
const ORIGIN = {
  ru: { label: 'На русском', title: 'Книга на русском языке' },
  kz: { label: 'Қазақша', lang: 'kk', hint: 'на казахском', title: 'Книга на казахском языке' },
}

// overlay — коротко, на обложке в рядах; иначе — чип с пояснением по-русски («Қазақша · на казахском»)
export function OriginChip({ book, overlay = false, className }) {
  const origin = ORIGIN[book?.source]
  if (!origin) return null
  return (
    <span
      title={origin.title}
      className={cn(
        'inline-flex items-center rounded-full font-medium whitespace-nowrap',
        overlay
          ? 'bg-paper/90 px-2 py-0.5 text-[0.7rem] text-ink shadow-sm backdrop-blur'
          : 'border border-accent/40 bg-accent-soft px-2.5 py-0.5 text-xs text-accent-text',
        className,
      )}
    >
      <span lang={origin.lang}>{origin.label}</span>
      {origin.hint && (overlay ? <span className="sr-only"> — {origin.hint}</span> : <span>&nbsp;· {origin.hint}</span>)}
    </span>
  )
}
