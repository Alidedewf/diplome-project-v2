import { ChevronDown, Scale, Sparkles, ThumbsDown, ThumbsUp, Users } from 'lucide-react'
import { useId, useState } from 'react'
import { cn, plural } from '../lib/format.js'

// Сводка отзывов на карточке книги (2.6.1, 5.11). Формат — поле reviewSummary из GET /api/books/:id:
//   { analyzed, overall: { verdict, sharePos, mentions, quotePos, quoteNeg } | null,
//     aspects: [{ aspect, label, verdict, sharePos, mentions, quotePos, quoteNeg }], info: [{ aspect, label, mentions, quotePos }] }
// Подписи аспектов — русские (label), цитаты — английские, из настоящих отзывов. summary = null — блока нет.

const GROUPS = [
  { verdict: 'praise', title: 'Читатели хвалят', icon: ThumbsUp, tone: 'text-accent-text' },
  { verdict: 'mixed', title: 'Мнения расходятся', icon: Scale, tone: 'text-smart-text' },
  { verdict: 'criticize', title: 'Ругают', icon: ThumbsDown, tone: 'text-critic' },
]

const OVERALL = {
  praise: 'читателям нравится',
  mixed: 'мнения расходятся',
  criticize: 'читатели скорее недовольны',
}

const OF_REVIEWS = { one: 'отзыва', few: 'отзывов', many: 'отзывов' } // «12 из 21 отзыва»
const BY_REVIEWS = { one: 'отзыву', few: 'отзывам', many: 'отзывам' } // «по 21 отзыву»

const percent = (share) => Math.round(share * 100)

// positive: true — плюс, false — минус, не задан — нейтральная справка (label своя)
function Quote({ text, positive, label }) {
  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="text-xs text-muted">
        {label ?? (positive ? 'Цитата из положительного отзыва' : 'Цитата из критического отзыва')}
      </figcaption>
      <blockquote
        lang="en"
        className={cn(
          'border-l-2 pl-3 text-sm leading-relaxed text-ink/90 italic break-words',
          positive === undefined ? 'border-line' : positive ? 'border-accent/50' : 'border-critic/50',
        )}
      >
        “{text}”
      </blockquote>
    </figure>
  )
}

// Доля положительных среди упоминаний — полоска и числа, чтобы «мнения расходятся» было видно, насколько
function ShareBar({ sharePos, mentions }) {
  const pos = Math.round(sharePos * mentions)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-1.5 w-full max-w-64 overflow-hidden rounded-full bg-critic/30" aria-hidden>
        <div className="bg-accent" style={{ width: `${percent(sharePos)}%` }} />
      </div>
      <p className="text-xs text-muted">
        Положительно — {pos}, отрицательно — {mentions - pos} ({percent(sharePos)}% положительных)
      </p>
    </div>
  )
}

// Строка-раскрывашка: подпись всегда видна, цитаты — по клику. Без цитат и подробностей — просто строка
function Expandable({ summary, children }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  if (!children) return <div className="py-1.5 text-sm">{summary}</div>
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="group flex w-full items-start gap-1.5 rounded py-1.5 text-left text-sm hover:text-accent-text"
      >
        <span className="min-w-0 flex-1">{summary}</span>
        <ChevronDown
          size={16}
          aria-hidden
          className={cn('mt-0.5 shrink-0 text-muted transition-transform group-hover:text-accent-text', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div id={id} className="mb-2 flex flex-col gap-3 pt-1 pb-1 pl-0.5">
          {children}
        </div>
      )}
    </div>
  )
}

function Mentions({ label, mentions, analyzed }) {
  return (
    <>
      <span className="font-medium">{label}</span>
      <span className="text-muted">
        {' '}
        — {mentions} из {analyzed} {plural(analyzed, OF_REVIEWS)}
      </span>
    </>
  )
}

function Quotes({ quotePos, quoteNeg }) {
  if (!quotePos && !quoteNeg) return null
  return (
    <>
      {quotePos && <Quote text={quotePos} positive />}
      {quoteNeg && <Quote text={quoteNeg} />}
    </>
  )
}

function AspectItem({ item, analyzed }) {
  return (
    <li>
      <Expandable summary={<Mentions label={item.label} mentions={item.mentions} analyzed={analyzed} />}>
        <ShareBar sharePos={item.sharePos} mentions={item.mentions} />
        <Quotes quotePos={item.quotePos} quoteNeg={item.quoteNeg} />
      </Expandable>
    </li>
  )
}

function Overall({ overall }) {
  return (
    <Expandable
      summary={
        <>
          <span className="font-semibold">В целом {OVERALL[overall.verdict] ?? OVERALL.mixed}</span>
          <span className="text-muted"> · {percent(overall.sharePos)}% положительных отзывов</span>
        </>
      }
    >
      {(overall.quotePos || overall.quoteNeg) && <Quotes quotePos={overall.quotePos} quoteNeg={overall.quoteNeg} />}
    </Expandable>
  )
}

export function ReviewSummary({ summary, className }) {
  const titleId = useId()
  if (!summary) return null
  const { analyzed, overall, aspects = [], info = [] } = summary
  const groups = GROUPS.map((g) => ({ ...g, items: aspects.filter((a) => a.verdict === g.verdict) })).filter((g) => g.items.length)
  if (!overall && !groups.length && !info.length) return null

  return (
    <section aria-labelledby={titleId} className={cn('flex flex-col gap-4', className)}>
      <h2 id={titleId} className="text-xl font-semibold">
        Что говорят читатели
      </h2>
    <div className="flex flex-col gap-5 rounded-lg border border-line bg-surface px-4 py-4 sm:px-5">
      <p className="-mb-2 flex items-center gap-1.5 text-xs font-medium tracking-wide text-smart-text uppercase">
        <Sparkles size={13} className="text-smart" aria-hidden /> Сводка отзывов
      </p>

      {overall && (
        <div className="border-b border-line pb-3">
          <Overall overall={overall} />
        </div>
      )}

      {groups.map(({ verdict, title, icon: Icon, tone, items }) => (
        <section key={verdict} aria-label={title} className="flex flex-col gap-1">
          <h3 className={cn('flex items-center gap-2 text-sm font-semibold', tone)}>
            <Icon size={16} aria-hidden /> {title}
          </h3>
          <ul className="flex flex-col pl-6">
            {items.map((item) => (
              <AspectItem key={item.aspect} item={item} analyzed={analyzed} />
            ))}
          </ul>
        </section>
      ))}

      {info.length > 0 && (
        <section aria-label="Кому подойдёт" className="flex flex-col gap-1 rounded-md bg-surface-2/60 px-3 py-2.5">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-muted">
            <Users size={16} aria-hidden /> Кому подойдёт
          </h3>
          {/* справка без вердикта: сейчас это один аспект audience с подписью «Кому подойдёт» — подпись не повторяем,
              цитату показываем сразу (в ней и есть ответ «кому»), остальное — как у аспектов */}
          <ul className="flex flex-col gap-3 pl-6">
            {info.map((item) => (
              <li key={item.aspect} className="flex flex-col gap-2 text-sm">
                <p>
                  {item.label !== 'Кому подойдёт' && <span className="font-medium">{item.label}: </span>}
                  <span className="text-muted">
                    {item.label !== 'Кому подойдёт' ? 'читатели' : 'Читатели'} пишут об этом в {item.mentions} из {analyzed} {plural(analyzed, OF_REVIEWS)}
                  </span>
                </p>
                {item.quotePos && <Quote text={item.quotePos} label="Цитата из отзыва" />}
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-xs text-muted">
        По {analyzed} {plural(analyzed, BY_REVIEWS)} · анализ — нейросеть, возможны ошибки
      </p>
    </div>
    </section>
  )
}
