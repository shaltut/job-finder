import { desc } from 'drizzle-orm'
import { contacts } from '../db/schema'
import { db } from '../utils/db'

export default defineEventHandler(async () => {
  return await db.select().from(contacts).orderBy(desc(contacts.updatedAt))
})
