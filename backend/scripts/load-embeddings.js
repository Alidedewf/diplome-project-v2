// Загрузка векторов книг: parquet от ML-части → таблица book_embeddings (решения.md 3.5, 3.8).
//
// Формат файла (data/processed/, считает ML-часть):
//   book_id (или parent_asin) — id книги; embedding (или vector) — список чисел FLOAT[] / DOUBLE[] / FLOAT[N];
//   название модели — колонка model (одно значение на файл), метаданные parquet model или флаг --model;
//   размерность — по длине векторов (если есть колонка или метаданные dim — сверяется с ней).
//
// Каждый запуск заменяет все векторы этой модели целиком (повторный запуск даёт тот же результат),
// векторы других моделей не трогаются. Книги, которых нет в каталоге, пропускаются (выводится их число).
// После загрузки — HNSW-индекс по косинусному расстоянию для этой модели.
//
// Запуск из backend/:  npm run load:embeddings -- путь/к/файлу.parquet [--model имя] [--work-mem 1GB]
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { parseArgs } from 'node:util'
import { DuckDBInstance } from '@duckdb/node-api'
import pg from 'pg'
import { from as copyFrom } from 'pg-copy-streams'
import { config, ROOT } from '../src/config.js'
import { hnswIndexName } from '../src/lib/embeddings.js'

const DEFAULT_FILE = path.join(ROOT, 'data/processed/book_embeddings.parquet')
const MAX_DIM = 2000 // предел HNSW в pgvector для типа vector

const sqlPath = (p) => `'${p.replaceAll('\\', '/').replaceAll("'", "''")}'`
const sqlString = (s) => `'${String(s).replaceAll("'", "''")}'`
const ident = (s) => `"${s.replaceAll('"', '""')}"`

class LoadError extends Error {}

// Колонки и метаданные файла, проверка векторов — всё в DuckDB, без загрузки файла в память
async function inspect(duck, file, modelArg) {
  const src = `read_parquet(${sqlPath(file)})`
  const columns = (await (await duck.run(`DESCRIBE SELECT * FROM ${src}`)).getRowObjectsJS())
    .map((c) => ({ name: c.column_name, type: c.column_type }))
  const pick = (...names) => columns.find((c) => names.includes(c.name.toLowerCase()))
  const idCol = pick('book_id', 'parent_asin')
  const vecCol = pick('embedding', 'vector')
  if (!idCol) throw new LoadError(`Нет колонки book_id (или parent_asin). Колонки: ${columns.map((c) => c.name).join(', ')}`)
  if (!vecCol || !/\[\d*\]$/.test(vecCol.type)) {
    throw new LoadError(`Нет колонки embedding со списком чисел. Колонки: ${columns.map((c) => `${c.name} ${c.type}`).join(', ')}`)
  }

  const meta = Object.fromEntries((await (await duck.run(
    `SELECT decode(key) AS key, decode(value) AS value FROM parquet_kv_metadata(${sqlPath(file)})`,
  )).getRowObjectsJS()).map((r) => [r.key, r.value]))

  const modelCol = pick('model')
  const dimCol = pick('dim')
  const v = `${ident(vecCol.name)}::DOUBLE[]`
  const stats = (await (await duck.run(`
    SELECT count(*)::INTEGER AS rows,
           count(DISTINCT ${ident(idCol.name)})::INTEGER AS ids,
           count(*) FILTER (WHERE ${ident(vecCol.name)} IS NULL)::INTEGER AS nulls,
           min(len(${v}))::INTEGER AS min_dim, max(len(${v}))::INTEGER AS max_dim,
           -- норма 0, NaN или бесконечность — косинусное расстояние не определено
           count(*) FILTER (WHERE NOT isfinite(list_inner_product(${v}, ${v})) OR list_inner_product(${v}, ${v}) = 0)::INTEGER AS bad
           ${modelCol ? `, list(DISTINCT ${ident(modelCol.name)}) AS models` : ''}
           ${dimCol ? `, list(DISTINCT ${ident(dimCol.name)})::INTEGER[] AS dims` : ''}
    FROM ${src}`)).getRowObjectsJS())[0]

  const models = [...new Set([modelArg, ...(stats.models ?? []), meta.model].filter(Boolean))]
  if (models.length !== 1) {
    throw new LoadError(models.length ? `Разные названия модели: ${models.join(', ')}` : 'Не указано название модели: колонка model, метаданные model или --model')
  }
  if (!stats.rows) throw new LoadError('Файл пустой')
  if (stats.nulls || stats.bad) throw new LoadError(`Плохие векторы: пустых ${stats.nulls}, с нулевой нормой или NaN — ${stats.bad}`)
  if (stats.min_dim !== stats.max_dim) throw new LoadError(`Векторы разной длины: от ${stats.min_dim} до ${stats.max_dim}`)
  const dim = stats.max_dim
  const declared = [...(stats.dims ?? []), meta.dim && Number(meta.dim)].filter(Boolean)
  if (declared.some((d) => d !== dim)) throw new LoadError(`Заявлена размерность ${declared.join(', ')}, а векторы длины ${dim}`)
  if (dim > MAX_DIM) throw new LoadError(`Размерность ${dim} больше ${MAX_DIM} — HNSW не построить`)

  return { src, idCol: idCol.name, vec: v, model: models[0], dim, rows: stats.rows, duplicates: stats.rows - stats.ids }
}

async function* csvLines(result, onRows) {
  for await (const rows of result.yieldRowsJs()) {
    // id в кавычках, вектор уже собран в DuckDB как "[…]"
    yield rows.map(([id, vec]) => `"${String(id).replaceAll('"', '""')}","${vec}"`).join('\n') + '\n'
    onRows(rows.length)
  }
}

// HNSW по косинусному расстоянию. Параллельной сборке нужна разделяемая память (/dev/shm): в Docker по умолчанию
// её 64 МБ — тогда сборка падает, и повторяем в один поток
async function buildIndex(db, { model, dim, workMem, log }) {
  const index = hnswIndexName(model)
  const sql = `CREATE INDEX ${ident(index)} ON book_embeddings
    USING hnsw ((embedding::vector(${dim})) vector_cosine_ops) WHERE model = ${sqlString(model)}`
  await db.query(`SET maintenance_work_mem = ${sqlString(workMem)}`)
  try {
    await db.query(sql)
  } catch (err) {
    if (!/shared memory|No space left/i.test(err.message)) throw err
    log(`  параллельной сборке не хватило разделяемой памяти (${err.message.split('\n')[0]}) — собираем в один поток`)
    await db.query('SET max_parallel_maintenance_workers = 0')
    await db.query(sql)
  }
  return index
}

export async function loadEmbeddings({ file = DEFAULT_FILE, model: modelArg, workMem = '1GB', databaseUrl = config.databaseUrl, log = console.log } = {}) {
  const started = performance.now()
  const seconds = () => ((performance.now() - started) / 1000).toFixed(1)
  const duck = await (await DuckDBInstance.create(':memory:')).connect()
  const db = new pg.Client({ connectionString: databaseUrl })
  await db.connect()
  try {
    const info = await inspect(duck, path.resolve(file), modelArg)
    const { model, dim } = info
    log(`Файл: ${path.resolve(file)}\nМодель: ${model}, размерность ${dim}, строк ${info.rows.toLocaleString('ru-RU')}`)

    await db.query('BEGIN')
    // Старые векторы модели и её индекс — заменяются целиком; индекс строится после вставки (так быстрее)
    await db.query(`DROP INDEX IF EXISTS ${ident(hnswIndexName(model))}`)
    await db.query(`
      INSERT INTO embedding_models (name, dim, books, loaded_at) VALUES ($1, $2, 0, now())
      ON CONFLICT (name) DO UPDATE SET dim = EXCLUDED.dim, books = 0, loaded_at = now()`, [model, dim])
    await db.query('DELETE FROM book_embeddings WHERE model = $1', [model])
    await db.query(`CREATE TEMP TABLE embeddings_stage (book_id text, embedding vector(${dim})) ON COMMIT DROP`)

    let read = 0
    const result = await duck.stream(`
      SELECT ${ident(info.idCol)}::VARCHAR, '[' || array_to_string(${info.vec}, ',') || ']' FROM ${info.src}`)
    await pipeline(
      Readable.from(csvLines(result, (n) => {
        read += n
        if (read % 100_000 < n) log(`  прочитано ${read.toLocaleString('ru-RU')} — ${seconds()} с`)
      })),
      db.query(copyFrom('COPY embeddings_stage (book_id, embedding) FROM STDIN WITH (FORMAT csv)')),
    )
    // Только книги каталога; повтор id в файле — берётся первый
    const { rowCount: loaded } = await db.query(`
      INSERT INTO book_embeddings (book_id, model, embedding)
      SELECT s.book_id, $1, s.embedding FROM embeddings_stage s JOIN books b ON b.id = s.book_id
      ON CONFLICT DO NOTHING`, [model])
    const { rows: [{ unknown }] } = await db.query(
      'SELECT count(*)::int AS unknown FROM embeddings_stage s WHERE NOT EXISTS (SELECT 1 FROM books b WHERE b.id = s.book_id)')
    await db.query('UPDATE embedding_models SET books = $2 WHERE name = $1', [model, loaded])
    await db.query('COMMIT')
    log(`Загружено: ${loaded.toLocaleString('ru-RU')} векторов — ${seconds()} с` +
      (unknown > 0 ? `; нет в каталоге: ${unknown.toLocaleString('ru-RU')}` : '') +
      (info.duplicates ? `; повторы id: ${info.duplicates}` : ''))

    const indexStarted = performance.now()
    const index = await buildIndex(db, { model, dim, workMem, log })
    await db.query('ANALYZE book_embeddings')
    log(`Индекс ${index} — ${((performance.now() - indexStarted) / 1000).toFixed(1)} с; всего ${seconds()} с`)
    return { model, dim, loaded, unknown, duplicates: info.duplicates, index }
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await db.end()
    duck.closeSync?.()
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { model: { type: 'string' }, 'work-mem': { type: 'string' } },
  })
  loadEmbeddings({ file: positionals[0], model: values.model, workMem: values['work-mem'] }).catch((err) => {
    console.error(err instanceof LoadError ? `Ошибка: ${err.message}` : err)
    process.exit(1)
  })
}
