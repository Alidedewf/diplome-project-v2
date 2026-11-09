import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { afterAll, describe, expect, it } from 'vitest'
import { loadEmbeddings } from '../scripts/load-embeddings.js'
import { prisma } from '../src/db.js'
import { hnswIndexName, nearestToBook, nearestToVector } from '../src/lib/embeddings.js'
import { BOOKS } from './fixtures.js'

// Фиктивные векторы: книга k — точка на окружности под углом 0,2·k (плюс постоянная добавка),
// ближайшие соседи книги — книги с соседними номерами
const DIM = 8
const vectorOf = (k) => [Math.cos(k * 0.2), Math.sin(k * 0.2), 0, 0, 0, 0, 0, 0.1].slice(0, DIM)
const dir = mkdtempSync(path.join(tmpdir(), 'bookmind-emb-'))
const MODEL = 'test/circle-8'

// Parquet в формате ML-части: book_id, embedding FLOAT[], model
async function writeParquet(name, rows, { model = MODEL, extra = '' } = {}) {
  const file = path.join(dir, name).replaceAll('\\', '/')
  const values = rows.map(([id, vec]) => `('${id}', [${vec.join(',')}]::FLOAT[]${model ? `, '${model}'` : ''})`).join(',\n')
  const cols = model ? 'book_id, embedding, model' : 'book_id, embedding'
  const duck = await (await DuckDBInstance.create(':memory:')).connect()
  await duck.run(`COPY (SELECT * FROM (VALUES ${values}) t(${cols}) ${extra}) TO '${file}' (FORMAT parquet)`)
  duck.closeSync?.()
  return file
}

const load = (file, opts) => loadEmbeddings({ file, databaseUrl: process.env.DATABASE_URL, log: () => {}, ...opts })
const rows = BOOKS.map((b, k) => [b.id, vectorOf(k)])

afterAll(async () => {
  await prisma.embeddingModel.deleteMany({ where: { name: { startsWith: 'test/' } } })
  rmSync(dir, { recursive: true, force: true })
})

describe('векторы книг', () => {
  it('загрузка: размерность по файлу, книги вне каталога пропускаются, HNSW-индекс создан', async () => {
    const file = await writeParquet('ok.parquet', [...rows, ['NOPE000001', vectorOf(99)]])
    const res = await load(file)
    expect(res).toMatchObject({ model: MODEL, dim: DIM, loaded: BOOKS.length, unknown: 1 })
    expect(await prisma.embeddingModel.findUnique({ where: { name: MODEL } })).toMatchObject({ dim: DIM, books: BOOKS.length })

    const [index] = await prisma.$queryRaw`SELECT indexdef FROM pg_indexes WHERE indexname = ${hnswIndexName(MODEL)}`
    expect(index.indexdef).toMatch(/USING hnsw \(\(\(embedding\)::vector\(8\)\) vector_cosine_ops\) WITH \(m='24', ef_construction='200'\) WHERE \(\(model\)::text = 'test\/circle-8'/)
  })

  it('повторная загрузка заменяет векторы модели, другие модели не трогает', async () => {
    const other = 'test/other-4'
    await load(await writeParquet('other.parquet', rows.slice(0, 3).map(([id]) => [id, [1, 2, 3, 4]]), { model: other }))
    const again = await load(await writeParquet('half.parquet', rows.slice(0, 10)))
    expect(again.loaded).toBe(10)
    const counts = await prisma.bookEmbedding.groupBy({ by: ['model'], _count: true, orderBy: { model: 'asc' } })
    expect(counts.map((c) => [c.model, c._count])).toEqual([[MODEL, 10], [other, 3]])
    // Вернуть полный набор для следующих тестов
    await load(await writeParquet('ok2.parquet', rows))
  })

  it('ближайшие по косинусу — к вектору и к книге; запрос идёт по HNSW-индексу', async () => {
    const byVector = await nearestToVector(vectorOf(5), { model: MODEL, limit: 3 })
    expect(byVector.map((r) => r.bookId)).toEqual([BOOKS[5].id, expect.any(String), expect.any(String)])
    expect(byVector[0].similarity).toBeCloseTo(1, 5)
    expect(new Set(byVector.slice(1).map((r) => r.bookId))).toEqual(new Set([BOOKS[4].id, BOOKS[6].id]))

    const byBook = await nearestToBook(BOOKS[5].id, { model: MODEL, limit: 2 })
    expect(new Set(byBook.map((r) => r.bookId))).toEqual(new Set([BOOKS[4].id, BOOKS[6].id]))

    const plan = await prisma.$transaction(async (tx) => {
      // Без сортировки: на крошечной таблице с устаревшей статистикой иначе выбирался первичный ключ + сортировка
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`
      await tx.$executeRaw`SET LOCAL enable_sort = off`
      return tx.$queryRawUnsafe(`EXPLAIN SELECT book_id FROM book_embeddings WHERE model = '${MODEL}'
        ORDER BY embedding::vector(8) <=> '[1,0,0,0,0,0,0,0.1]'::vector(8) LIMIT 5`)
    })
    expect(plan.map((p) => p['QUERY PLAN']).join('\n')).toContain(hnswIndexName(MODEL))
    await expect(nearestToVector([1, 2, 3], { model: MODEL })).rejects.toThrow(/Размерность/)
  })

  it('--append: дописывает и обновляет часть книг, остальные векторы и индекс остаются', async () => {
    const model = 'test/append-8'
    await load(await writeParquet('base.parquet', rows.slice(0, 5), { model }))
    const res = await load(await writeParquet('more.parquet', [[BOOKS[0].id, vectorOf(30)], [BOOKS[7].id, vectorOf(7)]], { model }), { append: true })
    expect(res.loaded).toBe(2)
    expect(await prisma.embeddingModel.findUnique({ where: { name: model } })).toMatchObject({ books: 6 })
    const [{ count }] = await prisma.$queryRaw`SELECT count(*)::int FROM pg_indexes WHERE indexname = ${hnswIndexName(model)}`
    expect(count).toBe(1)
    await expect(load(await writeParquet('none.parquet', rows.slice(0, 1), { model: 'test/missing-8' }), { append: true }))
      .rejects.toThrow(/дописывать некуда/)
  })

  it('плохие файлы отклоняются, данные модели не меняются', async () => {
    const mixed = await writeParquet('mixed.parquet', [[BOOKS[0].id, [1, 2, 3]], [BOOKS[1].id, [1, 2]]])
    await expect(load(mixed)).rejects.toThrow(/разной длины/)
    const zero = await writeParquet('zero.parquet', [[BOOKS[0].id, [0, 0, 0]]])
    await expect(load(zero)).rejects.toThrow(/нулевой нормой/)
    const noModel = await writeParquet('nomodel.parquet', rows.slice(0, 2), { model: null })
    await expect(load(noModel)).rejects.toThrow(/Не указано название модели/)
    await expect(load(noModel, { model: 'test/flag-8' })).resolves.toMatchObject({ model: 'test/flag-8', loaded: 2 })
    expect(await prisma.bookEmbedding.count({ where: { model: MODEL } })).toBe(BOOKS.length)
  })
})
