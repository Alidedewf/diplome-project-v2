import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../lib/format.js'
import { BookCard, BookCardSkeleton } from './BookCard.jsx'
import { Button } from './Button.jsx'

const ITEM_WIDTH = 'w-[132px] sm:w-[148px] lg:w-[160px]'

// Горизонтальный ряд книг. items — Book[] или [{ book, reason }]; children — панель между заголовком и рядом (фильтры).
// withReasons — в ряду будут плашки «почему»: скелет заранее держит под них место
export function BookShelf({ title, subtitle, action, items, withReasons = false, loading = false, error, className, children }) {
  const rowRef = useRef(null)
  // Стрелки неактивны на краях ряда; пока ряда нет (загрузка, ошибка, пусто) — обе неактивны
  const [edges, setEdges] = useState({ start: true, end: true })
  const updateEdges = useCallback(() => {
    const row = rowRef.current
    const start = !row || row.scrollLeft <= 1
    const end = !row || row.scrollLeft + row.clientWidth >= row.scrollWidth - 1
    setEdges((e) => (e.start === start && e.end === end ? e : { start, end }))
  }, [])

  const scroll = (dir) => {
    const row = rowRef.current
    row?.scrollBy({ left: dir * row.clientWidth * 0.85, behavior: 'smooth' })
  }

  const entries = (items ?? []).map((it) => (it.book ? it : { book: it, reason: null }))

  useEffect(() => {
    updateEdges()
    const row = rowRef.current
    if (!row) return
    const observer = new ResizeObserver(updateEdges)
    observer.observe(row)
    return () => observer.disconnect()
  }, [updateEdges, entries.length, loading, error])

  return (
    <section className={cn('flex flex-col gap-4', className)}>
      <header className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-xl leading-tight font-semibold sm:text-2xl">{title}</h2>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {action}
          <div className="hidden gap-1 md:flex">
            <Button variant="ghost" size="icon" className="size-8" aria-label="Прокрутить назад" disabled={loading || edges.start} onClick={() => scroll(-1)}>
              <ChevronLeft size={18} />
            </Button>
            <Button variant="ghost" size="icon" className="size-8" aria-label="Прокрутить вперёд" disabled={loading || edges.end} onClick={() => scroll(1)}>
              <ChevronRight size={18} />
            </Button>
          </div>
        </div>
      </header>

      {children}

      {error ? (
        <p className="text-sm text-muted">Не удалось загрузить подборку. {error.message}</p>
      ) : !loading && entries.length === 0 ? (
        <p className="text-sm text-muted">Здесь пока пусто.</p>
      ) : (
        <div
          ref={rowRef}
          onScroll={updateEdges}
          className="scrollbar-none -mx-4 flex snap-x scroll-px-4 gap-4 overflow-x-auto px-4 pt-1 pb-2 sm:gap-5"
        >
          {loading
            ? Array.from({ length: 8 }, (_, i) => (
                <BookCardSkeleton key={i} withReason={withReasons} className={cn(ITEM_WIDTH, 'shrink-0')} />
              ))
            : entries.map(({ book, reason }) => (
                <BookCard key={book.id} book={book} reason={reason} className={cn(ITEM_WIDTH, 'shrink-0 snap-start')} />
              ))}
        </div>
      )}
    </section>
  )
}
