// Вход: POST /auth/register, POST /auth/login, GET /auth/me (2.2)
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db.js'
import { checkPassword, hashPassword, publicUser, requireAuth, signToken } from '../lib/auth.js'
import { HttpError, parse } from '../lib/http.js'

export const router = Router()

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email({ message: 'Некорректный email' }))
export const passwordSchema = z.string().min(8, 'Пароль — не короче 8 символов').max(72, 'Пароль — не длиннее 72 символов')
export const nameSchema = z.string().trim().min(1, 'Укажите имя').max(80)

const registerSchema = z.object({ email: emailSchema, password: passwordSchema, name: nameSchema })
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1) })

router.post('/register', async (req, res) => {
  const { email, password, name } = parse(registerSchema, req.body)
  if (await prisma.user.findUnique({ where: { email } })) {
    throw new HttpError(409, 'email_taken', 'Этот email уже зарегистрирован')
  }
  const user = await prisma.user.create({ data: { email, name, passwordHash: await hashPassword(password) } })
  res.status(201).json({ token: signToken(user), user: publicUser(user) })
})

router.post('/login', async (req, res) => {
  const { email, password } = parse(loginSchema, req.body)
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user || !(await checkPassword(password, user.passwordHash))) {
    throw new HttpError(401, 'invalid_credentials', 'Неверный email или пароль')
  }
  res.json({ token: signToken(user), user: publicUser(user) })
})

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) })
})
