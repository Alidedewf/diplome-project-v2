import { BookCheck, BookMarked, BookOpen, X } from 'lucide-react'
import { useId } from 'react'
import { useSearchParams } from 'react-router'
import { useBookAction, useMyShelf } from '../../api/queries.js'
import { Button } from '../../components/Button.jsx'
import { RatingStars } from '../../components/RatingStars.jsx'
import { useToast } from '../../components/toast-context.js'
import { cn } from '../../lib/format.js'
import { BookList, EmptyLinks, EmptyState, MyBookCard, PageHeader } from './parts.jsx'
import { useScrollToActive } from './useScrollToActive.js'

// Три фиксированные полки (2.2)
const SHELVES = [
  { id: 'want', label: 'Хочу прочитать', icon: BookMarked, empty: 'Отмечайте книги, до которых хотите добраться, — кнопкой «Хочу прочитать» на странице книги.' },
  { id: 'reading', label: 'Читаю', icon: BookOpen, empty: 'Здесь будут книги, которые вы читаете сейчас.' },
  { id: 'read', label: 'Прочитал', icon: BookCheck, empty: 'Прочитанные книги и книги с вашей оценкой попадут сюда. Чем больше оценок, тем точнее подборки.' },
]

function ShelfBook({ item, shelf }) {
  const toast = useToast()
  const action = useBookAction(item.book.id, { onError: (message) => toast(`Не удалось сохранить: ${message}`) })
  const selectId = useId()
  return (
    <MyBookCard book={item.book}>
      <label htmlFor={selectId} className="sr-only">
        Полка
      </label>
      <select
        id={selectId}
        value={item.shelf}
        onChange={(e) => action.mutate({ kind: 'shelf', value: e.target.value })}
        className="h-8 rounded-lg border border-line bg-surface px-2 text-sm outline-none focus:border-accent"
      >
        {SHELVES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      <Button size="sm" variant="ghost" onClick={() => action.mutate({ kind: 'shelf', value: null })} aria-label={`Убрать с полки «${item.book.title}»`}>
        <X size={15} aria-hidden /> Убрать
      </Button>
      {shelf === 'read' && (
        <RatingStars value={item.rating} onChange={(value) => action.mutate({ kind: 'rating', value })} size={18} className="w-full" />
      )}
    </MyBookCard>
  )
}

export function ShelvesPage() {
  const [params, setParams] = useSearchParams()
  const shelf = SHELVES.some((s) => s.id === params.get('shelf')) ? params.get('shelf') : 'want'
  const query = useMyShelf(shelf)
  const counts = query.data?.pages[0]?.counts
  const current = SHELVES.find((s) => s.id === shelf)
  const tabsRef = useScrollToActive(shelf, '[aria-selected=true]')

  return (
    <>
      <PageHeader title="Мои полки" subtitle="Полки помогают системе: «Хочу прочитать» — слабый интерес, «Прочитал» с высокой оценкой — сильный." />

      <div ref={tabsRef} role="tablist" aria-label="Полки" className="scrollbar-none -mx-4 mb-5 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
        {SHELVES.map(({ id, label, icon: Icon }) => {
          const on = id === shelf
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setParams(id === 'want' ? {} : { shelf: id }, { replace: true })}
              className={cn(
                '-mb-px flex h-11 shrink-0 items-center gap-2 border-b-2 px-3 text-sm whitespace-nowrap transition-colors',
                on ? 'border-accent font-medium text-ink' : 'border-transparent text-muted hover:text-ink',
              )}
            >
              <Icon size={16} aria-hidden /> {label}
              <span className={cn('min-w-6 rounded-full px-1.5 text-center text-xs tabular-nums', on ? 'bg-accent-soft text-accent-text' : 'bg-surface-2')}>
                {counts ? counts[id] : '·'}
              </span>
            </button>
          )
        })}
      </div>

      <div role="tabpanel" aria-label={current.label}>
        <BookList
          query={query}
          renderItem={(item) => <ShelfBook key={item.book.id} item={item} shelf={shelf} />}
          empty={
            <EmptyState icon={current.icon} title={`На полке «${current.label}» пока пусто`} actions={<EmptyLinks />}>
              {current.empty}
            </EmptyState>
          }
        />
      </div>
    </>
  )
}
