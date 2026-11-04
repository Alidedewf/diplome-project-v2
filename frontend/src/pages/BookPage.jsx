import { BookCheck, BookMarked, BookOpen, ChevronRight, EyeOff, Undo2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { track, trackRecClick } from '../api/events.js'
import { useBook, useBookAction, useSimilarBooks } from '../api/queries.js'
import { loginPath, useAuth } from '../auth/context.js'
import { BookCover } from '../components/BookCover.jsx'
import { BookShelf } from '../components/BookShelf.jsx'
import { Button } from '../components/Button.jsx'
import { Chip } from '../components/Chip.jsx'
import { OriginChip } from '../components/OriginChip.jsx'
import { RatingStars } from '../components/RatingStars.jsx'
import { WhyRecommended } from '../components/WhyRecommended.jsx'
import { useToast } from '../components/toast-context.js'
import { formatCount, RATINGS } from '../lib/format.js'
import { sectionLabel, subsectionLabel } from '../lib/sections.js'
import { hasRatings } from '../lib/bookNames.js'
import { useBookNames, useReadsRussian } from '../lib/useBookNames.js'
import { Placeholder } from './Placeholder.jsx'

// Три фиксированные полки (2.2)
const SHELVES = [
  { id: 'want', label: 'Хочу прочитать', icon: BookMarked },
  { id: 'reading', label: 'Читаю', icon: BookOpen },
  { id: 'read', label: 'Прочитал', icon: BookCheck },
]

// Оценка, полки и «Не интересно» — настоящие запросы; интерфейс меняется сразу, при ошибке откатывается.
// Гостю кнопки видны, но ведут на вход с возвратом на эту книгу (2.2)
function UserActions({ book }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const action = useBookAction(book.id, { onError: (message) => toast(`Не удалось сохранить: ${message}`) })
  const my = book.my ?? { rating: null, shelf: null, hidden: false }

  const run = (kind, value) => {
    if (!user) return navigate(loginPath(location))
    action.mutate({ kind, value })
  }

  if (my.hidden) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm">
        <EyeOff size={16} className="text-muted" />
        <span className="flex-1">Книга скрыта — она не появится в рекомендациях и подборках.</span>
        <Button size="sm" variant="ghost" onClick={() => run('hidden', false)}>
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
            variant={my.shelf === id ? 'selected' : 'secondary'}
            aria-pressed={my.shelf === id}
            className="flex-1 sm:flex-none"
            onClick={() => run('shelf', my.shelf === id ? null : id)}
          >
            <Icon size={16} /> {label}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted">Ваша оценка</span>
          <RatingStars value={my.rating} onChange={(value) => run('rating', value)} size={22} />
        </div>
        <Button size="sm" variant="ghost" className="-ml-3 sm:ml-0" onClick={() => run('hidden', true)}>
          <EyeOff size={15} /> Не интересно
        </Button>
      </div>
      {!user && (
        <p className="text-sm text-muted">
          <Link to={loginPath(location)} className="font-medium text-accent-text hover:underline">
            Войдите
          </Link>
          , чтобы ставить оценки и собирать полки.
        </p>
      )}
    </div>
  )
}

// Длинный текст свёрнут до 6 строк с «Читать дальше». В русских описаниях (Википедия) абзацы сохраняем,
// в английских аннотациях Amazon переводы строк случайные — их нет
function Clamped({ text, lang, className }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 420
  return (
    <>
      <p
        lang={lang}
        className={`max-w-prose leading-relaxed ${lang === 'en' ? '' : 'whitespace-pre-line'} ${long && !open ? 'line-clamp-6' : ''} ${className ?? 'text-ink/90'}`}
      >
        {text}
      </p>
      {long && (
        <button type="button" className="text-sm font-medium text-accent-text hover:underline" onClick={() => setOpen(!open)}>
          {open ? 'Свернуть' : 'Читать дальше'}
        </button>
      )}
    </>
  )
}

// Русское описание (2.8, п. 5) — читающим по-русски, если есть: начало статьи Википедии (CC BY-SA — подпись
// со ссылкой на статью) или машинный перевод аннотации. Английская аннотация — по ссылке «Оригинальное описание»
// У своих русских и казахских книг (1.5) annotation уже по-русски (и у казахских тоже — из русской Википедии),
// annotationRu — тот же текст: подпись источника показываем, «Оригинальное описание» — нет
const annotationLang = (book) => (!book.source || book.source === 'amazon' ? 'en' : undefined)

function Annotation({ book }) {
  const ru = useReadsRussian()
  const [original, setOriginal] = useState(false)
  const translated = ru && book.annotationRu && book.annotationRu !== book.annotation ? book.annotationRu : null
  const text = translated ?? book.annotation
  if (!text) return null
  const source = translated || (book.source && book.source !== 'amazon') ? book.annotationSource : null
  if (!translated && !source) {
    return (
      <div className="flex flex-col items-start gap-2">
        <h2 className="text-lg font-semibold">Аннотация</h2>
        <Clamped text={text} lang={annotationLang(book)} />
      </div>
    )
  }
  return (
    <div className="flex flex-col items-start gap-2">
      <h2 className="text-lg font-semibold">Аннотация</h2>
      <Clamped text={text} lang={translated ? undefined : annotationLang(book)} />
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        {source === 'wikipedia' ? (
          <span>
            Описание:{' '}
            {book.annotationUrl ? (
              <a href={book.annotationUrl} target="_blank" rel="noopener noreferrer" className="underline decoration-muted/50 hover:text-ink">
                Википедия
              </a>
            ) : (
              'Википедия'
            )}
          </span>
        ) : (
          source === 'mt' && <span>Машинный перевод</span>
        )}
        {translated && book.annotation && (
          <button type="button" aria-expanded={original} className="font-medium text-accent-text hover:underline" onClick={() => setOriginal(!original)}>
            {original ? 'Скрыть оригинал' : 'Оригинальное описание'}
          </button>
        )}
      </p>
      {original && (
        <div className="mt-1 flex flex-col items-start gap-2 border-l-2 border-line pl-4">
          <Clamped text={book.annotation} lang={annotationLang(book)} className="text-sm text-muted" />
        </div>
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

// Сигнал view — один раз на открытие карточки: перерисовки и повторные загрузки той же книги его не дублируют
function useViewEvent(bookId) {
  const { user } = useAuth()
  const sent = useRef(null)
  useEffect(() => {
    if (!user || !bookId || sent.current === bookId) return
    sent.current = bookId
    track({ type: 'view', bookId })
  }, [user, bookId])
}

export function BookPage() {
  const { id } = useParams()
  const { data: book, isPending, error } = useBook(id)
  const similar = useSimilarBooks(id)
  useViewEvent(book?.id)
  const names = useBookNames(book)

  if (isPending) return <BookPageSkeleton />
  if (error) {
    if (error.status === 404) {
      return <Placeholder title="Книга не найдена" soon={false}>Возможно, ссылка устарела или книги нет в каталоге.</Placeholder>
    }
    return <Placeholder title="Не удалось загрузить книгу" soon={false}>{error.message}</Placeholder>
  }

  return (
    <div className="flex flex-col gap-14">
      {/* key — при переходе на другую книгу сбрасываются полка, оценка и раскрытая аннотация */}
      <article key={book.id} className="flex flex-col gap-8 md:flex-row md:gap-10">
        <BookCover book={book} eager className="mx-auto w-44 shrink-0 self-start sm:w-56 md:mx-0 md:w-64" />

        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <nav aria-label="Раздел" className="flex flex-wrap items-center gap-1 text-sm text-muted">
            {book.section && <span>{sectionLabel(book.section)}</span>}
            {book.section && book.subsection && (
              <>
                <ChevronRight size={14} aria-hidden />
                <span>{subsectionLabel(book.subsection, book.section)}</span>
              </>
            )}
            <OriginChip book={book} className={book.section ? 'ml-2' : undefined} />
          </nav>

          <header className="-mt-3 flex flex-col gap-2">
            <h1 lang={names.titleLang} className="text-3xl leading-tight font-semibold text-balance sm:text-4xl">
              {names.title}
            </h1>
            {/* русское название — крупно, оригинал под ним (5.6) */}
            {names.originalTitle && (
              <p lang={names.originalLang} className="-mt-1 font-serif text-lg text-muted">
                {names.originalTitle}
              </p>
            )}
            <p className="text-lg">
              {names.author ? <span lang={names.authorLang}>{names.author}</span> : <span className="text-muted">Автор не указан</span>}
              {names.originalAuthor && (
                <span lang={names.originalLang} className="text-muted">
                  {' '}
                  ({names.originalAuthor})
                </span>
              )}
              {book.year && <span className="text-muted"> · {book.year}</span>}
            </p>
          </header>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {hasRatings(book) ? (
              <>
                <RatingStars value={book.rating} size={18} />
                <span className="font-serif text-lg font-semibold">{book.rating.toFixed(1)}</span>
                <span className="text-sm text-muted">{formatCount(book.ratingsCount, RATINGS)}</span>
              </>
            ) : (
              <span className="text-sm text-muted">Оценок пока нет — ваша будет первой</span>
            )}
          </div>

          <UserActions book={book} />

          <WhyRecommended reason={book.recommendation} />

          <Annotation book={book} />

          <div className="flex flex-wrap gap-2">
            {book.section && <Chip>{sectionLabel(book.section)}</Chip>}
            {book.subsection && <Chip>{subsectionLabel(book.subsection, book.section)}</Chip>}
          </div>
        </div>
      </article>

      <BookShelf
        title="Похожие книги"
        subtitle="Близкие по содержанию и теме"
        items={similar.data}
        loading={similar.isPending}
        error={similar.error}
        onOpen={(other) => trackRecClick(other, { kind: 'similar', seedId: book.id }, 'similar')}
      />
    </div>
  )
}
