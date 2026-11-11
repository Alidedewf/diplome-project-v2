// Перед тестами: создать базу bookmind_test (если нет), применить миграции, залить маленький каталог
import { execSync } from 'node:child_process'
import pg from 'pg'
import { BOOKS } from './fixtures.js'

export async function setup() {
  const url = new URL(process.env.DATABASE_URL)
  const name = url.pathname.slice(1)
  const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString() })
  await admin.connect()
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
  if (!rowCount) await admin.query(`CREATE DATABASE "${name}"`)
  await admin.end()

  execSync('npx prisma migrate deploy', { env: process.env, stdio: 'pipe' })

  const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  await db.query('TRUNCATE users, books, embedding_models, item_neighbors RESTART IDENTITY CASCADE')
  for (const b of BOOKS) {
    await db.query(
      `INSERT INTO books (id, title, author, year, section, category, subsection, cover, annotation, rating, ratings_count, weighted_rating)
       VALUES ($1, $2, $3, $4, $5, $12, $6, $7, $8, $9, $10, $11)`,
      [b.id, b.title, b.author, b.year, b.section, b.subsection, `https://example.com/${b.id}.jpg`, `About ${b.title}`, b.rating, b.ratingsCount, b.weightedRating, b.category ?? b.section],
    )
  }
  await db.end()
}
