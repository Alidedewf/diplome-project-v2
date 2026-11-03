import { Star } from 'lucide-react'
import { Link } from 'react-router'
import { cn } from '../lib/format.js'
import { BookCover } from './BookCover.jsx'
import { SkeletonLine } from './Skeleton.jsx'
import { WhyRecommended } from './WhyRecommended.jsx'

// Под название всегда отведены две строки: авторы и оценки в ряду стоят на одной линии,
// а высота карточки не зависит от длины названия
export function BookCard({ book, reason, className }) {
  return (
    <Link to={`/book/${book.id}`} className={cn('group flex flex-col gap-2', className)}>
      <BookCover book={book} className="transition-transform duration-200 group-hover:-translate-y-1" />
      <div className="flex flex-col gap-0.5">
        <h3 className="line-clamp-2 min-h-[2lh] font-serif text-[0.95rem] leading-snug font-semibold group-hover:text-accent-text">
          {book.title}
        </h3>
        {/* без автора строка остаётся — высота карточек в ряду одинаковая */}
        <p className="line-clamp-1 min-h-[1lh] text-sm text-muted">{book.author}</p>
        <p className="flex items-center gap-1 text-xs text-muted">
          <Star size={12} className="text-star" fill="currentColor" strokeWidth={0} aria-hidden />
          <span className="font-medium text-ink">{book.rating?.toFixed(1) ?? '—'}</span>
        </p>
      </div>
      <WhyRecommended reason={reason} compact />
    </Link>
  )
}

// Повторяет BookCard строка в строку (те же размеры шрифтов), поэтому после загрузки высота не меняется
export function BookCardSkeleton({ withReason = false, className }) {
  return (
    <div className={cn('flex animate-pulse flex-col gap-2', className)} aria-hidden>
      <div className="aspect-[2/3] rounded-cover bg-surface-2" />
      <div className="flex flex-col gap-0.5">
        <div className="font-serif text-[0.95rem] leading-snug">
          <SkeletonLine className="w-11/12" />
          <SkeletonLine className="w-2/3" />
        </div>
        <div className="text-sm">
          <SkeletonLine className="w-1/2" />
        </div>
        <div className="text-xs">
          <SkeletonLine className="w-8" />
        </div>
      </div>
      {withReason && (
        <div className="text-xs leading-snug">
          <SkeletonLine className="w-full" />
          <SkeletonLine className="w-3/4" />
        </div>
      )}
    </div>
  )
}
