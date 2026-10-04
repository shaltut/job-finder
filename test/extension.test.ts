// The LinkedIn clipper's pure parts (extension/lib.js). The author rule must match readCards() in
// scraper/run.ts exactly: the key is dedupeKey(authorUrl, text), so a different URL means a duplicate row.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authorOf, MORE_LABEL, postLinkOf, resultLabel } from '../extension/lib.js'

const L = (href: string, text = '') => ({ href, text })

test('the author is the most repeated profile link, query stripped — the scraper\'s rule', () => {
  // a repost: the resharer is linked twice, the real author three times
  const a = authorOf([
    L('https://www.linkedin.com/in/resharer?miniProfile=1', 'Res Harer'), L('https://www.linkedin.com/in/resharer'),
    L('https://www.linkedin.com/in/author?trk=x', 'Jane Author\nRecruiter at Acme'), L('https://www.linkedin.com/in/author'),
    L('https://www.linkedin.com/in/author')
  ])
  assert.deepEqual(a, { url: 'https://www.linkedin.com/in/author', name: 'Jane Author' })
  assert.deepEqual(authorOf([L('https://www.linkedin.com/company/acme/', 'Acme')]), { url: 'https://www.linkedin.com/company/acme/', name: 'Acme' })
  assert.equal(authorOf([L('https://www.linkedin.com/feed/hashtag/hiring')]), null, 'no profile link, no author')
  // ties keep DOM order, like the scraper's stable sort
  assert.equal(authorOf([L('https://www.linkedin.com/in/first'), L('https://www.linkedin.com/in/second')])?.url, 'https://www.linkedin.com/in/first')
})

test('the post link is a LinkedIn permalink or nothing', () => {
  assert.equal(postLinkOf(['https://lnkd.in/abc', 'https://www.linkedin.com/feed/update/urn:li:activity:7123/?utm=1']),
    'https://www.linkedin.com/feed/update/urn:li:activity:7123/')
  assert.equal(postLinkOf(['https://www.linkedin.com/posts/jane_hiring-activity-7123-AbCd?trk=x']), 'https://www.linkedin.com/posts/jane_hiring-activity-7123-AbCd')
  assert.equal(postLinkOf(['https://www.linkedin.com/in/jane', 'https://example.com/posts/1']), null)
})

test('the expander label is the scraper\'s, both languages', async () => {
  const { MORE_LABEL: scraper } = await import('../scraper/lib.ts')
  assert.equal(MORE_LABEL.source, scraper.source)
  assert.ok(MORE_LABEL.test('…more'))
  assert.ok(MORE_LABEL.test('… المزيد'))
  assert.ok(!MORE_LABEL.test('see more jobs'))
})

test('the button says what happened', () => {
  assert.equal(resultLabel(202, { queued: true }).text, '✓ Added')
  assert.equal(resultLabel(200, { duplicate: true }).text, 'Already have it')
  assert.equal(resultLabel(200, { queued: false }).text, 'Already queued')
  assert.match(resultLabel(422, { error: 'no contact route in this post', enabled: ['email'] }).text, /No contact route.*email/)
  assert.match(resultLabel(422, { error: 'Settings are incomplete — x' }).text, /Settings are incomplete/)
  assert.equal(resultLabel(0, {}).text, 'Job Finder not running')
  assert.match(resultLabel(403, {}).text, /refused/)
  assert.equal(resultLabel(202, { queued: true }).tone, 'ok')
  assert.equal(resultLabel(0, {}).tone, 'error')
})
