// Клиент ML-сервиса (решения.md 3.8): лента «Для вас» — POST /recommend (ниже); POST /embed { texts } → { model, dim, vectors } —
// векторы уже с префиксом «query: » и нормированные.
// Сервис не обязателен: не ответил за config.mlTimeoutMs или ответил ошибкой — возвращаем null, поиск идёт
// без смысловой части. После сбоя ML_PAUSE_MS не спрашиваем вовсе, чтобы каждый поиск не ждал таймаута
import { config } from '../config.js'

const ML_PAUSE_MS = 15_000
const CACHE_SIZE = 500 // вектор запроса нужен и для следующих страниц тех же результатов

const cache = new Map()
let pausedUntil = 0
let lastError = null

// Для тестов: сбросить паузу и кэш (и у рекомендаций)
export function resetMl() {
  cache.clear()
  pausedUntil = 0
  lastError = null
  resetRecommend()
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

// ——— Лента «Для вас» (3.8, 4.11) ———
// POST /recommend { events, exclude, n } → { modelVersion, items: [{ bookId, score, reasons }] }; 204 — у пользователя
// нет истории, которую знают модели. Сервис без состояния: одна и та же история — один и тот же ответ, поэтому
// ответы кэшируются по телу запроса (новое действие пользователя меняет события — кэш не мешает).
// Не ответил за config.mlRecommendTimeoutMs, ответил ошибкой или рекомендатель не загружен (503) — null, бэкенд
// показывает ленту на правилах; после сбоя RECO_PAUSE_MS не спрашиваем
const RECO_PAUSE_MS = 15_000
const RECO_CACHE_SIZE = 500
const recoCache = new Map()
let recoPausedUntil = 0
let recoLastError = null

export function resetRecommend() {
  recoCache.clear()
  recoPausedUntil = 0
  recoLastError = null
}

// → { modelVersion, items } | { modelVersion: null, items: [] } (204) | null (сервис недоступен)
export async function recommendFeed(body) {
  const key = JSON.stringify(body)
  const hit = recoCache.get(key)
  if (hit) {
    recoCache.delete(key)
    recoCache.set(key, hit)
    return hit
  }
  if (Date.now() < recoPausedUntil) return null
  try {
    const res = await fetch(`${config.mlServiceUrl}/recommend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: key,
      signal: AbortSignal.timeout(config.mlRecommendTimeoutMs),
    })
    let result
    if (res.status === 204) result = { modelVersion: null, items: [] }
    else if (!res.ok) throw new Error(`ML-сервис ответил ${res.status}`)
    else {
      const data = await res.json()
      if (!Array.isArray(data.items)) throw new Error('ML-сервис: неожиданный ответ')
      result = { modelVersion: data.modelVersion ?? null, items: data.items }
    }
    recoCache.set(key, result)
    if (recoCache.size > RECO_CACHE_SIZE) recoCache.delete(recoCache.keys().next().value)
    recoLastError = null
    return result
  } catch (err) {
    recoPausedUntil = Date.now() + RECO_PAUSE_MS
    const message = err.name === 'TimeoutError' ? `нет ответа за ${config.mlRecommendTimeoutMs} мс` : err.message
    if (message !== recoLastError) console.warn(`ML-сервис: рекомендации недоступны (${message}) — лента на правилах`)
    recoLastError = message
    return null
  }
}
