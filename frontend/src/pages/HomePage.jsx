import { useEffect, useRef, useState } from 'react'
import { useBooks, useRecommendations, useSections } from '../api/queries.js'
import { BookShelf } from '../components/BookShelf.jsx'
import { Chip, ChipSkeleton } from '../components/Chip.jsx'
import { SkeletonLine } from '../components/Skeleton.jsx'
import { shortTitle } from '../lib/format.js'
import { sectionLabel } from '../lib/sections.js'

const DEFAULT_SECTION = 'Science Fiction & Fantasy'
// столько рядов «Потому что вам понравилась…» держим местом, пока грузятся рекомендации
const SEED_SHELVES = 2

function greeting(hour = new Date().getHours()) {
  if (hour < 5) return 'Доброй ночи'
  if (hour < 12) return 'Доброе утро'
  if (hour < 18) return 'Добрый день'
  return 'Добрый вечер'
}

function PopularIn() {
  const sections = useSections()
  const [section, setSection] = useState(DEFAULT_SECTION)
  const books = useBooks({ section, sort: 'popular', limit: 12 })
  const chipsRef = useRef(null)

  // выбранная тема может оказаться далеко в ряду — при загрузке прокручиваем ряд к ней
  useEffect(() => {
    const row = chipsRef.current
    const chip = row?.querySelector('[aria-pressed="true"]')
    if (chip) row.scrollLeft = chip.offsetLeft - 16
  }, [sections.data])

  return (
    <BookShelf
      title={`Популярное в разделе «${sectionLabel(section)}»`}
      subtitle="Больше всего оценок от читателей"
      items={books.data?.items}
      loading={books.isPending}
      error={books.error}
    >
      <div ref={chipsRef} className="scrollbar-none relative -mx-4 flex gap-2 overflow-x-auto px-4">
        {sections.isPending
          ? Array.from({ length: 10 }, (_, i) => <ChipSkeleton key={i} />)
          : sections.data?.map((s) => (
              <Chip key={s.name} selected={s.name === section} onClick={() => setSection(s.name)}>
                {sectionLabel(s.name)}
              </Chip>
            ))}
      </div>
    </BookShelf>
  )
}

export function HomePage() {
  const recs = useRecommendations()

  return (
    <div className="flex flex-col gap-12">
      <div>
        <h1 className="text-3xl font-semibold sm:text-4xl">{greeting()}</h1>
        <p className="mt-2 text-muted">Подобрали книги по вашим оценкам и любимым темам.</p>
      </div>

      <BookShelf
        title="Для вас"
        subtitle="Лучшие совпадения с вашим вкусом"
        items={recs.data?.forYou}
        withReasons
        loading={recs.isPending}
        error={recs.error}
      />

      {recs.isPending
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
            />
          ))}

      <PopularIn />
    </div>
  )
}
