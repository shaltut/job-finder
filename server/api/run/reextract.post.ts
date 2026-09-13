import { enqueue, stateView } from '../../utils/jobs'

export default defineEventHandler((event) => {
  enqueue('reextract')
  setResponseStatus(event, 202)
  return stateView()
})
