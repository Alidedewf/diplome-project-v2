// Сводка отзывов на карточке книги (решения.md 2.6.1, 3.6, 4.13): data/processed/review_summary_site.parquet (ML,
// ml/src/reviews/summarize.py) → таблицы review_summaries и review_summary_items.
//
// Файл — строка на показанный пункт сводки: book_id (= parent_asin), analyzed, aspect, label_ru, kind (overall | aspect |
// info), verdict (praise | mixed | criticize; у info — null), share_pos, mentions, mention_share, quote_pos, quote_neg, rank.
//
// Таблицы заменяются целиком в одной транзакции (сайт до конца загрузки видит прежние сводки): DuckDB читает файл
// потоково, пачки строк идут через COPY во временную таблицу, затем TRUNCATE + INSERT. Книги, которых нет в каталоге,
// пропускаются и считаются. Чужие kind / verdict или повтор (книга, rank) — ошибка, прежние сводки остаются.
//
// Запуск из backend/:  npm run load:review-summary [-- путь к parquet]
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { DuckDBInstance } from '@duckdb/node-api'
import pg from 'pg'
import { from as copyFrom } from 'pg-copy-streams'
import { config, ROOT } from '../src/config.js'

const DEFAULT_FILE = path.join(ROOT, 'data/processed/review_summary_site.parquet')
const sqlPath = (p) => `'${p.replaceAll('\\', '/').replaceAll("'", "''")}'`
const COLUMNS = ['book_id', 'analyzed', 'aspect', 'label_ru', 'kind', 'verdict', 'share_pos', 'mentions', 'mention_share',
  'quote_pos', 'quote_neg', 'rank']

// Поле CSV для COPY: null — пусто без кавычек (NULL), остальное — в кавычках (пустая строка остаётся строкой)
const csv = (v) => (v == null ? '' : `"${String(v).replaceAll('"', '""')}"`)

// Строки файла в порядке COLUMNS, пачками CSV для COPY (DuckDB читает потоково). Без базы — можно проверить отдельно
export async function* summaryCsv(file, onRows = () => {}) {
  const duck = await (await DuckDBInstance.create(':memory:')).connect()
  try {
    const present = (await duck.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet(${sqlPath(file)})`)).getRowObjects()
      .map((c) => c.column_name)
    const missing = COLUMNS.filter((c) => !present.includes(c))
    if (missing.length) throw new Error(`В файле нет колонок: ${missing.join(', ')} (есть: ${present.join(', ')})`)
    const num = (c) => `CASE WHEN isnan(${c}::DOUBLE) THEN NULL ELSE ${c}::DOUBLE END` // NaN из pandas — как null
    const result = await duck.stream(`
      SELECT book_id, analyzed::INTEGER, aspect, label_ru, kind, CASE WHEN kind = 'info' THEN NULL ELSE verdict END,
        ${num('share_pos')}, mentions::INTEGER, ${num('mention_share')}, nullif(trim(quote_pos), ''), nullif(trim(quote_neg), ''),
        rank::INTEGER
      FROM read_parquet(${sqlPath(file)})`)
    for await (const rows of result.yieldRowsJs()) {
      let chunk = ''
      for (const row of rows) chunk += row.map(csv).join(',') + '\n'
      onRows(rows.length)
      yield chunk
    }
  } finally {
    duck.closeSync?.()
  }
}

export async function loadReviewSummary({ file = DEFAULT_FILE, databaseUrl = config.databaseUrl, log = console.log } = {}) {
  const started = performance.now()
  const seconds = () => ((performance.now() - started) / 1000).toFixed(1)
  log(`Файл: ${file}`)
  // Колонки проверяются до подключения к базе: первая пачка читается заранее
  let rows = 0
  const chunks = summaryCsv(file, (n) => {
    rows += n
    if (rows % 200_000 < n) log(`  прочитано ${rows.toLocaleString('ru-RU')} строк — ${seconds()} с`)
  })
  const first = await chunks.next()
  async function* all() {
    if (!first.done) yield first.value
    yield* chunks
  }

  const db = new pg.Client({ connectionString: databaseUrl })
  try {
    await db.connect()
    await db.query('BEGIN')
    await db.query(`CREATE TEMP TABLE summary_stage (book_id text, analyzed int, aspect text, label_ru text, kind text,
      verdict text, share_pos real, mentions int, mention_share real, quote_pos text, quote_neg text, rank int) ON COMMIT DROP`)
    await pipeline(
      Readable.from(all()),
      db.query(copyFrom(`COPY summary_stage (${COLUMNS.join(', ')}) FROM STDIN WITH (FORMAT csv)`)),
    )

    await db.query('TRUNCATE review_summaries, review_summary_items')
    const { rows: [{ total }] } = await db.query('SELECT count(DISTINCT book_id)::int AS total FROM summary_stage')
    const { rowCount: books } = await db.query(`
      INSERT INTO review_summaries (book_id, analyzed)
      SELECT s.book_id, max(s.analyzed) FROM summary_stage s
      WHERE EXISTS (SELECT 1 FROM books b WHERE b.id = s.book_id)
      GROUP BY s.book_id`)
    const { rowCount: items } = await db.query(`
      INSERT INTO review_summary_items (book_id, rank, kind, aspect, label_ru, verdict, share_pos, mentions, mention_share,
        quote_pos, quote_neg)
      SELECT s.book_id, s.rank, s.kind, s.aspect, s.label_ru, s.verdict, s.share_pos, s.mentions, s.mention_share,
        s.quote_pos, s.quote_neg
      FROM summary_stage s JOIN review_summaries r ON r.book_id = s.book_id
      ORDER BY s.book_id, s.rank`)
    await db.query('COMMIT')
    const result = { rows, books, items, skippedBooks: total - books }
    log(`Записано: ${books.toLocaleString('ru-RU')} книг, ${items.toLocaleString('ru-RU')} пунктов; `
      + `книг вне каталога пропущено: ${result.skippedBooks.toLocaleString('ru-RU')} — ${seconds()} с`)
    await db.query('ANALYZE review_summaries')
    await db.query('ANALYZE review_summary_items')
    return result
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await chunks.return() // закрыть DuckDB, если чтение оборвалось
    await db.end().catch(() => {})
  }
}

if (import.meta.main) {
  loadReviewSummary({ file: process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_FILE }).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
