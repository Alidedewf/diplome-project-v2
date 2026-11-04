import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { defineConfig } from 'vitest/config'

// Тесты идут в отдельной базе TEST_DATABASE_URL (создаётся и мигрируется в tests/global-setup.js)
const env = {}
config({ path: fileURLToPath(new URL('../.env', import.meta.url)), processEnv: env, quiet: true })
if (!env.TEST_DATABASE_URL) throw new Error('Не задан TEST_DATABASE_URL (см. .env.example)')
// ML-сервис в тестах не настоящий: закрытый порт (смысловая часть выключена), где нужна — fetch подменяется моком
// «Похожие» — по векторам модели test/content-8 (её загружает tests/similar.test.js; в остальных файлах векторов нет — старое правило)
const testEnv = {
  DATABASE_URL: env.TEST_DATABASE_URL, JWT_SECRET: 'test-secret',
  ML_SERVICE_URL: 'http://127.0.0.1:9', ML_TIMEOUT_MS: '300', EMBEDDING_MODEL: 'test/content-8',
}
// globalSetup (миграции, каталог) работает в этом процессе — test.env на него не действует
Object.assign(process.env, testEnv)

export default defineConfig({
  test: {
    env: testEnv,
    globalSetup: './tests/global-setup.js',
    fileParallelism: false,
    testTimeout: 15_000,
  },
})
