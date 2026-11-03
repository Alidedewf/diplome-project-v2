import { EyeOff, Undo2 } from 'lucide-react'
import { useBookAction, useMyHidden } from '../../api/queries.js'
import { Button } from '../../components/Button.jsx'
import { useToast } from '../../components/toast-context.js'
import { BookList, EmptyState, MyBookCard, PageHeader } from './parts.jsx'

function HiddenBook({ item }) {
  const toast = useToast()
  const action = useBookAction(item.book.id, { onError: (message) => toast(`Не удалось вернуть: ${message}`) })
  return (
    <MyBookCard book={item.book}>
      <Button size="sm" onClick={() => action.mutate({ kind: 'hidden', value: false })} aria-label={`Вернуть «${item.book.title}»`}>
        <Undo2 size={15} aria-hidden /> Вернуть
      </Button>
    </MyBookCard>
  )
}

export function HiddenPage() {
  return (
    <>
      <PageHeader
        title="Скрытые книги"
        subtitle="Всё, что вы отметили «Не интересно». Эти книги не появляются в рекомендациях и подборках — пока вы их не вернёте."
      />
      <BookList
        query={useMyHidden()}
        renderItem={(item) => <HiddenBook key={item.book.id} item={item} />}
        empty={
          <EmptyState icon={EyeOff} title="Скрытых книг нет">
            Если книга в подборке точно не для вас, нажмите «Не интересно» на её странице — она пропадёт из рекомендаций.
          </EmptyState>
        }
      />
    </>
  )
}
