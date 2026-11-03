// HTTP-клиент настоящего API: адрес, токен, разбор ошибок { error: { code, message, details? } }
export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api').replace(/\/$/, '')

const TOKEN_KEY = 'bookmind-token'

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // приватный режим — токен живёт до перезагрузки страницы
  }
}

// message — готовый текст для пользователя; details — ошибки по полям формы [{ path, message }]
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

// Подписчик на «сессия истекла» — AuthProvider сбрасывает пользователя
let onUnauthorized = () => {}
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn
}

function toQuery(params) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== '' && v !== false) q.set(k, v === true ? '1' : String(v))
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

export async function request(path, { method = 'GET', params, body, signal } = {}) {
  const token = getToken()
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`

  let res
  try {
    res = await fetch(API_URL + path + toQuery(params), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    throw new ApiError(0, 'network', 'Сервер недоступен. Проверьте подключение и попробуйте ещё раз.')
  }

  if (res.status === 204) return null
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const error = data?.error
    if (res.status === 401 && token && error?.code !== 'invalid_credentials') onUnauthorized()
    throw new ApiError(res.status, error?.code ?? 'http_error', error?.message ?? `Ошибка сервера (${res.status})`, error?.details)
  }
  return data
}
