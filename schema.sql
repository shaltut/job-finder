-- Single owner of the schema: run by jobfinder.js and ui.js at startup (idempotent). The drafter skill relies on it.
CREATE TABLE IF NOT EXISTS posts (
  key text PRIMARY KEY, scraped_at timestamptz NOT NULL DEFAULT now(), search_term text, author text, author_url text,
  posted_age text, title text, company text, location text, remote boolean, mena boolean, emails text[],
  score smallint, reason text, text text, flags text[]);
ALTER TABLE posts ADD COLUMN IF NOT EXISTS flags text[];
CREATE TABLE IF NOT EXISTS applications (key text PRIMARY KEY REFERENCES posts(key),
  verdict text NOT NULL CHECK (verdict IN ('drafted','skipped')), reason text, recruiter_email text, gmail_draft_id text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS contacts (email text PRIMARY KEY,
  stage text NOT NULL CHECK (stage IN ('drafted','contacted','followed_up','replied','final')),
  thread_id text, last_sent_at timestamptz, note text, updated_at timestamptz NOT NULL DEFAULT now());
-- recruiter addresses are always lower-case, so HR@Acme.sa can never sit beside hr@acme.sa and bypass 'final'
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_email_lower;
ALTER TABLE contacts ADD CONSTRAINT contacts_email_lower CHECK (email = lower(email));
ALTER TABLE posts ADD COLUMN IF NOT EXISTS posted_at timestamptz;
