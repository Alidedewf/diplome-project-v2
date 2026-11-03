// Ошибки API: { error: { code, message, details? } }
import { z } from 'zod'
import './zod-ru.js'

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export const notFound = (message = 'Не найдено') => new HttpError(404, 'not_found', message)
export const bookNotFound = (id) => new HttpError(404, 'book_not_found', `Книга ${id} не найдена`)

// Проверка входных данных zod-схемой; ошибка — 400 со списком полей
export function parse(schema, data) {
  const result = schema.safeParse(data)
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    throw new HttpError(400, 'validation_error', 'Некорректные данные запроса', details)
  }
  return result.data
}

// Общие параметры списков
export const pageSchema = {
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } })
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'bad_json', message: 'Тело запроса — некорректный JSON' } })
  }
  console.error(err)
  res.status(500).json({ error: { code: 'internal', message: 'Внутренняя ошибка сервера' } })
}
