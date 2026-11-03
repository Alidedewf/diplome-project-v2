-- Нормализованное имя автора («J.K. Rowling» → «jkrowling») для поиска по автору (тест-кейс SRCH-02).
-- Индекс по выражению: Prisma такие не описывает, поэтому только в миграции. Выражение должно совпадать
-- с AUTHOR_KEY_SQL в src/routes/search.js, иначе индекс не используется
CREATE INDEX IF NOT EXISTS "books_author_key_idx" ON "books" ((regexp_replace(lower(coalesce("author", '')), '[^[:alnum:]]', '', 'g')));
