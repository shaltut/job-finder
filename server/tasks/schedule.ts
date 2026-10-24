import { scheduledArgs, tick, TICK_MS } from '../../shared/schedule'
import { readConfigLoose } from '../utils/config'
import { sqlite } from '../utils/db'
import { enqueue } from '../utils/jobs'
import { leading } from '../utils/handoff-runtime'

/**
 * The scheduled scrape (Settings → Schedule). Ticks every ten minutes; `tick()` in shared/schedule.ts
 * decides, including when to write. Runs only while the dev server is up, like the daily task.
 */
export default defineTask({
  meta: { name: 'schedule', description: 'Starts the scheduled scrape when a slot is due' },
  run() {
    // only the leading machine scrapes: the slot is the leader's, and its schedule_state arrives with the next pull
    if (!leading()) return { result: 'skipped: standby (the other machine leads)' }
    const cfg = readConfigLoose()
    const row = sqlite.prepare('SELECT last_run_at AS at FROM schedule_state WHERE id = 1').get() as { at: number | null } | undefined
    const t = tick(cfg.schedule.every, row?.at ? new Date(row.at * 1000) : null, new Date(), TICK_MS)
    if (t.save !== undefined) {
      sqlite.prepare('INSERT INTO schedule_state (id, last_run_at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET last_run_at = excluded.last_run_at')
        .run(t.save ? Math.floor(t.save.getTime() / 1000) : null)
    }
    if (!t.run) return { result: cfg.schedule.every === 'off' ? 'off' : 'not due' }

    const queued = enqueue('scrape', { ...scheduledArgs(cfg), scheduled: true, auto: true })
    const result = queued ? 'scheduled scrape queued' : 'scheduled scrape skipped — a scrape is already running or queued'
    console.log(`[schedule] ${result}`)
    return { result }
  }
})
