import { createApp } from './app.js'
import { config } from './config.js'
import { prisma } from './db.js'

const server = createApp().listen(config.port, () => {
  console.log(`API: http://localhost:${config.port}/api`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => prisma.$disconnect().then(() => process.exit(0))))
}
