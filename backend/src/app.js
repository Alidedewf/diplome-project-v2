import cors from 'cors'
import express from 'express'
import { config } from './config.js'
import { errorHandler, notFound } from './lib/http.js'
import { router as auth } from './routes/auth.js'
import { router as books } from './routes/books.js'
import { router as me } from './routes/me.js'
import { router as recommendations } from './routes/recommendations.js'
import { router as search } from './routes/search.js'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.use(cors({ origin: config.corsOrigin }))
  app.use(express.json({ limit: '100kb' }))

  const api = express.Router()
  api.get('/health', (_req, res) => res.json({ ok: true }))
  api.use('/auth', auth)
  api.use('/me', me)
  api.use(books)
  api.use(search)
  api.use(recommendations)
  api.use(() => {
    throw notFound('Нет такого адреса API')
  })

  app.use('/api', api)
  app.use(errorHandler)
  return app
}
