// Настройки из общего .env в корне проекта (шаблон — .env.example)
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true })

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Не задана переменная окружения ${name} (см. .env.example)`)
  return value
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  port: Number(process.env.PORT ?? 3000),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
}

// Корень репозитория — для путей к data/
export const ROOT = fileURLToPath(new URL('../../', import.meta.url))
