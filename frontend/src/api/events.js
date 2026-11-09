// Неявные сигналы для модели (POST /me/events): view — открыл карточку книги, rec_click — кликнул по рекомендации.
// Копим и отправляем пачкой раз в полсекунды; при закрытии вкладки — сразу, с keepalive. Только после входа
import { getToken } from './http.js'
import { sendEvents } from './index.js'

const BATCH = 50 // больше сервер не принимает за раз
let queue = []
let timer = null

function flush({ keepalive = false } = {}) {
  clearTimeout(timer)
  timer = null
  while (queue.length) {
    // сигналы не важнее интерфейса: ошибку не показываем и не повторяем
    sendEvents(queue.splice(0, BATCH), { keepalive }).catch(() => {})
  }
}

export function track(event) {
  if (!getToken()) return
  queue.push(event)
  timer ??= setTimeout(flush, 500)
}

// Вход и выход: сигналы уходят со старым токеном, пока он ещё действует
export const flushEvents = () => flush()

// Сессия истекла (401) — старый токен уже не примут, сигналы выбрасываем
export function dropEvents() {
  clearTimeout(timer)
  timer = null
  queue = []
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => flush({ keepalive: true }))
}

// place — где была рекомендация: for_you, because_you_liked, similar
export const trackRecClick = (book, reason, place) =>
  track({ type: 'rec_click', bookId: book.id, payload: { kind: reason?.kind ?? null, seedId: reason?.seedId ?? reason?.seed?.id ?? null, place } })
