import { changeSig } from '../../utils/db'
import { pushNow } from '../../utils/handoff-runtime'

export default defineEventHandler(() => pushNow(changeSig()))
