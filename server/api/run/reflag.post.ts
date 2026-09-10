import { enqueue, stateView } from '../../utils/jobs'

export default defineEventHandler((event) => {
  enqueue('reflag')
  setResponseStatus(event, 202)
  return stateView()
})
