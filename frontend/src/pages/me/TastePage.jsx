import { Sparkles, Undo2, X } from 'lucide-react'
import { Link } from 'react-router'
import { useTaste, useTasteUpdate } from '../../api/queries.js'
import { Button } from '../../components/Button.jsx'
import { SkeletonLine } from '../../components/Skeleton.jsx'
import { useToast } from '../../components/toast-context.js'
import { formatCount } from '../../lib/format.js'
import { subsectionLabel } from '../../lib/sections.js'
import { EmptyState, PageHeader } from './parts.jsx'

// Профиль вкусов (2.2, п. 3): что система думает о пользователе. Источник каждого пункта — выбран в онбординге
// или выведен из понравившихся книг (weight — сколько их); «Это не про меня» убирает пункт из рекомендаций
const GROUPS = [
  { kind: 'section', title: 'Темы' },
  { kind: 'subsection', title: 'Подтемы' },
  { kind: 'author', title: 'Авторы' },
]
// Подтема приходит без раздела — берём общий перевод из shared/subsections_ru.json; авторы — как есть, по-английски
const labelOf = (item) => (item.kind === 'subsection' ? subsectionLabel(item.value) : item.label)
const langOf = (item) => (item.kind === 'author' ? 'en' : undefined)

const LIKED = { one: 'понравившейся книге', few: 'понравившимся книгам', many: 'понравившимся книгам' }

function source(item) {
  if (item.weight > 0) return `по ${formatCount(item.weight, LIKED)}${item.source === 'onboarding' ? ' · выбрано вами' : ''}`
  return item.source === 'onboarding' ? 'выбрано вами в онбординге' : 'из ваших ответов'
}

// Полоса — доля от самого весомого пункта в группе: видно, что влияет сильнее
function TasteItem({ item, max, onReject }) {
  return (
    <li className="flex items-center gap-3 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span lang={langOf(item)} className="font-medium">
            {labelOf(item)}
          </span>
          <span className="text-xs text-muted">{source(item)}</span>
        </div>
        {max > 0 && (
          <div className="h-1.5 max-w-sm overflow-hidden rounded-full bg-surface-2" aria-hidden>
            <div className="h-full rounded-full bg-smart" style={{ width: item.weight ? `${Math.max(4, (item.weight / max) * 100)}%` : 0 }} />
          </div>
        )}
      </div>
      <Button size="sm" variant="ghost" onClick={onReject} aria-label={`Это не про меня: ${labelOf(item)}`}>
        <X size={15} aria-hidden /> <span className="hidden sm:inline">Это не про меня</span>
      </Button>
    </li>
  )
}

function TasteSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-8" aria-busy>
      {[5, 3].map((n, g) => (
        <div key={g} className="flex flex-col gap-4">
          <div className="h-6 w-24 rounded bg-surface-2" />
          {Array.from({ length: n }, (_, i) => (
            <div key={i} className="flex flex-col gap-2">
              <SkeletonLine className="w-48" />
              <div className="h-1.5 w-full max-w-sm rounded-full bg-surface-2" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

export function TastePage() {
  const toast = useToast()
  const taste = useTaste()
  const update = useTasteUpdate({ onError: (message) => toast(`Не удалось сохранить: ${message}`) })
  const set = (item, rejected) => update.mutate({ kind: item.kind, value: item.value, rejected })
  const items = taste.data?.items ?? []
  const rejected = taste.data?.rejected ?? []

  return (
    <>
      <PageHeader
        title="Профиль вкусов"
        subtitle="Что система думает о ваших интересах — по темам из онбординга и книгам, которые вам понравились. Уберите лишнее, и подборки перестроятся."
        action={
          <Button as={Link} to="/onboarding" variant="secondary">
            <Sparkles size={16} className="text-smart" aria-hidden /> Уточнить вкусы
          </Button>
        }
      />

      {taste.error ? (
        <p role="alert" className="text-muted">
          Не удалось загрузить профиль. {taste.error.message}
        </p>
      ) : taste.isPending ? (
        <TasteSkeleton />
      ) : (
        <div className="flex flex-col gap-10">
          {items.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title="Мы пока мало о вас знаем"
              actions={
                <Button as={Link} to="/onboarding" variant="primary">
                  Рассказать о вкусах
                </Button>
              }
            >
              Выберите любимые темы в онбординге или оцените несколько книг — здесь появится ваш профиль.
            </EmptyState>
          ) : (
            GROUPS.map(({ kind, title }) => {
              const group = items.filter((i) => i.kind === kind)
              if (!group.length) return null
              const max = Math.max(...group.map((i) => i.weight))
              return (
                <section key={kind} aria-labelledby={`taste-${kind}`}>
                  <h2 id={`taste-${kind}`} className="text-lg font-semibold">
                    {title}
                  </h2>
                  <ul className="divide-y divide-line">
                    {group.map((item) => (
                      <TasteItem key={item.value} item={item} max={max} onReject={() => set(item, true)} />
                    ))}
                  </ul>
                </section>
              )
            })
          )}

          {rejected.length > 0 && (
            <section aria-labelledby="taste-rejected" className="rounded-xl border border-line bg-surface p-4">
              <h2 id="taste-rejected" className="font-semibold">
                Убрано из профиля
              </h2>
              <p className="mt-1 text-sm text-muted">Эти пункты не влияют на подборки. Верните, если поспешили.</p>
              <ul className="mt-3 flex flex-wrap gap-2">
                {rejected.map((item) => (
                  <li key={`${item.kind}:${item.value}`} className="flex items-center gap-1 rounded-full border border-line py-1 pr-1 pl-3 text-sm">
                    <span lang={langOf(item)} className="text-muted line-through decoration-muted/50">
                      {labelOf(item)}
                    </span>
                    <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => set(item, false)} aria-label={`Вернуть: ${labelOf(item)}`}>
                      <Undo2 size={14} aria-hidden /> Вернуть
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </>
  )
}
