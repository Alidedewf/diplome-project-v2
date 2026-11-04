// Машинный перевод аннотаций en→ru (файл ML-части, решения.md 2.8, 4.8) → books.annotation_ru, annotation_source = 'mt'.
//
// Файл: parquet с колонками book_id (или parent_asin) и annotation_ru. Описания из Википедии (source 'wikipedia',
// scripts/load-wikidata-ru.js) не перетираются; прежний машинный перевод заменяется целиком.
//
// Запуск из backend/:  npm run load:annotations-ru [-- путь к parquet]   # по умолчанию data/processed/annotations_ru_mt.parquet
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import pg from 'pg'
import { config, ROOT } from '../src/config.js'

const DEFAULT_FILE = path.join(ROOT, 'data/processed/annotations_ru_mt.parquet')
const sqlPath = (p) => `'${p.replaceAll('\\', '/').replaceAll("'", "''")}'`

export async function loadAnnotations({ file = DEFAULT_FILE, databaseUrl = config.databaseUrl, log = console.log } = {}) {
  const duck = await (await DuckDBInstance.create(':memory:')).connect()
  const columns = (await duck.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet(${sqlPath(file)})`)).getRowObjects()
    .map((c) => c.column_name)
  const idColumn = ['book_id', 'parent_asin'].find((c) => columns.includes(c))
  if (!idColumn || !columns.includes('annotation_ru')) {
    throw new Error(`В файле нужны колонки book_id (или parent_asin) и annotation_ru, есть: ${columns.join(', ')}`)
  }
  const rows = (await duck.runAndReadAll(`SELECT ${idColumn} AS id, trim(annotation_ru) AS text
    FROM read_parquet(${sqlPath(file)}) WHERE annotation_ru IS NOT NULL AND trim(annotation_ru) <> ''`)).getRowObjects()
  duck.closeSync?.()

  const db = new pg.Client({ connectionString: databaseUrl })
  await db.connect()
  try {
    await db.query('BEGIN')
    await db.query(`UPDATE books SET annotation_ru = NULL, annotation_source = NULL, annotation_url = NULL
      WHERE annotation_source = 'mt'`)
    const { rowCount } = await db.query(`UPDATE books b SET annotation_ru = t.text, annotation_source = 'mt', annotation_url = NULL
      FROM unnest($1::text[], $2::text[]) AS t(id, text)
      WHERE b.id = t.id AND b.annotation_source IS DISTINCT FROM 'wikipedia'`,
    [rows.map((r) => r.id), rows.map((r) => r.text)])
    await db.query('COMMIT')
    log(`В файле ${rows.length} переводов, записано ${rowCount} (у остальных — описание из Википедии или книги нет в каталоге)`)
    return { rows: rows.length, written: rowCount }
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await db.end()
  }
}

if (import.meta.main) {
  loadAnnotations({ file: process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_FILE }).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
