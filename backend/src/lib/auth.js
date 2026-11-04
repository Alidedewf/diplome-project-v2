// JWT в заголовке Authorization: Bearer <token> (решения.md, 4)
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { config } from '../config.js'
import { prisma } from '../db.js'
import { HttpError } from './http.js'

const BCRYPT_ROUNDS = 10

export const hashPassword = (password) => bcrypt.hash(password, BCRYPT_ROUNDS)
export const checkPassword = (password, hash) => bcrypt.compare(password, hash)

export const signToken = (user) =>
  jwt.sign({ sub: String(user.id) }, config.jwtSecret, { expiresIn: config.jwtExpiresIn })

export const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  createdAt: u.createdAt,
  onboardingCompleted: u.onboardingCompleted,
  readingLanguages: u.readingLanguages ?? [],
})

// Языки чтения (2.8): 'ru' | 'kk' | 'en', несколько; повторы убираем, порядок — как в списке
export const READING_LANGUAGES = ['ru', 'kk', 'en']
export const readingLanguagesSchema = z.array(z.enum(READING_LANGUAGES)).max(3)
  .transform((langs) => READING_LANGUAGES.filter((l) => langs.includes(l)))

// Читающий по-русски (2.8): все, кроме отметивших английский, — и гость, и не выбравший язык (сайт русскоязычный,
// фронт показывает им русские названия). Поднимаем книги, известные по-русски; с английским — выдача как раньше
export const prefersRussian = (user) => !(user?.readingLanguages ?? []).includes('en')

const unauthorized = () => new HttpError(401, 'unauthorized', 'Нужно войти в аккаунт')

async function userFromRequest(req) {
  const header = req.get('authorization')
  if (!header) return null
  const [scheme, token] = header.split(' ')
  if (scheme !== 'Bearer' || !token) throw unauthorized()
  let payload
  try {
    payload = jwt.verify(token, config.jwtSecret)
  } catch {
    throw new HttpError(401, 'invalid_token', 'Сессия истекла, войдите снова')
  }
  // Пользователь мог удалить аккаунт — токен тогда недействителен
  const user = await prisma.user.findUnique({ where: { id: Number(payload.sub) } })
  if (!user) throw new HttpError(401, 'invalid_token', 'Сессия истекла, войдите снова')
  return user
}

// req.user — пользователь или null (гостевой режим, 2.2)
export async function optionalAuth(req, _res, next) {
  req.user = await userFromRequest(req)
  next()
}

export async function requireAuth(req, _res, next) {
  req.user = await userFromRequest(req)
  if (!req.user) throw unauthorized()
  next()
}
