import { ArrowRight, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { trackRecClick } from '../api/events.js'
import { useBooks, useRecommendations, useSections } from '../api/queries.js'
import { useAuth } from '../auth/context.js'
import { BookShelf } from '../components/BookShelf.jsx'
import { Button } from '../components/Button.jsx'
import { Chip, ChipSkeleton } from '../components/Chip.jsx'
import { SkeletonLine } from '../components/Skeleton.jsx'
import { shortTitle } from '../lib/format.js'
import { sectionLabel } from '../lib/sections.js'

// столько рядов «Потому что вам понравилась…» держим местом, пока грузятся рекомендации
const SEED_SHELVES = 2

function greeting(hour = new Date().getHours()) {
  if (hour < 5) return 'Доброй ночи'
  if (hour < 12) return 'Доброе утро'
  if (hour < 18) return 'Добрый день'
  return 'Добрый вечер'
}

// preferred — раздел из профиля пользователя; без него — самый большой раздел каталога
function PopularIn({ preferred }) {
  const sections = useSections()
  const [chosen, setChosen] = useState(null)
  const section = chosen ?? preferred ?? sections.data?.[0]?.name
  const books = useBooks({ section, sort: 'popular', limit: 12 }, { enabled: Boolean(section) })
  const chipsRef = useRef(null)

  // выбранная тема может оказаться далеко в ряду — при загрузке прокручиваем ряд к ней
  useEffect(() => {
    const row = chipsRef.current
    const chip = row?.querySelector('[aria-pressed="true"]')
    if (chip) row.scrollLeft = chip.offsetLeft - 16
  }, [sections.data, preferred])

  return (
    <BookShelf
      title={section ? `Популярное в разделе «${sectionLabel(section)}»` : 'Популярное в разделе…'}
      subtitle="Больше всего оценок от читателей"
      items={section ? books.data?.items : undefined}
      loading={!section || books.isPending}
      error={books.error}
    >
      <div ref={chipsRef} className="scrollbar-none relative -mx-4 flex gap-2 overflow-x-auto px-4">
        {sections.isPending
          ? Array.from({ length: 10 }, (_, i) => <ChipSkeleton key={i} />)
          : sections.data?.map((s) => (
              <Chip key={s.name} selected={s.name === section} onClick={() => setChosen(s.name)}>
                {sectionLabel(s.name)}
              </Chip>
            ))}
      </div>
    </BookShelf>
  )
}

function GuestIntro() {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-3xl font-semibold sm:text-4xl">Что почитать</h1>
        <p className="mt-2 max-w-xl text-muted">
          Популярное у читателей. Войдите — и мы подберём книги под ваш вкус и объясним, почему советуем каждую.
        </p>
      </div>
      <div className="flex gap-2">
        <Button as={Link} to="/register" variant="primary">
          Подобрать книги
        </Button>
        <Button as={Link} to="/login?next=%2F">
          Войти
        </Button>
      </div>
    </div>
  )
}

// Онбординг пропущен или не закончен — напоминаем, что подборки станут точнее
function OnboardingBanner() {
  return (
    <Link
      to="/onboarding"
      className="group flex items-center gap-3 rounded-xl bg-smart-soft px-4 py-3 text-sm transition-colors hover:bg-smart-soft/70"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-smart text-paper">
        <Sparkles size={16} aria-hidden />
      </span>
      <span className="flex-1">
        <span className="font-medium text-smart-text">Расскажите о своих вкусах.</span>{' '}
        Пара минут — и подборки станут точнее.
      </span>
      <ArrowRight size={18} className="shrink-0 text-smart-text transition-transform group-hover:translate-x-0.5" />
    </Link>
  )
}

export function HomePage() {
  const { user } = useAuth()
  const recs = useRecommendations()
  // раздел для «Популярное в …» — тема первой книги «Для вас», подобранной по теме
  const preferred = recs.data?.forYou.find((r) => r.reason?.kind !== 'popular')?.book.section

  return (
    <div className="flex flex-col gap-12">
      {user ? (
        <div className="flex flex-col gap-5">
          <div>
            <h1 className="text-3xl font-semibold sm:text-4xl">
              {greeting()}, {user.name}
            </h1>
            <p className="mt-2 text-muted">Подобрали книги по вашим оценкам и любимым темам.</p>
          </div>
          {!user.onboardingCompleted && <OnboardingBanner />}
        </div>
      ) : (
        <GuestIntro />
      )}

      {user ? (
        <BookShelf
          title="Для вас"
          subtitle="Лучшие совпадения с вашим вкусом"
          items={recs.data?.forYou}
          withReasons
          loading={recs.isPending}
          error={recs.error}
          onOpen={(book, reason) => trackRecClick(book, reason, 'for_you')}
        />
      ) : (
        <BookShelf
          title="Популярное у читателей"
          subtitle="Высокие оценки и много отзывов"
          items={recs.data?.forYou.map((r) => r.book)}
          loading={recs.isPending}
          error={recs.error}
        />
      )}

      {user && recs.isPending
        ? Array.from({ length: SEED_SHELVES }, (_, i) => (
            <BookShelf
              key={i}
              title="Потому что вам понравилась…"
              subtitle={<SkeletonLine className="w-28 animate-pulse" />}
              loading
            />
          ))
        : recs.data?.becauseYouLiked.map(({ seed, items }) => (
            <BookShelf
              key={seed.id}
              title={`Потому что вам понравилась «${shortTitle(seed.title)}»`}
              subtitle={seed.author}
              items={items.map((it) => it.book)}
              onOpen={(book) => trackRecClick(book, items.find((it) => it.book.id === book.id)?.reason, 'because_you_liked')}
            />
          ))}

      <PopularIn preferred={preferred} />
    </div>
  )
}
