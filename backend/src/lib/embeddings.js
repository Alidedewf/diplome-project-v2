// Векторы книг (решения.md 3.5, 3.8): таблицы embedding_models и book_embeddings, загрузка — scripts/load-embeddings.js.
// Пока ни к поиску, ни к ленте не подключено — следующий шаг, когда будут настоящие векторы.
//
// У каждой модели свой HNSW-индекс по выражению embedding::vector(dim) с условием model = …
// Запрос пользуется индексом, только если в нём то же выражение и то же условие — поэтому SQL собирается здесь.
import { createHash } from 'node:crypto'
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

// Ближайшие к книге (без неё самой) — основа будущих «Похожих книг» по смыслу (2.6)
export async function nearestToBook(bookId, { model, limit = 20 }) {
  const dim = await modelDim(model)
  const typ = Prisma.raw(`vector(${dim})`)
  const seed = Prisma.sql`(SELECT embedding::${typ} FROM book_embeddings WHERE model = ${model} AND book_id = ${bookId})`
  return prisma.$queryRaw`
    SELECT book_id AS "bookId", 1 - (embedding::${typ} <=> ${seed}) AS similarity
    FROM book_embeddings WHERE model = ${model} AND book_id <> ${bookId}
    ORDER BY embedding::${typ} <=> ${seed} LIMIT ${limit}`
}
