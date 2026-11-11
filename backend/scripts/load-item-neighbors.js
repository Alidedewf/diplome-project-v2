// Загрузка соседей ItemKNN: models/serve/<сборка>/item_neighbors.parquet → таблица item_neighbors (решения.md 3.8, 4.11).
// Файл делает ML (ml/src/serve/build.py): топ-20 соседей на книгу (book_id, neighbor_id, score), без самой книги
// и книг с 1–4 оценками. По умолчанию — последняя сборка (папки models/serve/ по имени).
//
// Таблица заменяется целиком в одной транзакции (сайт до конца загрузки видит прежних соседей): COPY во временную
// таблицу, затем TRUNCATE + INSERT … ORDER BY и первичный ключ заново. Соседи книг, которых нет в каталоге, отсекаются.
//
// Запуск из backend/:  npm run load:item-neighbors [-- путь/к/item_neighbors.parquet]
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { DuckDBInstance } from '@duckdb/node-api'
import pg from 'pg'
import { from as copyFrom } from 'pg-copy-streams'
import { config, ROOT } from '../src/config.js'

function latestBuild() {
  const dir = path.join(ROOT, 'models/serve')
  const builds = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  if (!builds.length) throw new Error(`Нет сборок в ${dir}`)
  return path.join(dir, builds.at(-1), 'item_neighbors.parquet')
}

const FILE = path.resolve(process.argv[2] ?? latestBuild())
const sqlPath = (p) => `'${p.replaceAll('\\', '/').replaceAll("'", "''")}'`

// Место соседа — по убыванию сходства (в файле уже так, но не полагаемся на порядок строк)
const SELECT = `
  SELECT book_id, row_number() OVER (PARTITION BY book_id ORDER BY score DESC, neighbor_id)::INTEGER AS rank,
    neighbor_id, score::DOUBLE
  FROM read_parquet(${sqlPath(FILE)})
  WHERE book_id <> neighbor_id`

async function* csvLines(result, onRows) {
  for await (const rows of result.yieldRowsJs()) {
    let chunk = ''
    for (const [book, rank, neighbor, score] of rows) chunk += `${book},${rank},${neighbor},${score}\n`
    onRows(rows.length)
    yield chunk
  }
}

async function main() {
  const started = performance.now()
  const seconds = () => ((performance.now() - started) / 1000).toFixed(1)
  console.log(`Файл: ${FILE}`)

  const duck = await (await DuckDBInstance.create(':memory:')).connect()
  const db = new pg.Client({ connectionString: config.databaseUrl })
  await db.connect()
  try {
    await db.query('BEGIN')
    await db.query(`CREATE TEMP TABLE neighbors_stage (book_id text, rank int, neighbor_id text, score real) ON COMMIT DROP`)
    let read = 0
    await pipeline(
      Readable.from(csvLines(await duck.stream(SELECT), (n) => {
        read += n
        if (read % 1_000_000 < n) console.log(`  прочитано ${read.toLocaleString('ru-RU')} — ${seconds()} с`)
      })),
      db.query(copyFrom('COPY neighbors_stage FROM STDIN WITH (FORMAT csv)')),
    )
    console.log(`Прочитано: ${read.toLocaleString('ru-RU')} пар — ${seconds()} с`)

    await db.query('TRUNCATE item_neighbors')
    await db.query('ALTER TABLE item_neighbors DROP CONSTRAINT item_neighbors_pkey')
    const { rowCount } = await db.query(`
      INSERT INTO item_neighbors (book_id, rank, neighbor_id, score)
      SELECT s.book_id, s.rank, s.neighbor_id, s.score FROM neighbors_stage s
      WHERE EXISTS (SELECT 1 FROM books b WHERE b.id = s.book_id) AND EXISTS (SELECT 1 FROM books b WHERE b.id = s.neighbor_id)
      ORDER BY s.book_id, s.rank`)
    await db.query('ALTER TABLE item_neighbors ADD CONSTRAINT item_neighbors_pkey PRIMARY KEY (book_id, rank)')
    await db.query('COMMIT')
    console.log(`Записано: ${rowCount.toLocaleString('ru-RU')} пар (без книг вне каталога: ${(read - rowCount).toLocaleString('ru-RU')}) — ${seconds()} с`)
    await db.query('ANALYZE item_neighbors')
    const { rows: [s] } = await db.query(`
      SELECT count(DISTINCT book_id)::int AS books, pg_size_pretty(pg_total_relation_size('item_neighbors')) AS size FROM item_neighbors`)
    console.log(`Книг с соседями: ${s.books.toLocaleString('ru-RU')}, таблица с индексом: ${s.size}`)
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await db.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
