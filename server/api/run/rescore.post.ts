import { enqueue, stateView } from '../../utils/jobs'

export default defineEventHandler((event) => {
  enqueue('rescore')
  setResponseStatus(event, 202)
  return stateView()
})
