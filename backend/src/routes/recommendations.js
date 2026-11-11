// Рекомендации и онбординг (2.3, 2.4, 3.8): services/recommender.js — «Для вас» из ML-сервиса, без него — правила
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db.js'
import { optionalAuth, publicUser, readingLanguagesSchema, requireAuth } from '../lib/auth.js'
import { HttpError, parse } from '../lib/http.js'
import { getOnboardingRound, getRecommendations, onboardingSession } from '../services/recommender.js'

export const router = Router()

const feedSchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(16) })

// Гостю — популярное (2.2), после входа — персональная лента
router.get('/recommendations', optionalAuth, async (req, res) => {
  const { limit } = parse(feedSchema, req.query)
  res.json(await getRecommendations(req.user?.id, { limit }))
})

router.get('/onboarding/next-round', requireAuth, async (req, res) => {
  res.json(await getOnboardingRound(req.user.id))
})

// Шаг 1 — темы (заменяют выбранные ранее в онбординге) и описание своими словами, шаг 2 — ответы на книги раунда.
// Каждый проход онбординга — сессия; completed: true — настоящее завершение: закрывает сессию и ставит
// onboardingCompleted. «Пропустить» completed не шлёт — ответы сохраняются, возврат продолжает ту же сессию (2.3).
// completed: false ничего не меняет
const answersSchema = z.object({
  topics: z.array(z.object({
    kind: z.enum(['section', 'subsection']),
    value: z.string().trim().min(1).max(200),
  })).max(50).optional(),
  description: z.string().trim().max(500).optional(), // «Опишите своими словами» — для смыслового подбора (ML)
  readingLanguages: readingLanguagesSchema.optional(), // «На каком языке читаете?» (2.8); [] — сбросить
  round: z.number().int().min(1).max(10).default(1),
  answers: z.array(z.object({
    bookId: z.string().min(1).max(16),
    answer: z.enum(['like', 'dislike', 'unread']), // «Нравится» / «Не моё» / «Не читал»
    source: z.enum(['round', 'search']).default('round'), // search — добавлена через «Добавить книгу, которую читали»
  })).max(50).default([]),
  completed: z.boolean().optional(),
})

router.post('/onboarding/answers', requireAuth, async (req, res) => {
  const { topics, description, readingLanguages, round, answers, completed } = parse(answersSchema, req.body)
  const userId = req.user.id
  const ids = [...new Set(answers.map((a) => a.bookId))]
  if ((await prisma.book.count({ where: { id: { in: ids } } })) !== ids.length) {
    throw new HttpError(404, 'book_not_found', 'Книга не найдена')
  }

  const user = await prisma.$transaction(async (tx) => {
    const { session, answered } = await onboardingSession(userId, tx)
    if (topics) {
      const keep = topics.map((t) => `${t.kind}:${t.value}`)
      const old = await tx.userTopic.findMany({ where: { userId, source: 'onboarding', rejected: false } })
      const stale = old.filter((t) => !keep.includes(`${t.kind}:${t.value}`)).map((t) => t.id)
      await tx.userTopic.deleteMany({ where: { id: { in: stale } } })
      for (const t of topics) {
        await tx.userTopic.upsert({
          where: { userId_kind_value: { userId, kind: t.kind, value: t.value } },
          create: { userId, kind: t.kind, value: t.value, source: 'onboarding' },
          update: { rejected: false },
        })
      }
    }
    if (description) {
      // Одно описание на сессию — новое заменяет прежнее
      await tx.event.deleteMany({ where: { userId, type: 'onboarding_description', payload: { path: ['session'], equals: session } } })
      await tx.event.create({ data: { userId, type: 'onboarding_description', query: description, payload: { session } } })
    }
    if (answers.length) {
      // Повторный ответ на ту же книгу заменяет прежний
      await tx.event.deleteMany({ where: { userId, type: 'onboarding_answer', bookId: { in: ids } } })
      await tx.event.createMany({
        data: answers.map((a) => ({
          userId, type: 'onboarding_answer', bookId: a.bookId,
          payload: { answer: a.answer, round, session, source: a.source },
        })),
      })
    }
    const data = { ...(readingLanguages && { readingLanguages }) }
    if (completed) {
      // Пустую сессию не закрываем: повторный completed: true не плодит сессий
      if (answered || answers.length) {
        await tx.event.create({ data: { userId, type: 'onboarding_complete', payload: { session } } })
      }
      data.onboardingCompleted = true
    }
    return Object.keys(data).length
      ? tx.user.update({ where: { id: userId }, data })
      : tx.user.findUnique({ where: { id: userId } })
  })
  res.json({ saved: answers.length, user: publicUser(user) })
})
