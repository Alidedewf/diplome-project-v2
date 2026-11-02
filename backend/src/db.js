import { PrismaPg } from '@prisma/adapter-pg'
import prismaClient from './generated/prisma/index.js'
import { config } from './config.js'

const { PrismaClient, Prisma } = prismaClient

export { Prisma }
export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) })
