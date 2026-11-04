// Книги на языке читателя (решения.md 2.8, 5.6, 5.8). Если у книги есть русское название (titleRu) или
// русское имя автора (authorRu) и пользователь читает по-русски — крупно русское, под ним мельче оригинал.
// Читающий по-русски — выбрал русский или казахский без английского (как на бэкенде: казахскую аудиторию
// русские издания тоже выручают). Только английский или английский с казахским — оригинал, как раньше.
// Гость и тот, кто язык не выбрал, — как читающий по-русски: сайт русскоязычный, оригинал всё равно виден.
// Казахские книги (source: 'kz') тому, кто выбрал казахский, — наоборот: крупно оригинал, под ним русское.

export const READING_LANGUAGES = [
  { id: 'ru', label: 'Русский' },
  { id: 'kk', label: 'Казахский' },
  { id: 'en', label: 'Английский' },
]

export function readsRussian(user) {
  const langs = user?.readingLanguages
  return !langs?.length || langs.includes('ru') || (langs.includes('kk') && !langs.includes('en'))
}

// { ru, kk } — что показывать текущему читателю
export function readerOf(user) {
  return { ru: readsRussian(user), kk: Boolean(user?.readingLanguages?.includes('kk')) }
}

// Язык оригинала для lang=: каталог Amazon английский, свои книги — русские и казахские (1.5); русский — язык страницы
export const originalLang = (book) => (book?.source === 'kz' ? 'kk' : book?.source === 'ru' ? undefined : 'en')

// У своих книг (1.5) оценок Amazon нет: rating = null, ratingsCount = 0 — вместо звёзд «Оценок пока нет»
export const hasRatings = (book) => book?.rating != null && book.ratingsCount > 0

const differs = (ru, original) => ru && ru.trim() && ru.trim() !== original?.trim()

// → { title, titleLang, originalTitle, author, authorLang, originalAuthor, originalLang };
// original* — вторая строка (null, если показывать нечего); *Lang — для lang= основной строки, originalLang — второй.
// reader — { ru, kk } из readerOf (или просто ru: boolean)
export function bookNames(book, reader = true) {
  const { ru, kk } = typeof reader === 'boolean' ? { ru: reader, kk: false } : reader
  const lang = originalLang(book)
  const hasTitleRu = differs(book?.titleRu, book?.title)
  const hasAuthorRu = book?.author && differs(book?.authorRu, book?.author)

  // казахская книга для читающего по-казахски: оригинал крупно, русское — под ним
  if (book?.source === 'kz' && kk) {
    return {
      title: book.title,
      titleLang: lang,
      originalTitle: ru && hasTitleRu ? book.titleRu : null,
      author: book.author,
      authorLang: lang,
      originalAuthor: ru && hasAuthorRu ? book.authorRu : null,
      originalLang: undefined,
    }
  }
  const titleRu = ru && hasTitleRu ? book.titleRu : null
  const authorRu = ru && hasAuthorRu ? book.authorRu : null
  return {
    title: titleRu ?? book?.title,
    titleLang: titleRu ? undefined : lang,
    originalTitle: titleRu ? book.title : null,
    author: authorRu ?? book?.author,
    authorLang: authorRu ? undefined : lang,
    originalAuthor: authorRu ? book.author : null,
    originalLang: lang,
  }
}
