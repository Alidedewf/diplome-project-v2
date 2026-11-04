import { Star, Trash2 } from 'lucide-react'
import { useBookAction, useMyRatings } from '../../api/queries.js'
import { Button } from '../../components/Button.jsx'
import { RatingStars } from '../../components/RatingStars.jsx'
import { useToast } from '../../components/toast-context.js'
import { formatCount } from '../../lib/format.js'
import { useBookNames } from '../../lib/useBookNames.js'
import { BookList, EmptyLinks, EmptyState, MyBookCard, PageHeader } from './parts.jsx'

const RATINGS = { one: 'оценка', few: 'оценки', many: 'оценок' }
const date = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })

function RatedBook({ item }) {
  const { title } = useBookNames(item.book)
  const toast = useToast()
  const action = useBookAction(item.book.id, { onError: (message) => toast(`Не удалось сохранить: ${message}`) })
  return (
    <MyBookCard book={item.book} meta={item.ratedAt && <p className="mt-0.5 text-xs text-muted">{date.format(new Date(item.ratedAt))}</p>}>
      <RatingStars value={item.rating} onChange={(value) => action.mutate({ kind: 'rating', value })} size={20} />
      <Button
        size="sm"
        variant="ghost"
        className="ml-auto"
        onClick={() => action.mutate({ kind: 'rating', value: null })}
        aria-label={`Удалить оценку «${title}»`}
      >
        <Trash2 size={15} aria-hidden /> Удалить
      </Button>
    </MyBookCard>
  )
}

export function RatingsPage() {
  const query = useMyRatings()
  const total = query.data?.pages[0]?.total
  return (
    <>
      <PageHeader
        title="Мои оценки"
        subtitle={
          <>
            Шкала 1–5, как у читателей Amazon. Оценка ставит книгу на полку «Прочитал».
            {total > 0 && <span className="text-ink"> Всего: {formatCount(total, RATINGS)}.</span>}
          </>
        }
      />
      <BookList
        query={query}
        renderItem={(item) => <RatedBook key={item.book.id} item={item} />}
        empty={
          <EmptyState icon={Star} title="Оценок пока нет" actions={<EmptyLinks />}>
            Оценивайте прочитанные книги на их страницах — так подборки быстрее подстроятся под ваш вкус.
          </EmptyState>
        }
      />
    </>
  )
}
