import request from 'supertest'
import { createApp } from '../src/app.js'

export const app = createApp()

let n = 0
// Новый пользователь на каждый тест — тесты не зависят друг от друга
export async function registerUser(overrides = {}) {
  const body = { email: `user${Date.now()}-${n++}@example.com`, password: 'secret123', name: 'Тестовый Читатель', ...overrides }
  const res = await request(app).post('/api/auth/register').send(body).expect(201)
  return { ...body, token: res.body.token, user: res.body.user, auth: { Authorization: `Bearer ${res.body.token}` } }
}
