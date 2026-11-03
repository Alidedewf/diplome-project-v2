// Сообщения ошибок проверки по-русски (решения.md 5.3, п. 7; тест-кейс API-04).
// Свои тексты для частых случаев, остальное — встроенная русская локаль zod.
// Сообщение, заданное прямо в схеме (z.string().min(1, '…')), важнее этих.
import { z } from 'zod'

const ru = z.locales.ru()

// 1 символ, 2 символа, 5 символов
function plural(n, one, few, many) {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

const TYPES = {
  number: 'Нужно число',
  int: 'Нужно целое число',
  string: 'Нужна строка',
  boolean: 'Нужно true или false',
  array: 'Нужен список',
  object: 'Нужен объект',
}

function bound(issue, limit, side) {
  const { origin, inclusive } = issue
  const n = Number(limit)
  if (origin === 'string') {
    if (side === 'min' && n === 1) return 'Не может быть пустым'
    const chars = `${n} ${plural(n, 'символ', 'символа', 'символов')}`
    return side === 'min' ? `Не короче ${chars}` : `Не длиннее ${chars}`
  }
  if (origin === 'array' || origin === 'set') {
    const items = `${n} ${plural(n, 'элемент', 'элемента', 'элементов')}`
    if (side === 'min' && n === 1) return 'Нужен хотя бы один элемент'
    return side === 'min' ? `Не меньше ${items}` : `Не больше ${items}`
  }
  if (side === 'min') return inclusive === false ? `Должно быть больше ${limit}` : `Не меньше ${limit}`
  return inclusive === false ? `Должно быть меньше ${limit}` : `Не больше ${limit}`
}

function message(issue) {
  switch (issue.code) {
    case 'invalid_type':
      if (issue.input === undefined) return 'Обязательное поле'
      return TYPES[issue.expected]
    case 'too_small':
      return bound(issue, issue.minimum, 'min')
    case 'too_big':
      return bound(issue, issue.maximum, 'max')
    case 'invalid_value':
      return issue.values.length === 1
        ? `Должно быть ${JSON.stringify(issue.values[0])}`
        : `Допустимые значения: ${issue.values.join(', ')}`
    case 'invalid_format':
      if (issue.format === 'email') return 'Некорректный email'
      return 'Неверный формат'
    case 'unrecognized_keys':
      return `Лишние поля: ${issue.keys.join(', ')}`
  }
}

// customError вернул undefined — zod берёт текст из локали
z.config({ ...ru, customError: message })
