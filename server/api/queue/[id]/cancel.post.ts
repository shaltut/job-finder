import { cancelQueued, stateView } from '../../../utils/jobs'

export default defineEventHandler((event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400, message: 'id must be an integer' })
  if (!cancelQueued(id)) throw createError({ statusCode: 404, message: 'not queued' })
  return stateView()
})
