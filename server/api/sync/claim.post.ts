import { claim } from '../../utils/handoff-runtime'

// Use this machine: the standby asks the leader to stand down; the take-over completes on the next ticks
export default defineEventHandler(() => claim())
