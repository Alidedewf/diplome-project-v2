import { SearchX, SlidersHorizontal } from 'lucide-react'
import { useId } from 'react'
import { useSearchParams } from 'react-router'
import { useSearch, useSections } from '../api/queries.js'
import { useAuth } from '../auth/context.js'
import { BookCard, BookCardSkeleton } from '../components/BookCard.jsx'
import { Button } from '../components/Button.jsx'
import { Spinner } from '../components/Spinner.jsx'
import { formatCount } from '../lib/format.js'
import { sectionLabel } from '../lib/sections.js'

// Годы в каталоге — 1900–2023; диапазон уходит в API как «2010-2014»
const YEARS = [
  ['', 'Любой год'],
  ['2020-2023', '2020–2023'],
  ['2015-2019', '2015–2019'],
  ['2010-2014', '2010–2014'],
  ['2000-2009', '2000–2009'],
  ['1900-1999', 'До 2000'],
]
const RATINGS = [
  ['', 'Любая оценка'],
  ['4.5', 'От 4,5'],
  ['4', 'От 4'],
  ['3.5', 'От 3,5'],
]
const BOOKS = { one: 'книга', few: 'книги', many: 'книг' }
const FILTERS = ['section', 'year', 'rating', 'hideRead']

function Select({ label, value, onChange, options }) {
  const id = useId()
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 min-w-0 rounded-lg border border-line bg-surface px-3 text-sm outline-none focus:border-accent"
      >
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </div>
  )
}

const GRID = 'grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6'

export function SearchPage() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const q = params.get('q')?.trim() ?? ''
  const filters = Object.fromEntries(FILTERS.map((k) => [k, params.get(k) ?? '']))
  const sections = useSections()
  const search = useSearch({ q, ...filters, hideRead: user && filters.hideRead === '1' })

  const setFilter = (key, value) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }
  const hasFilters = FILTERS.some((k) => filters[k])

  if (!q) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
        <h1 className="text-2xl font-semibold">Поиск книг</h1>
        <p className="text-muted">Введите в строке поиска название, автора или ISBN.</p>
      </div>
    )
  }

  const pages = search.data?.pages ?? []
  const items = pages.flatMap((p) => p.items)
  const total = pages[0]?.total ?? 0
  const fuzzy = pages[0]?.fuzzy

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold sm:text-3xl">
          Результаты по запросу «<span lang="en">{q}</span>»
        </h1>
        <p className="text-sm text-muted" aria-live="polite">
          {search.isPending ? 'Ищем…' : search.error ? '' : `Найдено ${formatCount(total, BOOKS)}`}
          {fuzzy && ' · точных совпадений мало, показываем похожие по написанию'}
        </p>
      </header>

      <section aria-label="Фильтры" className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          <SlidersHorizontal size={16} className="text-muted" aria-hidden /> Фильтры
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Select
            label="Раздел"
            value={filters.section}
            onChange={(v) => setFilter('section', v)}
            options={[['', 'Все разделы'], ...(sections.data ?? []).map((s) => [s.name, sectionLabel(s.name)])]}
          />
          <Select label="Год издания" value={filters.year} onChange={(v) => setFilter('year', v)} options={YEARS} />
          <Select label="Оценка читателей" value={filters.rating} onChange={(v) => setFilter('rating', v)} options={RATINGS} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={filters.hideRead === '1'}
              disabled={!user}
              onChange={(e) => setFilter('hideRead', e.target.checked ? '1' : '')}
              className="size-4 accent-accent"
            />
            Скрыть прочитанные
            {!user && <span className="text-xs text-muted">(после входа)</span>}
          </label>
          {hasFilters && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setParams(new URLSearchParams({ q }), { replace: true })}
            >
              Сбросить фильтры
            </Button>
          )}
        </div>
      </section>

      {search.error ? (
        <p role="alert" className="text-muted">
          {search.error.message}
        </p>
      ) : search.isPending ? (
        <div className={GRID}>
          {Array.from({ length: 12 }, (_, i) => (
            <BookCardSkeleton key={i} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-12 text-center text-muted">
          <SearchX size={28} aria-hidden />
          <p>Ничего не нашлось{hasFilters ? ' — попробуйте ослабить фильтры' : ''}.</p>
        </div>
      ) : (
        <>
          <div className={GRID} style={{ opacity: search.isPlaceholderData ? 0.6 : 1 }}>
            {items.map((book) => (
              <BookCard key={book.id} book={book} />
            ))}
          </div>
          <div className="flex flex-col items-center gap-2">
            <p className="text-sm text-muted">
              Показано {items.length} из {total}
            </p>
            {search.hasNextPage &&
              (search.isFetchingNextPage ? (
                <Spinner />
              ) : (
                <Button onClick={() => search.fetchNextPage()}>Показать ещё</Button>
              ))}
          </div>
        </>
      )}
    </div>
  )
}
