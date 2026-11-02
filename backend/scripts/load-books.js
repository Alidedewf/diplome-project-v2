// Загрузка каталога: data/processed/books_clean.parquet → таблица books (решения.md, 4.1).
//
// Parquet читается потоково через DuckDB (файл 1,5 ГБ, одна группа строк — целиком в память не берём),
// строки идут через COPY во временную таблицу, оттуда — INSERT … ON CONFLICT DO UPDATE.
// Повторный запуск дублей не создаёт и обновляет только изменившиеся книги; оценки и полки
// пользователей сайта не трогаются. Книги, которых больше нет в файле, не удаляются (выводится их число).
//
// Запуск из backend/:  npm run load:books [-- путь/к/books_clean.parquet]
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { DuckDBInstance } from '@duckdb/node-api'
import pg from 'pg'
import { from as copyFrom } from 'pg-copy-streams'
import { config, ROOT } from '../src/config.js'

const BOOKS = path.resolve(process.argv[2] ?? path.join(ROOT, 'data/processed/books_clean.parquet'))
const RATINGS = path.join(path.dirname(BOOKS), 'ratings_clean.parquet')

// Взвешенный рейтинг (3.3): WR = v/(v+m)·R + m/(v+m)·C по оценкам 5-core.
// m = 40 — 90-й перцентиль числа оценок на книгу (медиана 10); подбирается позже вместе с ML
const M = 40
// Аннотация на карточке — features целиком; совсем длинные (> p99 ≈ 3,5 тыс. символов) обрезаются по слову
const ANNOTATION_MAX = 5000

const COLUMNS = [
  'id', 'title', 'author', 'year', 'section', 'category', 'subsection', 'format', 'language', 'isbn13',
  'cover', 'annotation', 'rating', 'ratings_count', 'amazon_ratings_count', 'editions_count', 'weighted_rating',
]

const sqlPath = (p) => `'${p.replaceAll('\\', '/').replaceAll("'", "''")}'`

const SELECT = `
  WITH r AS (
    SELECT parent_asin, avg(rating) AS mean, count(*) AS n
    FROM read_parquet(${sqlPath(RATINGS)}) GROUP BY parent_asin
  ), c AS (SELECT avg(rating) AS mean FROM read_parquet(${sqlPath(RATINGS)}))
  SELECT
    b.parent_asin, b.title, b.author, b.year::INTEGER,
    b.onboarding_section, b.cat2, b.cat3, b.format, b.language, b.isbn13, b.image,
    trim(regexp_replace(array_to_string(b.features, ' '), '\\s+', ' ', 'g')),
    round(b.average_rating, 2)::DOUBLE,
    b.n_ratings::INTEGER, coalesce(b.rating_number, 0)::INTEGER, b.n_editions::INTEGER,
    (coalesce(r.n, 0) / (coalesce(r.n, 0) + ${M}) * coalesce(r.mean, c.mean)
      + ${M} / (coalesce(r.n, 0) + ${M}) * c.mean)::DOUBLE
  FROM read_parquet(${sqlPath(BOOKS)}) b
  LEFT JOIN r USING (parent_asin) CROSS JOIN c
`

function cutAnnotation(text) {
  if (!text || text.length <= ANNOTATION_MAX) return text ?? ''
  return text.slice(0, ANNOTATION_MAX - 1).replace(/\s+\S*$/, '').trimEnd() + '…'
}

// Поле CSV для COPY: пустое без кавычек — NULL, в кавычках — строка (в том числе пустая)
function csv(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return String(value)
  return `"${String(value).replaceAll('"', '""')}"`
}

async function* csvLines(result, onRows) {
  for await (const rows of result.yieldRowsJs()) {
    let chunk = ''
    for (const row of rows) {
      row[11] = cutAnnotation(row[11])
      chunk += row.map(csv).join(',') + '\n'
    }
    onRows(rows.length)
    yield chunk
  }
}

async function main() {
  const started = performance.now()
  const seconds = () => ((performance.now() - started) / 1000).toFixed(1)
  console.log(`Файл: ${BOOKS}`)

  const duck = await (await DuckDBInstance.create(':memory:')).connect()
  const db = new pg.Client({ connectionString: config.databaseUrl })
  await db.connect()

  try {
    await db.query('BEGIN')
    await db.query(`CREATE TEMP TABLE books_stage (LIKE books INCLUDING DEFAULTS) ON COMMIT DROP`)
    await db.query('ALTER TABLE books_stage DROP COLUMN search_vector')

    let read = 0
    const result = await duck.stream(SELECT)
    await pipeline(
      Readable.from(csvLines(result, (n) => {
        read += n
        if (read % 100_000 < n) console.log(`  прочитано ${read.toLocaleString('ru-RU')} — ${seconds()} с`)
      })),
      db.query(copyFrom(`COPY books_stage (${COLUMNS.join(', ')}) FROM STDIN WITH (FORMAT csv)`)),
    )
    console.log(`Прочитано из Parquet: ${read.toLocaleString('ru-RU')} книг — ${seconds()} с`)

    const updatable = COLUMNS.filter((c) => c !== 'id')
    const { rows: [counts] } = await db.query(`
      WITH up AS (
        INSERT INTO books (${COLUMNS.join(', ')})
        SELECT ${COLUMNS.join(', ')} FROM books_stage
        ON CONFLICT (id) DO UPDATE SET ${updatable.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}
        WHERE (${updatable.map((c) => `books.${c}`).join(', ')})
          IS DISTINCT FROM (${updatable.map((c) => `EXCLUDED.${c}`).join(', ')})
        RETURNING (xmax = 0) AS inserted
      )
      SELECT count(*) FILTER (WHERE inserted)::int AS inserted,
             count(*) FILTER (WHERE NOT inserted)::int AS updated
      FROM up`)
    const { rows: [{ stale }] } = await db.query(
      `SELECT count(*)::int AS stale FROM books b WHERE NOT EXISTS (SELECT 1 FROM books_stage s WHERE s.id = b.id)`,
    )
    await db.query('COMMIT')
    await db.query('ANALYZE books')

    const { rows: [{ total }] } = await db.query('SELECT count(*)::int AS total FROM books')
    console.log(`Добавлено: ${counts.inserted.toLocaleString('ru-RU')}, обновлено: ${counts.updated.toLocaleString('ru-RU')}, ` +
      `без изменений: ${(read - counts.inserted - counts.updated).toLocaleString('ru-RU')}`)
    if (stale) console.log(`В базе есть ${stale} книг, которых нет в файле (не удалены)`)
    console.log(`Всего в таблице books: ${total.toLocaleString('ru-RU')} — за ${seconds()} с`)
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await db.end()
    duck.closeSync?.()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
