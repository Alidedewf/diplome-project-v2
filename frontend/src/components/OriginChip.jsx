import { bookLanguage } from '../lib/bookNames.js'
import { cn } from '../lib/format.js'

// Пометка языка оригинала у своих русских и казахских книг (1.5). У книг Amazon (английских) — ничего.
// Язык — по originalLanguage (в «казахской литературе» есть русскоязычные книги), иначе по source
const ORIGIN = {
  ru: { label: 'На русском', title: 'Книга на русском языке' },
  kk: { label: 'Қазақша', lang: 'kk', hint: 'на казахском', title: 'Книга на казахском языке' },
}

// Слот своего каталога в «Для вас» (3.8, 4.11) — по каталогу книги, а не по reason (у бэкенда source в нём не обязателен)
const SLOT = {
  ru: { label: 'Русская литература', title: 'Из нашего каталога русских книг' },
  kz: { label: 'Казахская литература', title: 'Из нашего каталога казахских книг' },
}

// overlay — коротко, на обложке в рядах; иначе — чип с пояснением по-русски («Қазақша · на казахском»).
// slot — книга своего каталога среди рекомендаций «Для вас»: вместо языка — откуда она
export function OriginChip({ book, overlay = false, slot = false, className }) {
  const own = book?.source && book.source !== 'amazon'
  const origin = own ? (slot && SLOT[book.source]) || ORIGIN[bookLanguage(book)] : null
  if (!origin) return null
  return (
    <span
      title={origin.title}
      className={cn(
        'inline-flex items-center font-medium',
        // на узкой обложке (132 px) «Казахская литература» не влезает в строку — переносится на вторую
        overlay
          ? 'max-w-full rounded-[0.7rem] bg-paper/90 px-2 py-0.5 text-[0.7rem] leading-tight text-ink shadow-sm backdrop-blur'
          : 'rounded-full border border-accent/40 bg-accent-soft px-2.5 py-0.5 text-xs whitespace-nowrap text-accent-text',
        className,
      )}
    >
      <span lang={origin.lang}>{origin.label}</span>
      {origin.hint && (overlay ? <span className="sr-only"> — {origin.hint}</span> : <span>&nbsp;· {origin.hint}</span>)}
    </span>
  )
}
