import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { app, registerUser } from './helpers.js'

describe('вход', () => {
  it('регистрация возвращает токен и пользователя, кириллица в имени сохраняется', async () => {
    const u = await registerUser({ name: 'Алихан' })
    expect(u.token).toBeTypeOf('string')
    expect(u.user).toMatchObject({ email: u.email, name: 'Алихан', onboardingCompleted: false })
    expect(u.user).not.toHaveProperty('passwordHash')
  })

  it('email не зависит от регистра и не регистрируется дважды', async () => {
    const u = await registerUser()
    const res = await request(app).post('/api/auth/register')
      .send({ email: u.email.toUpperCase(), password: 'another123', name: 'X' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('email_taken')
  })

  it('некорректные данные — 400 со списком полей', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'not-an-email', password: '123', name: '' })
    expect(res.status).toBe(400)
    expect(res.body.error.details.map((d) => d.path).sort()).toEqual(['email', 'name', 'password'])
  })

  it('вход по паролю, /auth/me по токену', async () => {
    const u = await registerUser()
    const login = await request(app).post('/api/auth/login').send({ email: u.email, password: u.password }).expect(200)
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`).expect(200)
    expect(me.body.user.id).toBe(u.user.id)
  })

  it('неверный пароль и запросы без токена отклоняются', async () => {
    const u = await registerUser()
    await request(app).post('/api/auth/login').send({ email: u.email, password: 'wrong-pass' }).expect(401)
    await request(app).get('/api/auth/me').expect(401)
    await request(app).get('/api/me/shelves').expect(401)
    await request(app).get('/api/auth/me').set('Authorization', 'Bearer garbage').expect(401)
  })

  it('имя меняется свободно, пароль — только с текущим паролем', async () => {
    const u = await registerUser()
    const renamed = await request(app).patch('/api/me/profile').set(u.auth).send({ name: 'Новое имя' }).expect(200)
    expect(renamed.body.user.name).toBe('Новое имя')
    await request(app).patch('/api/me/profile').set(u.auth).send({ password: 'newsecret1' }).expect(403)
    await request(app).patch('/api/me/profile').set(u.auth)
      .send({ password: 'newsecret1', currentPassword: u.password }).expect(200)
    await request(app).post('/api/auth/login').send({ email: u.email, password: u.password }).expect(401)
    await request(app).post('/api/auth/login').send({ email: u.email, password: 'newsecret1' }).expect(200)
  })

  it('после удаления аккаунта токен недействителен', async () => {
    const u = await registerUser()
    await request(app).delete('/api/me').set(u.auth).send({ password: 'wrong-pass' }).expect(403)
    await request(app).delete('/api/me').set(u.auth).send({ password: u.password }).expect(204)
    await request(app).get('/api/auth/me').set(u.auth).expect(401)
  })
})
