/** Ordered, append-only. Never edit a shipped migration; add a new one. */
export const migrations: readonly string[] = [
  `
  CREATE TABLE account (
    id            TEXT PRIMARY KEY,
    provider      TEXT NOT NULL CHECK (provider IN ('gmail','microsoft','imap')),
    email         TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL DEFAULT '',
    color         TEXT NOT NULL DEFAULT '#6366f1',
    auth_ref      TEXT,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE folder (
    id            TEXT PRIMARY KEY,
    account_id    TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    path          TEXT NOT NULL,
    role          TEXT,
    uidvalidity   INTEGER,
    highestmodseq TEXT,
    UNIQUE (account_id, path)
  );

  CREATE TABLE thread (
    id            TEXT PRIMARY KEY,
    subject_norm  TEXT NOT NULL DEFAULT '',
    last_date     INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE message (
    id            TEXT PRIMARY KEY,
    account_id    TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    folder_id     TEXT NOT NULL REFERENCES folder(id) ON DELETE CASCADE,
    uid           INTEGER NOT NULL,
    message_id    TEXT,
    thread_id     TEXT REFERENCES thread(id) ON DELETE SET NULL,
    from_addr     TEXT NOT NULL DEFAULT '',
    to_addrs      TEXT NOT NULL DEFAULT '',
    subject       TEXT NOT NULL DEFAULT '',
    date          INTEGER NOT NULL DEFAULT 0,
    flags         TEXT NOT NULL DEFAULT '',
    snippet       TEXT NOT NULL DEFAULT '',
    category      TEXT,
    UNIQUE (folder_id, uid)
  );
  CREATE INDEX message_thread_idx ON message(thread_id);
  CREATE INDEX message_date_idx ON message(date DESC);

  CREATE VIRTUAL TABLE message_fts USING fts5(
    subject, from_addr, body,
    content='', tokenize='unicode61 remove_diacritics 2'
  );
  `,
  `
  ALTER TABLE account ADD COLUMN config     TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE account ADD COLUMN last_error TEXT;
  ALTER TABLE folder  ADD COLUMN name       TEXT NOT NULL DEFAULT '';
  ALTER TABLE message ADD COLUMN from_name  TEXT NOT NULL DEFAULT '';
  CREATE INDEX message_folder_uid_idx ON message(folder_id, uid DESC);
  `,
  `
  ALTER TABLE message ADD COLUMN refs TEXT NOT NULL DEFAULT '';
  CREATE INDEX message_msgid_idx ON message(account_id, message_id);

  CREATE TABLE message_body (
    message_id  TEXT PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
    html        TEXT,
    text        TEXT NOT NULL DEFAULT '',
    to_text     TEXT NOT NULL DEFAULT '',
    cc_text     TEXT NOT NULL DEFAULT '',
    attachments TEXT NOT NULL DEFAULT '[]',
    truncated   INTEGER NOT NULL DEFAULT 0,
    fetched_at  INTEGER NOT NULL
  );

  CREATE TABLE image_allow (address TEXT PRIMARY KEY);
  `,
  `
  ALTER TABLE account ADD COLUMN signature TEXT NOT NULL DEFAULT '';

  CREATE TABLE draft (
    id         TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    payload    TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Queued sends survive a restart. 'sent' rows are kept briefly so the UI can confirm them.
  CREATE TABLE outbox (
    id         TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    payload    TEXT NOT NULL,
    send_at    INTEGER NOT NULL,
    state      TEXT NOT NULL DEFAULT 'queued',
    error      TEXT,
    subject    TEXT NOT NULL DEFAULT '',
    to_text    TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  `
]
