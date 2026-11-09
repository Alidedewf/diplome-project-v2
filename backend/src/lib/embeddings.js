// Векторы книг (решения.md 3.5, 3.8): таблицы embedding_models и book_embeddings, загрузка — scripts/load-embeddings.js.
// Смысловая часть поиска — semanticSearch; к ленте пока не подключено.
//
// У каждой модели свой HNSW-индекс по выражению embedding::vector(dim) с условием model = …
// Запрос пользуется индексом, только если в нём то же выражение и то же условие — поэтому SQL собирается здесь.
import { createHash } from 'node:crypto'
import pg from 'pg'
import { config } from '../config.js'
import { Prisma, prisma } from '../db.js'

// Имя индекса модели: читаемая часть + хеш (имена моделей длинные, лимит PostgreSQL — 63 символа)
export function hnswIndexName(model) {
  const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30)
  const hash = createHash('md5').update(model).digest('hex').slice(0, 8)
  return `book_embeddings_hnsw_${slug}_${hash}`
}

// Вектор в текстовом виде pgvector: [0.1,0.2,…]
export const vectorLiteral = (values) => `[${values.join(',')}]`

async function modelDim(model) {
  const found = await prisma.embeddingModel.findUnique({ where: { name: model } })
  if (!found) throw new Error(`Нет векторов модели ${model} (scripts/load-embeddings.js)`)
  return found.dim
}

// Ближайшие по смыслу книги к вектору (например, к эмбеддингу запроса) → [{ bookId, similarity }],
// similarity — косинусная близость, 1 — совпадение
export async function nearestToVector(vector, { model, limit = 20 }) {
  const dim = await modelDim(model)
  if (vector.length !== dim) throw new Error(`Размерность запроса ${vector.length}, у модели ${model} — ${dim}`)
  const typ = Prisma.raw(`vector(${dim})`)
  const q = Prisma.sql`${vectorLiteral(vector)}::${typ}`
  return prisma.$queryRaw`
    SELECT book_id AS "bookId", 1 - (embedding::${typ} <=> ${q}) AS similarity
    FROM book_embeddings WHERE model = ${model}
    ORDER BY embedding::${typ} <=> ${q} LIMIT ${limit}`
}

// ——— Смысловая часть поиска ———

// Кандидатов на слой HNSW при поиске. Векторы e5 скучены (близость 0,78–0,87 почти у всех), и при 100 индекс
// теряет соседей: эксперимент E5 — Recall 0,69 против 0,80 точного перебора; 400 → 0,76 за ~19 мс (предел pgvector — 1000)
export const EF_SEARCH = 400
// Смысловой запрос дольше этого — бросаем (поиск остаётся обычным): холодный индекс с диска читается секундами
const SEMANTIC_TIMEOUT_MS = 2000

// Отдельный пул для векторных запросов: настройки HNSW и таймаут — на уровне соединения, без транзакции с SET LOCAL
// (это 4 лишних обращения к базе на запрос). Итеративный обход (pgvector 0.8): фильтры поиска проверяются после
// индекса, и индекс отдаёт кандидатов, пока не наберётся нужное число подходящих; порядок relaxed — внешний ORDER BY
// восстанавливает точный
const vectorPool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 4,
  options: `-c hnsw.ef_search=${EF_SEARCH} -c hnsw.iterative_scan=relaxed_order -c statement_timeout=${SEMANTIC_TIMEOUT_MS}`,
})
vectorPool.on('error', (err) => console.warn('Пул векторных запросов:', err.message))

// Размерность моделей — в памяти: меняется только при загрузке векторов. Нет модели или размерность не та
// (перезагрузили с другой) — перечитываем, но не чаще раза в 30 с
let models = new Map()
let modelsLoadedAt = 0
async function modelDimCached(model, dim) {
  const stale = dim === undefined ? !models.has(model) : models.get(model) !== dim
  if (stale && Date.now() - modelsLoadedAt > 30_000) {
    models = new Map((await prisma.embeddingModel.findMany()).map((m) => [m.name, m.dim]))
    modelsLoadedAt = Date.now()
  }
  return models.get(model) ?? null
}
// Для тестов и после загрузки векторов
export function resetModelCache() {
  models = new Map()
  modelsLoadedAt = 0
}

// Ближайшие к вектору запроса книги с фильтрами поиска → строки books (columns) + similarity по убыванию близости,
// или null, если векторов этой модели нет в базе. where — условия на books b, как в обычном поиске
export async function semanticSearch(vector, { model, limit, where = Prisma.empty, columns }) {
  const dim = vector.length
  if ((await modelDimCached(model, dim)) !== dim) return null
  const typ = Prisma.raw(`vector(${dim})`)
  const q = Prisma.sql`${vectorLiteral(vector)}::${typ}`
  const sql = Prisma.sql`
    WITH nn AS MATERIALIZED (
      SELECT ${columns}, e.embedding::${typ} <=> ${q} AS distance
      FROM book_embeddings e JOIN books b ON b.id = e.book_id
      WHERE e.model = ${model} ${where}
      ORDER BY e.embedding::${typ} <=> ${q} LIMIT ${limit}
    )
    SELECT *, 1 - distance AS similarity FROM nn ORDER BY distance`
  return (await vectorPool.query(sql.text, sql.values)).rows
}

// «Похожие книги» по смыслу (2.6, 3.2 — content-модель): ближайшие к вектору книги bookId, без неё самой,
// с условиями where на books b → строки books (columns) + similarity. [] — у книги нет вектора этой модели
// (книги «из одного названия» в векторы не попали) или модели нет в базе. Тот же пул: ef_search 400, итеративный обход
export async function nearestBooksTo(bookId, { model, limit, where = Prisma.empty, columns }) {
  const dim = await modelDimCached(model)
  if (!dim) return []
  const typ = Prisma.raw(`vector(${dim})`)
  const seed = Prisma.sql`(SELECT embedding::${typ} FROM book_embeddings WHERE model = ${model} AND book_id = ${bookId})`
  const sql = Prisma.sql`
    WITH nn AS MATERIALIZED (
      SELECT ${columns}, e.embedding::${typ} <=> ${seed} AS distance
      FROM book_embeddings e JOIN books b ON b.id = e.book_id
      WHERE e.model = ${model} AND e.book_id <> ${bookId} ${where}
      ORDER BY e.embedding::${typ} <=> ${seed} LIMIT ${limit}
    )
    SELECT *, 1 - distance AS similarity FROM nn WHERE distance IS NOT NULL ORDER BY distance`
  return (await vectorPool.query(sql.text, sql.values)).rows
}

// Ближайшие к книге bookId точным перебором — для небольших выборок (свой каталог, ~300 книг): через HNSW с таким фильтром
// итеративный обход прошёл бы почти весь граф. «+ 0» в ORDER BY — чтобы планировщик не брал индекс
export async function nearestExactTo(bookId, { model, where = Prisma.empty, columns, limit }) {
  const dim = await modelDimCached(model)
  if (!dim) return []
  const typ = Prisma.raw(`vector(${dim})`)
  const seed = Prisma.sql`(SELECT embedding::${typ} FROM book_embeddings WHERE model = ${model} AND book_id = ${bookId})`
  // Сначала книги выборки (where — по индексу books), к ним — векторы по первичному ключу; MATERIALIZED — чтобы
  // планировщик не начал с перебора всех векторов модели
  const sql = Prisma.sql`
    WITH pool AS MATERIALIZED (SELECT ${columns} FROM books b WHERE b.id <> ${bookId} ${where})
    SELECT pool.*, 1 - (e.embedding::${typ} <=> ${seed}) AS similarity
    FROM pool JOIN book_embeddings e ON e.model = ${model} AND e.book_id = pool.id
    ORDER BY (e.embedding::${typ} <=> ${seed}) + 0 LIMIT ${limit}`
  return (await vectorPool.query(sql.text, sql.values)).rows.filter((r) => r.similarity != null)
}

// Книги по близости к вкусу — среднему вектору понравившихся (likedIds), точным перебором: для небольших выборок вроде
// своего каталога (where — условия на books b). Книги без вектора — в конце, порядок среди них — order. null — у
// понравившихся или у самих книг векторов этой модели нет (тогда вызывающий сортирует по-своему)
export async function byTaste(likedIds, { model, where = Prisma.empty, columns, order, limit, offset = 0 }) {
  const dim = await modelDimCached(model)
  if (!dim || !likedIds.length) return null
  const typ = Prisma.raw(`vector(${dim})`)
  const sql = Prisma.sql`
    WITH taste AS (
      SELECT avg(embedding::${typ}) AS v FROM book_embeddings WHERE model = ${model} AND book_id = ANY(${likedIds}::varchar[])
    )
    SELECT ${columns}, 1 - (e.embedding::${typ} <=> taste.v) AS similarity
    FROM books b CROSS JOIN taste LEFT JOIN book_embeddings e ON e.book_id = b.id AND e.model = ${model}
    WHERE taste.v IS NOT NULL ${where}
    ORDER BY e.embedding::${typ} <=> taste.v NULLS LAST, ${order} LIMIT ${limit} OFFSET ${offset}`
  const rows = (await vectorPool.query(sql.text, sql.values)).rows
  return rows.some((r) => r.similarity != null) ? rows : null
}

// Ближайшие к книге (без неё самой), без фильтров — для проверок и экспериментов
export async function nearestToBook(bookId, { model, limit = 20 }) {
  const dim = await modelDim(model)
  const typ = Prisma.raw(`vector(${dim})`)
  const seed = Prisma.sql`(SELECT embedding::${typ} FROM book_embeddings WHERE model = ${model} AND book_id = ${bookId})`
  return prisma.$queryRaw`
    SELECT book_id AS "bookId", 1 - (embedding::${typ} <=> ${seed}) AS similarity
    FROM book_embeddings WHERE model = ${model} AND book_id <> ${bookId}
    ORDER BY embedding::${typ} <=> ${seed} LIMIT ${limit}`
}
