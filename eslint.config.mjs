// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt({
  ignores: [
    // The pre-rewrite implementation, kept on this branch only as a porting reference for the job
    // lanes (M2) and the Gmail OAuth + MIME building (M4). Deleted in M5, along with these lines.
    'jobfinder.js',
    'ui.js',
    'ui.html',
    'scrape.js',
    'schema.sql'
  ]
})
