import { Link } from 'react-router'
import { BookCover } from '../../components/BookCover.jsx'
import { Button } from '../../components/Button.jsx'
import { SkeletonLine } from '../../components/Skeleton.jsx'
import { Spinner } from '../../components/Spinner.jsx'
import { useBookNames } from '../../lib/useBookNames.js'

// Общие части экранов кабинета

export function PageHeader({ title, subtitle, action }) {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-2xl text-muted">{subtitle}</p>}
      </div>
      {action}
    </header>
  )
}

const LIST = 'grid grid-cols-1 gap-3 lg:grid-cols-2'

// Книга в списке кабинета: обложка, название, автор; children — действия под ними
export function MyBookCard({ book, meta, children }) {
  const names = useBookNames(book)
  return (
    <li className="flex gap-3 rounded-xl border border-line bg-surface p-3 sm:gap-4">
      <Link to={`/book/${book.id}`} className="w-16 shrink-0 self-start sm:w-20" tabIndex={-1} aria-hidden>
        <BookCover book={book} />
      </Link>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="min-w-0">
          <Link
            to={`/book/${book.id}`}
            lang={names.titleLang}
            className="line-clamp-2 font-serif leading-snug font-semibold hover:text-accent-text"
          >
            {names.title}
          </Link>
          {names.originalTitle && (
            <p lang={names.originalLang} className="line-clamp-1 text-xs text-muted">
              {names.originalTitle}
            </p>
          )}
          <p lang={names.author ? names.authorLang : undefined} className="line-clamp-1 text-sm text-muted">
            {names.author ?? 'Автор не указан'}
          </p>
          {meta}
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1.5">{children}</div>
      </div>
    </li>
  )
}

function CardSkeleton() {
  return (
    <li className="flex animate-pulse gap-3 rounded-xl border border-line bg-surface p-3 sm:gap-4" aria-hidden>
      <div className="aspect-[2/3] w-16 shrink-0 rounded-cover bg-surface-2 sm:w-20" />
      <div className="flex flex-1 flex-col gap-1">
        <div className="font-serif leading-snug">
          <SkeletonLine className="w-4/5" />
        </div>
        <div className="text-sm">
          <SkeletonLine className="w-1/3" />
        </div>
        <div className="mt-auto h-8 w-40 rounded-lg bg-surface-2" />
      </div>
    </li>
  )
}

// Список с «Показать ещё»; query — useInfiniteQuery, renderItem(item) → <MyBookCard/>
export function BookList({ query, renderItem, empty }) {
  if (query.error) {
    return (
      <p role="alert" className="text-muted">
        Не удалось загрузить список. {query.error.message}
      </p>
    )
  }
  const loading = query.isPending || query.isPlaceholderData
  const pages = query.data?.pages ?? []
  const items = pages.flatMap((p) => p.items)
  const total = pages[0]?.total ?? 0

  if (loading) {
    return (
      <ul className={LIST} aria-busy>
        {Array.from({ length: 4 }, (_, i) => (
          <CardSkeleton key={i} />
        ))}
      </ul>
    )
  }
  if (!items.length) return empty

  return (
    <div className="flex flex-col gap-6">
      <ul className={LIST}>{items.map(renderItem)}</ul>
      {query.hasNextPage && (
        <div className="flex flex-col items-center gap-2">
          <p className="text-sm text-muted">
            Показано {items.length} из {total}
          </p>
          {query.isFetchingNextPage ? <Spinner /> : <Button onClick={() => query.fetchNextPage()}>Показать ещё</Button>}
        </div>
      )}
    </div>
  )
}

// Пустой раздел: что здесь появится и куда пойти
export function EmptyState({ icon: Icon, title, children, actions }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line px-6 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-muted">
        <Icon size={22} aria-hidden />
      </span>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="max-w-md text-sm text-muted">{children}</p>
      {actions && <div className="mt-1 flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  )
}

export function EmptyLinks() {
  return (
    <>
      <Button as={Link} to="/" variant="primary">
        К подборкам
      </Button>
      <Button as={Link} to="/search">
        Поиск книг
      </Button>
    </>
  )
}
