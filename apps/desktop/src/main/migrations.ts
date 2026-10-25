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
  `,
  `
  -- Full-text search. The first-pass contentless table could not be updated, so replace it
  -- with a normal FTS5 table kept in step with message and message_body by triggers.
  DROP TABLE IF EXISTS message_fts;
  CREATE VIRTUAL TABLE message_fts USING fts5(
    subject, sender, recipients, body,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  INSERT INTO message_fts (rowid, subject, sender, recipients, body)
    SELECT m.rowid, m.subject, m.from_name || ' ' || m.from_addr, m.to_addrs, COALESCE(b.text, '')
      FROM message m LEFT JOIN message_body b ON b.message_id = m.id;

  CREATE TRIGGER message_fts_ai AFTER INSERT ON message BEGIN
    INSERT INTO message_fts (rowid, subject, sender, recipients, body)
      VALUES (new.rowid, new.subject, new.from_name || ' ' || new.from_addr, new.to_addrs, '');
  END;
  CREATE TRIGGER message_fts_ad AFTER DELETE ON message BEGIN
    DELETE FROM message_fts WHERE rowid = old.rowid;
  END;
  CREATE TRIGGER message_fts_au AFTER UPDATE OF subject, from_name, from_addr, to_addrs ON message BEGIN
    UPDATE message_fts
       SET subject = new.subject, sender = new.from_name || ' ' || new.from_addr,
           recipients = new.to_addrs
     WHERE rowid = new.rowid;
  END;
  CREATE TRIGGER message_body_fts_ai AFTER INSERT ON message_body BEGIN
    UPDATE message_fts SET body = new.text
     WHERE rowid = (SELECT rowid FROM message WHERE id = new.message_id);
  END;
  CREATE TRIGGER message_body_fts_au AFTER UPDATE OF text ON message_body BEGIN
    UPDATE message_fts SET body = new.text
     WHERE rowid = (SELECT rowid FROM message WHERE id = new.message_id);
  END;
  `,
  `
  -- Smart categories: 'category' is what the rules decided, 'category_manual' is your override.
  ALTER TABLE message ADD COLUMN category_manual TEXT;
  CREATE INDEX message_category_idx ON message(category);

  CREATE TABLE deal (
    id           TEXT PRIMARY KEY,
    account_id   TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    message_id   TEXT,
    brand        TEXT NOT NULL,
    stage        TEXT NOT NULL DEFAULT 'lead',
    rate         REAL,
    currency     TEXT NOT NULL DEFAULT 'USD',
    deliverables TEXT NOT NULL DEFAULT '',
    due_date     INTEGER,
    notes        TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    paid_at      INTEGER
  );
  `,
  `
  -- Scam shield. 'risk' is the rules' verdict; 'risk_safe' is you saying it is fine.
  ALTER TABLE message ADD COLUMN risk TEXT;
  ALTER TABLE message ADD COLUMN risk_reasons TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE message ADD COLUMN risk_safe INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE message_body ADD COLUMN reply_to TEXT NOT NULL DEFAULT '';
  ALTER TABLE message_body ADD COLUMN auth_results TEXT NOT NULL DEFAULT '';
  ALTER TABLE message_body ADD COLUMN links TEXT NOT NULL DEFAULT '[]';
  `,
  `
  CREATE TABLE template (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    subject     TEXT NOT NULL DEFAULT '',
    html        TEXT NOT NULL DEFAULT '',
    attachments TEXT NOT NULL DEFAULT '[]',
    updated_at  INTEGER NOT NULL
  );
  `,
  `
  -- Snoozed mail is hidden from lists until 'until', then wakes as unread.
  CREATE TABLE snooze (
    message_id TEXT PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
    until      INTEGER NOT NULL
  );
  CREATE INDEX snooze_until_idx ON snooze(until);
  `,
  `
  -- Meetings: invitations you received and meetings you organize.
  CREATE TABLE event (
    id            TEXT PRIMARY KEY,
    account_id    TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    uid           TEXT NOT NULL,
    recurrence_id INTEGER,
    sequence      INTEGER NOT NULL DEFAULT 0,
    summary       TEXT NOT NULL DEFAULT '',
    description   TEXT NOT NULL DEFAULT '',
    location      TEXT NOT NULL DEFAULT '',
    start         INTEGER NOT NULL,
    end           INTEGER NOT NULL,
    all_day       INTEGER NOT NULL DEFAULT 0,
    rrule         TEXT,
    exdates       TEXT NOT NULL DEFAULT '[]',
    organizer     TEXT,
    attendees     TEXT NOT NULL DEFAULT '[]',
    status        TEXT NOT NULL DEFAULT 'CONFIRMED',
    online_url    TEXT,
    free          INTEGER NOT NULL DEFAULT 0,
    my_response   TEXT,
    mine          INTEGER NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX event_start_idx ON event(start);
  CREATE INDEX event_uid_idx ON event(account_id, uid);

  -- Which messages carried which version of a meeting.
  CREATE TABLE event_message (
    message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
    event_id   TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
    method     TEXT NOT NULL,
    sequence   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (message_id, event_id)
  );
  `,
  `
  -- "Remind me if nobody replies" on a message you sent. fired = the reminder has been shown.
  CREATE TABLE followup (
    message_id TEXT PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
    due        INTEGER NOT NULL,
    fired      INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX followup_due_idx ON followup(due);
  `,
  `
  -- Local labels. They hang on the Message-ID, so they survive a move to another folder.
  CREATE TABLE label (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE message_label (
    account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    rfc_id     TEXT NOT NULL,
    label_id   TEXT NOT NULL REFERENCES label(id) ON DELETE CASCADE,
    PRIMARY KEY (account_id, rfc_id, label_id)
  );
  CREATE INDEX message_label_label_idx ON message_label(label_id);
  `,
  `
  -- A follow-up chosen at send time, waiting for the sent copy to show up in the Sent folder.
  CREATE TABLE pending_followup (
    account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    rfc_id     TEXT NOT NULL,
    due        INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, rfc_id)
  );
  `,
  `
  CREATE TABLE saved_search (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    query      TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE rule (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    match      TEXT NOT NULL,
    actions    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `
]
