// Клиент ML-сервиса (решения.md 3.8): POST /embed { texts } → { model, dim, vectors } —
// векторы уже с префиксом «query: » и нормированные.
// Сервис не обязателен: не ответил за config.mlTimeoutMs или ответил ошибкой — возвращаем null, поиск идёт
// без смысловой части. После сбоя ML_PAUSE_MS не спрашиваем вовсе, чтобы каждый поиск не ждал таймаута
import { config } from '../config.js'

const ML_PAUSE_MS = 15_000
const CACHE_SIZE = 500 // вектор запроса нужен и для следующих страниц тех же результатов

const cache = new Map()
let pausedUntil = 0
let lastError = null

// Для тестов: сбросить паузу и кэш
export function resetMl() {
  cache.clear()
  pausedUntil = 0
  lastError = null
}

export const mlStatus = () => ({ available: Date.now() >= pausedUntil, lastError })

// Вектор запроса → { model, vector } или null, если сервис недоступен
export async function embedQuery(text) {
  const key = text.trim().toLowerCase()
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key) // LRU: свежий — в конец
    cache.set(key, hit)
    return hit
  }
  if (Date.now() < pausedUntil) return null

  try {
    const res = await fetch(`${config.mlServiceUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: [text] }),
      signal: AbortSignal.timeout(config.mlTimeoutMs),
    })
    if (!res.ok) throw new Error(`ML-сервис ответил ${res.status}`)
    const body = await res.json()
    const vector = body.vectors?.[0]
    if (!body.model || !Array.isArray(vector) || vector.length !== body.dim) throw new Error('ML-сервис: неожиданный ответ')
    const result = { model: body.model, vector }
    cache.set(key, result)
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value)
    lastError = null
    return result
  } catch (err) {
    pausedUntil = Date.now() + ML_PAUSE_MS
    const message = err.name === 'TimeoutError' ? `нет ответа за ${config.mlTimeoutMs} мс` : err.message
    if (message !== lastError) console.warn(`ML-сервис недоступен (${message}) — поиск без смысловой части`)
    lastError = message
    return null
  }
}
