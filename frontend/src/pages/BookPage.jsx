import { BookCheck, BookMarked, BookOpen, ChevronRight, EyeOff, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router'
import { useBook, useSimilarBooks } from '../api/queries.js'
import { BookCover } from '../components/BookCover.jsx'
import { BookShelf } from '../components/BookShelf.jsx'
import { Button } from '../components/Button.jsx'
import { Chip } from '../components/Chip.jsx'
import { RatingStars } from '../components/RatingStars.jsx'
import { WhyRecommended } from '../components/WhyRecommended.jsx'
import { formatCount, RATINGS } from '../lib/format.js'
import { sectionLabel } from '../lib/sections.js'
import { Placeholder } from './Placeholder.jsx'

// Три фиксированные полки (2.2)
const SHELVES = [
  { id: 'want', label: 'Хочу прочитать', icon: BookMarked },
  { id: 'reading', label: 'Читаю', icon: BookOpen },
  { id: 'read', label: 'Прочитал', icon: BookCheck },
]

// Полка, оценка и «Не интересно» пока живут в состоянии страницы — сохранение появится вместе с API кабинета
function UserActions() {
  const [shelf, setShelf] = useState(null)
  const [myRating, setMyRating] = useState(null)
  const [hidden, setHidden] = useState(false)

  const rate = (value) => {
    setMyRating(value)
    if (value) setShelf('read')
  }

  if (hidden) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm">
        <EyeOff size={16} className="text-muted" />
        <span className="flex-1">Книга скрыта — она не появится в рекомендациях и подборках.</span>
        <Button size="sm" variant="ghost" onClick={() => setHidden(false)}>
          <Undo2 size={15} /> Вернуть
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {SHELVES.map(({ id, label, icon: Icon }) => (
          <Button
            key={id}
            variant={shelf === id ? 'selected' : 'secondary'}
            aria-pressed={shelf === id}
            className="flex-1 sm:flex-none"
            onClick={() => setShelf(shelf === id ? null : id)}
          >
            <Icon size={16} /> {label}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted">Ваша оценка</span>
          <RatingStars value={myRating} onChange={rate} size={22} />
        </div>
        <Button size="sm" variant="ghost" className="-ml-3 sm:ml-0" onClick={() => setHidden(true)}>
          <EyeOff size={15} /> Не интересно
        </Button>
      </div>
    </div>
  )
}

function Annotation({ text }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 420
  return (
    <div className="flex flex-col items-start gap-2">
      <h2 className="text-lg font-semibold">Аннотация</h2>
      <p lang="en" className={`max-w-prose leading-relaxed text-ink/90 ${long && !open ? 'line-clamp-6' : ''}`}>
        {text}
      </p>
      {long && (
        <button type="button" className="text-sm font-medium text-accent-text hover:underline" onClick={() => setOpen(!open)}>
          {open ? 'Свернуть' : 'Читать дальше'}
        </button>
      )}
    </div>
  )
}

function BookPageSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-8 md:flex-row" aria-busy>
      <div className="mx-auto aspect-[2/3] w-44 rounded-cover bg-surface-2 sm:w-56 md:mx-0 md:w-64" />
      <div className="flex flex-1 flex-col gap-4">
        <div className="h-9 w-3/4 rounded bg-surface-2" />
        <div className="h-5 w-1/3 rounded bg-surface-2" />
        <div className="h-24 rounded bg-surface-2" />
      </div>
    </div>
  )
}

export function BookPage() {
  const { id } = useParams()
  const { data: book, isPending, error } = useBook(id)
  const similar = useSimilarBooks(id)

  if (isPending) return <BookPageSkeleton />
  if (error) {
    return <Placeholder title="Книга не найдена">Возможно, ссылка устарела или книги нет в каталоге.</Placeholder>
  }

  return (
    <div className="flex flex-col gap-14">
      {/* key — при переходе на другую книгу сбрасываются полка, оценка и раскрытая аннотация */}
      <article key={book.id} className="flex flex-col gap-8 md:flex-row md:gap-10">
        <BookCover book={book} eager className="mx-auto w-44 shrink-0 self-start sm:w-56 md:mx-0 md:w-64" />

        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <nav aria-label="Раздел" className="flex flex-wrap items-center gap-1 text-sm text-muted">
            <span>{sectionLabel(book.section)}</span>
            {book.subsection && (
              <>
                <ChevronRight size={14} aria-hidden />
                <span lang="en">{book.subsection}</span>
              </>
            )}
          </nav>

          <header className="-mt-3 flex flex-col gap-2">
            <h1 lang="en" className="text-3xl leading-tight font-semibold text-balance sm:text-4xl">
              {book.title}
            </h1>
            <p className="text-lg">
              <span lang="en">{book.author}</span>
              {book.year && <span className="text-muted"> · {book.year}</span>}
            </p>
          </header>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <RatingStars value={book.rating} size={18} />
            <span className="font-serif text-lg font-semibold">{book.rating.toFixed(1)}</span>
            <span className="text-sm text-muted">{formatCount(book.ratingsCount, RATINGS)}</span>
          </div>

          <UserActions />

          <WhyRecommended reason={book.recommendation} />

          <Annotation text={book.annotation} />

          <div className="flex flex-wrap gap-2">
            <Chip>{sectionLabel(book.section)}</Chip>
            {book.subsection && <Chip lang="en">{book.subsection}</Chip>}
          </div>
        </div>
      </article>

      <BookShelf
        title="Похожие книги"
        subtitle="Близкие по содержанию и теме"
        items={similar.data}
        loading={similar.isPending}
        error={similar.error}
      />
    </div>
  )
}
