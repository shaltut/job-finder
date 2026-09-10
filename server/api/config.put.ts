import { ZodError } from 'zod'
import { writeConfig } from '../utils/config'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  try {
    return writeConfig(body)
  } catch (e) {
    if (e instanceof ZodError) {
      // one readable line per bad field, rather than a wall of Zod internals
      const message = e.issues.map(i => `${i.path.join('.') || 'config'}: ${i.message}`).join('; ')
      throw createError({ statusCode: 400, message })
    }
    throw e
  }
})
