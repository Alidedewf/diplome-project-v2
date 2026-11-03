import { CircleAlert, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { dropEvents } from '../../api/events.js'
import { useDeleteAccount, useUpdateProfile } from '../../api/queries.js'
import { useAuth } from '../../auth/context.js'
import { Button } from '../../components/Button.jsx'
import { TextField } from '../../components/TextField.jsx'
import { useToast } from '../../components/toast-context.js'
import { PageHeader } from './parts.jsx'

// Профиль и аккаунт (2.2, п. 6): имя, email, пароль, удаление аккаунта со всеми данными.
// Смена email и пароля — только с текущим паролем (так требует сервер)
const since = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })

// Ошибки сервера → { поле: текст }; неверный пароль и занятый email — тоже у своих полей
function fieldErrors(error, passwordField = 'currentPassword') {
  if (!error) return {}
  const errors = Object.fromEntries((error.details ?? []).map((d) => [d.path, d.message]))
  if (error.code === 'wrong_password') errors[passwordField] = error.message
  if (error.code === 'email_taken') errors.email = error.message
  return errors
}

function FormError({ error, fields }) {
  if (!error || Object.keys(fields).length) return null
  return (
    <p role="alert" className="flex items-start gap-2 rounded-lg bg-smart-soft px-3 py-2.5 text-sm text-smart-text">
      <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
      {error.message}
    </p>
  )
}

function Section({ title, description, children, danger }) {
  return (
    <section className={`rounded-2xl border bg-surface p-4 sm:p-6 ${danger ? 'border-red-500/30' : 'border-line'}`}>
      <h2 className="text-lg font-semibold">{title}</h2>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      <div className="mt-5">{children}</div>
    </section>
  )
}

function ProfileForm() {
  const { user, updateUser } = useAuth()
  const toast = useToast()
  const save = useUpdateProfile()
  const [name, setName] = useState(user.name)
  const [email, setEmail] = useState(user.email)
  const [currentPassword, setCurrentPassword] = useState('')
  const emailChanged = email.trim().toLowerCase() !== user.email
  const changed = name.trim() !== user.name || emailChanged
  const errors = fieldErrors(save.error)

  const submit = (e) => {
    e.preventDefault()
    const body = { name: name.trim(), ...(emailChanged && { email: email.trim(), currentPassword }) }
    save.mutate(body, {
      onSuccess: (next) => {
        updateUser(next)
        setName(next.name)
        setEmail(next.email)
        setCurrentPassword('')
        toast('Профиль сохранён')
      },
    })
  }

  return (
    <form onSubmit={submit} className="flex max-w-md flex-col gap-4" noValidate>
      <TextField label="Имя" name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} required />
      <TextField label="Email" name="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} required />
      {emailChanged && (
        <TextField
          label="Текущий пароль"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          hint="Чтобы сменить email, подтвердите, что это вы"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          error={errors.currentPassword}
          required
        />
      )}
      <FormError error={save.error} fields={errors} />
      <div>
        <Button type="submit" variant="primary" disabled={!changed || save.isPending || (emailChanged && !currentPassword)}>
          {save.isPending ? 'Сохраняем…' : 'Сохранить'}
        </Button>
      </div>
    </form>
  )
}

function PasswordForm() {
  const toast = useToast()
  const save = useUpdateProfile()
  const [form, setForm] = useState({ currentPassword: '', password: '', repeat: '' })
  const [mismatch, setMismatch] = useState(false)
  const errors = fieldErrors(save.error)
  const field = (key) => ({ value: form[key], onChange: (e) => setForm({ ...form, [key]: e.target.value }) })

  const submit = (e) => {
    e.preventDefault()
    if (form.password !== form.repeat) return setMismatch(true)
    setMismatch(false)
    save.mutate(
      { password: form.password, currentPassword: form.currentPassword },
      {
        onSuccess: () => {
          setForm({ currentPassword: '', password: '', repeat: '' })
          toast('Пароль изменён')
        },
      },
    )
  }

  return (
    <form onSubmit={submit} className="flex max-w-md flex-col gap-4" noValidate>
      <TextField label="Текущий пароль" type="password" autoComplete="current-password" {...field('currentPassword')} error={errors.currentPassword} />
      <TextField
        label="Новый пароль"
        type="password"
        autoComplete="new-password"
        hint="Не короче 8 символов"
        {...field('password')}
        error={errors.password}
      />
      <TextField
        label="Повторите новый пароль"
        type="password"
        autoComplete="new-password"
        {...field('repeat')}
        error={mismatch ? 'Пароли не совпадают' : undefined}
      />
      <FormError error={save.error} fields={errors} />
      <div>
        <Button type="submit" variant="primary" disabled={save.isPending || !form.currentPassword || !form.password || !form.repeat}>
          {save.isPending ? 'Сохраняем…' : 'Сменить пароль'}
        </Button>
      </div>
    </form>
  )
}

function DeleteAccount() {
  const { logout } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const remove = useDeleteAccount()
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const errors = fieldErrors(remove.error, 'password')

  const submit = (e) => {
    e.preventDefault()
    remove.mutate(password, {
      onSuccess: () => {
        // сигналы удалённого пользователя уже некому отправлять
        dropEvents()
        logout()
        navigate('/', { replace: true })
        toast('Аккаунт удалён')
      },
    })
  }

  if (!open) {
    return (
      <Button variant="danger-outline" onClick={() => setOpen(true)}>
        Удалить аккаунт
      </Button>
    )
  }

  return (
    <form onSubmit={submit} className="flex max-w-md flex-col gap-4">
      <p className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2.5 text-sm text-red-800 dark:text-red-300">
        <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
        Удалятся полки, оценки, профиль вкусов и вся история. Отменить это нельзя.
      </p>
      <TextField
        label="Пароль для подтверждения"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={errors.password}
        autoFocus
      />
      <FormError error={remove.error} fields={errors} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" disabled={!password || remove.isPending}>
          {remove.isPending ? 'Удаляем…' : 'Удалить навсегда'}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setOpen(false)
            setPassword('')
            remove.reset()
          }}
        >
          Отмена
        </Button>
      </div>
    </form>
  )
}

export function SettingsPage() {
  const { user } = useAuth()
  return (
    <>
      <PageHeader title="Профиль и аккаунт" subtitle={`С нами с ${since.format(new Date(user.createdAt))}.`} />
      <div className="flex flex-col gap-4">
        <Section title="Профиль">
          <ProfileForm />
        </Section>
        <Section title="Пароль">
          <PasswordForm />
        </Section>
        <Section title="Удаление аккаунта" description="Все ваши данные будут удалены с сервера — это защита персональных данных." danger>
          <DeleteAccount />
        </Section>
      </div>
    </>
  )
}
