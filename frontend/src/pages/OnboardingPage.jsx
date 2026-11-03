import { useQueryClient } from '@tanstack/react-query'
import { Check, CircleAlert, CircleSlash, Heart, ThumbsDown, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { sendOnboardingAnswers } from '../api/index.js'
import { useOnboardingRound, useSections, useTaste } from '../api/queries.js'
import { useAuth } from '../auth/context.js'
import { BookAutocomplete } from '../components/BookAutocomplete.jsx'
import { BookCover } from '../components/BookCover.jsx'
import { Button } from '../components/Button.jsx'
import { Spinner } from '../components/Spinner.jsx'
import { TextField } from '../components/TextField.jsx'
import { cn, formatCount } from '../lib/format.js'
import { sectionLabel } from '../lib/sections.js'

// Онбординг (2.3, 3.4): шаг 1 — темы и описание своими словами, шаг 2 — до 3 раундов книг.
// Раунды подбирает сервер (GET /onboarding/next-round) по прежним ответам; «Пропустить» доступно всегда.
const MAX_ROUNDS = 3
const BOOKS = { one: 'книга', few: 'книги', many: 'книг' }

const ANSWERS = [
  { id: 'like', label: 'Нравится', icon: Heart, selected: 'border-accent bg-accent text-accent-fg' },
  { id: 'dislike', label: 'Не моё', icon: ThumbsDown, selected: 'border-ink/40 bg-surface-2 text-ink' },
  { id: 'unread', label: 'Не читал', icon: CircleSlash, selected: 'border-ink/40 bg-surface-2 text-ink' },
]

function Progress({ value, label }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between text-xs text-muted">
        <span>{label}</span>
        <span>{Math.round(value * 100)}%</span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value * 100)}
        aria-label="Прогресс онбординга"
      >
        <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${value * 100}%` }} />
      </div>
    </div>
  )
}

function ErrorNote({ error }) {
  if (!error) return null
  return (
    <p role="alert" className="flex items-start gap-2 rounded-lg bg-smart-soft px-3 py-2.5 text-sm text-smart-text">
      <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
      {error.message}
    </p>
  )
}

// Нижняя панель с кнопками — прилипает к низу экрана, чтобы «Дальше» было под рукой и на телефоне
function Footer({ note, children }) {
  return (
    <div className="sticky bottom-0 -mx-4 flex items-center justify-between gap-3 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur">
      <p className="text-sm text-muted">{note}</p>
      <div className="flex gap-2">{children}</div>
    </div>
  )
}

function TopicsStep({ onNext, onSkip, busy, error }) {
  const sections = useSections()
  // Вернулся в онбординг — темы, выбранные раньше, уже отмечены (пока пользователь сам их не менял)
  const taste = useTaste()
  const saved = taste.data?.items.filter((t) => t.kind === 'section' && t.source === 'onboarding').map((t) => t.value) ?? []
  const [changed, setSelected] = useState(null)
  const selected = changed ?? saved
  const [description, setDescription] = useState('')
  const toggle = (name) => setSelected(selected.includes(name) ? selected.filter((x) => x !== name) : [...selected, name])
  const loading = sections.isPending || taste.isPending

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-semibold sm:text-4xl">Что вы любите читать?</h1>
        <p className="mt-2 text-muted">Выберите хотя бы одну тему — по ним подберём первые книги.</p>
      </div>

      {sections.error ? (
        <ErrorNote error={sections.error} />
      ) : (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-3" role="group" aria-label="Темы">
          {loading
            ? Array.from({ length: 12 }, (_, i) => <div key={i} className="min-h-16 animate-pulse rounded-xl bg-surface-2" />)
            : sections.data.map((s) => {
                const on = selected.includes(s.name)
                return (
                  <button
                    key={s.name}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(s.name)}
                    className={cn(
                      'flex min-h-16 items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors sm:gap-3 sm:px-4',
                      on ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:border-muted/60',
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-5 shrink-0 items-center justify-center rounded-md border',
                        on ? 'border-accent bg-accent text-accent-fg' : 'border-line',
                      )}
                    >
                      {on && <Check size={14} strokeWidth={3} />}
                    </span>
                    <span className="min-w-0">
                      <span className="line-clamp-2 text-sm leading-tight font-medium sm:text-base">{sectionLabel(s.name)}</span>
                      <span className="mt-0.5 block text-xs text-muted">{formatCount(s.booksCount, BOOKS)}</span>
                    </span>
                  </button>
                )
              })}
        </div>
      )}

      <TextField
        multiline
        label="Опишите своими словами (необязательно)"
        hint="Например: «неспешные детективы в маленьком городке» или «как устроены деньги и рынки»"
        value={description}
        maxLength={500}
        onChange={(e) => setDescription(e.target.value)}
      />

      <ErrorNote error={error} />

      <Footer note={selected.length ? `Выбрано тем: ${selected.length}` : 'Выберите хотя бы одну тему'}>
        <Button variant="ghost" onClick={() => onSkip(selected, description.trim())} disabled={busy}>
          Пропустить
        </Button>
        <Button variant="primary" onClick={() => onNext(selected, description.trim())} disabled={busy || !selected.length}>
          Дальше
        </Button>
      </Footer>
    </div>
  )
}

function BookQuestion({ book, answer, onAnswer }) {
  return (
    <li className="flex gap-3 rounded-xl border border-line bg-surface p-3">
      <BookCover book={book} className="w-16 shrink-0 self-start sm:w-20" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="min-w-0">
          <p lang="en" className="line-clamp-2 font-serif leading-snug font-semibold">
            {book.title}
          </p>
          <p className="line-clamp-1 text-sm text-muted">{book.author}</p>
        </div>
        <div className="mt-auto flex flex-wrap gap-1.5" role="radiogroup" aria-label={`Ответ про «${book.title}»`}>
          {ANSWERS.map(({ id, label, icon: Icon, selected }) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={answer === id}
              onClick={() => onAnswer(answer === id ? undefined : id)}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors',
                answer === id ? selected : 'border-line text-muted hover:border-muted/60 hover:text-ink',
              )}
            >
              <Icon size={13} aria-hidden /> {label}
            </button>
          ))}
        </div>
      </div>
    </li>
  )
}

function BooksStep({ round, onNext, onSkip, busy, error }) {
  const [answers, setAnswers] = useState({})
  const [added, setAdded] = useState([])
  const items = round.items
  const answered = items.filter((r) => answers[r.book.id]).length

  // Неотмеченные книги уходят как «Не читал»: иначе сервер не засчитает раунд и покажет те же книги.
  // Добавленные через поиск — как «Нравится» с source: 'search', чтобы отличать их от ответов раунда.
  // Если добавленная книга есть и в раунде, побеждает добавление: пользователь сам её нашёл
  const collect = (fillUnread) => {
    const addedIds = new Set(added.map((b) => b.id))
    return items
      .filter(({ book }) => !addedIds.has(book.id))
      .map(({ book }) => ({ bookId: book.id, answer: answers[book.id] ?? (fillUnread ? 'unread' : undefined) }))
      .filter((a) => a.answer)
      .concat(added.map((b) => ({ bookId: b.id, answer: 'like', source: 'search' })))
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm font-medium text-accent-text">
          Раунд {round.round} из {MAX_ROUNDS}
        </p>
        <h1 className="mt-1 text-3xl font-semibold sm:text-4xl">Отметьте знакомые книги</h1>
        <p className="mt-2 text-muted">
          Можно ответить не на все — неотмеченные посчитаем как «Не читал». Следующий раунд подберём по вашим ответам.
        </p>
      </div>

      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {items.map(({ book }) => (
          <BookQuestion
            key={book.id}
            book={book}
            answer={answers[book.id]}
            onAnswer={(a) => setAnswers((prev) => ({ ...prev, [book.id]: a }))}
          />
        ))}
      </ul>

      <section className="flex flex-col gap-3 rounded-xl border border-dashed border-line p-4">
        <div>
          <h2 className="text-lg font-semibold">Добавить книгу, которую читали</h2>
          <p className="text-sm text-muted">Найдите книгу, которая вам понравилась, — она тоже попадёт в профиль.</p>
        </div>
        <BookAutocomplete
          label="Поиск книги, которую вы читали"
          placeholder="Название или автор"
          clearOnSelect
          onSelect={(book) => setAdded((list) => (list.some((b) => b.id === book.id) ? list : [...list, book]))}
          className="max-w-md"
        />
        {added.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {added.map((b) => (
              <li key={b.id} className="flex items-center gap-2 rounded-full border border-accent bg-accent-soft py-1 pr-1.5 pl-3 text-sm">
                <Heart size={13} className="text-accent-text" aria-hidden />
                <span lang="en" className="max-w-56 truncate">
                  {b.title}
                </span>
                <button
                  type="button"
                  aria-label={`Убрать «${b.title}»`}
                  onClick={() => setAdded((list) => list.filter((x) => x.id !== b.id))}
                  className="rounded-full p-0.5 text-muted hover:text-ink"
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ErrorNote error={error} />

      <Footer note={`Отмечено ${answered} из ${items.length}`}>
        <Button variant="ghost" onClick={() => onSkip(collect(false))} disabled={busy}>
          Пропустить
        </Button>
        <Button variant="primary" onClick={() => onNext(collect(true))} disabled={busy}>
          {round.round >= MAX_ROUNDS ? 'Готово' : 'Дальше'}
        </Button>
      </Footer>
    </div>
  )
}

export function OnboardingPage() {
  const { updateUser } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [chosenStep, setStep] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const round = useOnboardingRound()
  // Вернулся после пропуска или ухода со страницы — продолжаем со следующего раунда, темы не спрашиваем заново
  const step = chosenStep ?? (round.data ? (round.data.round > 1 ? 'books' : 'topics') : null)

  const send = async (body) => {
    setBusy(true)
    setError(null)
    try {
      return await sendOnboardingAnswers(body)
    } catch (err) {
      setError(err)
      throw err
    } finally {
      setBusy(false)
    }
  }

  // «Пропустить» (2.3): сохраняем уже данные ответы, но онбординг остаётся непройденным —
  // на главной висит баннер, возврат продолжит со следующего раунда
  const skip = async (body) => {
    if (body) await send(body)
    queryClient.invalidateQueries({ queryKey: ['recommendations'] })
    navigate('/', { replace: true })
  }

  // Настоящий конец онбординга (раунды кончились) — отмечаем пройденным, лента пересчитывается
  const finishing = useRef(false)
  const finish = async () => {
    if (finishing.current) return
    finishing.current = true
    try {
      const { user } = await send({ completed: true })
      updateUser(user)
      queryClient.invalidateQueries({ queryKey: ['recommendations'] })
      navigate('/', { replace: true })
    } catch (err) {
      finishing.current = false
      throw err
    }
  }

  // description — «Опишите своими словами»: сервер хранит одно описание на сессию онбординга для смыслового подбора
  const topicsBody = (sections, description) => ({
    topics: sections.map((value) => ({ kind: 'section', value })),
    description: description || undefined,
  })

  const onTopics = async (sections, description) => {
    await send(topicsBody(sections, description))
    await round.refetch()
    setStep('books')
  }

  const onRound = async (answers) => {
    await send({ round: round.data.round, answers })
    await round.refetch()
  }

  // Сервер ответил «раунды закончились» (3 раунда или 5 «Нравится») — завершаем и идём на главную
  const done = step === 'books' && round.data?.done
  useEffect(() => {
    if (done) finish().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done])

  // Темы — первая четверть, каждый раунд — ещё четверть
  const progress = step !== 'books' ? 0.05 : done ? 1 : (1 + (round.data ? round.data.round - 1 : 0)) / (MAX_ROUNDS + 1)

  const safe = (fn) => (...args) => fn(...args).catch(() => {})

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <Progress value={progress} label={step === 'books' ? 'Шаг 2 из 2 · книги' : 'Шаг 1 из 2 · темы'} />

      {round.error ? (
        <ErrorNote error={round.error} />
      ) : step === 'topics' ? (
        <TopicsStep
          onNext={safe(onTopics)}
          onSkip={safe((sections, description) => skip(sections.length ? topicsBody(sections, description) : null))}
          busy={busy || round.isFetching}
          error={error}
        />
      ) : !step || round.isPending || round.isFetching || round.data?.done ? (
        <div className="flex flex-col items-center gap-3 py-24 text-muted">
          <Spinner />
          <p>{!step ? 'Загружаем…' : round.data?.done ? 'Собираем вашу ленту…' : 'Подбираем книги по вашим ответам…'}</p>
          {round.data?.done && error && (
            <>
              <ErrorNote error={error} />
              <Button onClick={() => finish().catch(() => {})}>Попробовать ещё раз</Button>
            </>
          )}
        </div>
      ) : (
        <BooksStep
          key={round.data.round}
          round={round.data}
          onNext={safe(onRound)}
          onSkip={safe((answers) => skip(answers.length ? { round: round.data.round, answers } : null))}
          busy={busy}
          error={error}
        />
      )}
    </div>
  )
}
