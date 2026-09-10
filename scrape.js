#!/usr/bin/env node
// One command to scrape: make sure the UI is up, queue a run in its scrape lane, follow the log.
// Going through the UI (rather than jobfinder.js directly) keeps the Chrome profile lock in one place
// and puts the log in the Run tab.
//   ./scrape.js
//   ./scrape.js --since past-week --max 20 --terms "hl7 fhir,backend lead"
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const UI = 'http://127.0.0.1:3939';
const { values } = parseArgs({ options: { terms: { type: 'string' }, max: { type: 'string' }, since: { type: 'string' } } });
const body = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
const up = async () => { try { return (await fetch(`${UI}/api/job`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!await up()) {
  console.log('starting the UI…');
  fs.mkdirSync('logs', { recursive: true });
  const log = fs.openSync('logs/ui.log', 'a');
  spawn('npm', ['run', 'ui'], { detached: true, stdio: ['ignore', log, log] }).unref();
  for (let i = 0; i < 25 && !await up(); i++) await sleep(1000);
  if (!await up()) { console.error(`the UI never came up on ${UI} — see logs/ui.log`); process.exit(1); }
  spawn('open', [UI], { stdio: 'ignore' }).unref();
}

const res = await fetch(`${UI}/api/run/scrape`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const st = await res.json();
if (!res.ok) { console.error(st.error || `the UI refused the run (${res.status})`); process.exit(1); }
// enqueue() pumps synchronously, so our job is either already running or the newest scrape item in the queue.
const id = st.lanes.scrape.current?.id ?? Math.max(...st.queue.filter(q => q.lane === 'scrape').map(q => q.id));
console.log(`scrape #${id} ${st.lanes.scrape.current?.id === id ? 'started' : 'queued'} — ${UI}`);

let seen = 0; // ponytail: the UI keeps only the last 300 log lines, so a very chatty run drops the middle here. Run tab has the rest.
for (;;) {
  const s = await (await fetch(`${UI}/api/job`)).json();
  const job = [s.lanes.scrape.current, s.lanes.scrape.last].find(j => j?.id === id);
  if (job) { job.log.slice(seen).forEach(l => console.log(l)); seen = Math.max(seen, job.log.length); }
  if (job && !job.running) {
    if (job.exit === 2) console.error('\nLinkedIn login expired. Run:  npm run login');
    process.exit(job.exit ?? 1);
  }
  await sleep(2000);
}
