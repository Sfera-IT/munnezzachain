-- Operators (rangers, office staff) and administrators. The public never has an account.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('operatore', 'admin')),
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE reports (
  id               TEXT PRIMARY KEY,
  client_report_id TEXT NOT NULL UNIQUE,
  received_at      TEXT NOT NULL,
  channel          TEXT NOT NULL CHECK (channel IN ('operatore', 'pubblico')),
  submitted_by     TEXT REFERENCES users (id),
  category         TEXT NOT NULL,
  description      TEXT NOT NULL,
  contact          TEXT,
  lat              REAL,
  lon              REAL,
  location_source  TEXT,
  warn_count       INTEGER NOT NULL DEFAULT 0,
  manifest_key     TEXT NOT NULL,
  manifest_sha256  TEXT NOT NULL,
  country          TEXT,
  user_agent       TEXT,
  -- Public reports wait in quarantine until an admin accepts them; operator reports are accepted on arrival.
  moderation       TEXT NOT NULL CHECK (moderation IN ('in_attesa', 'accettata', 'rifiutata')),
  moderated_at     TEXT,
  moderated_by     TEXT REFERENCES users (id),
  rejection_reason TEXT,
  status           TEXT NOT NULL DEFAULT 'nuova',
  status_note      TEXT,
  status_updated_at TEXT,
  status_updated_by TEXT REFERENCES users (id)
);
CREATE INDEX reports_received ON reports (received_at);
CREATE INDEX reports_status ON reports (status);
CREATE INDEX reports_moderation ON reports (moderation);

CREATE TABLE photos (
  report_id       TEXT NOT NULL REFERENCES reports (id),
  idx             INTEGER NOT NULL,
  sha256          TEXT NOT NULL,
  size            INTEGER NOT NULL,
  mime            TEXT NOT NULL,
  origin          TEXT NOT NULL,
  captured_at     TEXT NOT NULL,
  lat             REAL,
  lon             REAL,
  accuracy        REAL,
  location_source TEXT,
  exif_json       TEXT,
  flags_json      TEXT NOT NULL,
  original_key    TEXT NOT NULL,
  derived_key     TEXT,
  derived_sha256  TEXT,
  removed         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (report_id, idx)
);
CREATE INDEX photos_sha256 ON photos (sha256);
CREATE INDEX photos_derived_sha256 ON photos (derived_sha256);

-- Hash chain: every report is one link. seq is assigned optimistically; a concurrent writer that loses
-- the race hits the PRIMARY KEY and retries with the next number.
CREATE TABLE chain (
  seq             INTEGER PRIMARY KEY,
  report_id       TEXT NOT NULL UNIQUE REFERENCES reports (id),
  manifest_sha256 TEXT NOT NULL,
  prev_hash       TEXT NOT NULL,
  entry_hash      TEXT NOT NULL UNIQUE,
  received_at     TEXT NOT NULL,
  tsa_status      TEXT NOT NULL DEFAULT 'pending' CHECK (tsa_status IN ('pending', 'granted', 'error', 'disabled')),
  tsa_key         TEXT,
  tsa_gen_time    TEXT,
  tsa_error       TEXT,
  tsa_attempts    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX chain_tsa_pending ON chain (tsa_status);

CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL,
  user_id   TEXT REFERENCES users (id),
  action    TEXT NOT NULL,
  report_id TEXT,
  detail    TEXT
);
CREATE INDEX audit_report ON audit_log (report_id);

-- Evidence rows are append-only at the database level too, not just by convention in the Worker.
-- The one sanctioned exception: an admin rejecting a quarantined public report wipes its content,
-- while the chain link (hashes only) stays. Storage keys are pointers, not evidence, and may move.
CREATE TRIGGER chain_immutable BEFORE UPDATE OF seq, report_id, manifest_sha256, prev_hash, entry_hash, received_at ON chain
BEGIN SELECT RAISE(ABORT, 'la catena è in sola aggiunta'); END;
CREATE TRIGGER chain_no_delete BEFORE DELETE ON chain
BEGIN SELECT RAISE(ABORT, 'la catena è in sola aggiunta'); END;

CREATE TRIGGER photos_immutable
BEFORE UPDATE OF report_id, idx, sha256, size, mime, origin, captured_at, lat, lon, accuracy, location_source, exif_json, flags_json, derived_sha256, removed ON photos
WHEN NOT (OLD.removed = 0 AND NEW.removed = 1 AND (SELECT moderation FROM reports WHERE id = OLD.report_id) = 'in_attesa')
BEGIN SELECT RAISE(ABORT, 'le foto registrate non si modificano'); END;
CREATE TRIGGER photos_no_delete BEFORE DELETE ON photos
BEGIN SELECT RAISE(ABORT, 'le foto registrate non si cancellano'); END;

CREATE TRIGGER reports_evidence_immutable
BEFORE UPDATE OF id, client_report_id, received_at, channel, submitted_by, category, description, lat, lon, location_source, manifest_sha256, warn_count ON reports
WHEN NOT (OLD.moderation = 'in_attesa' AND NEW.moderation = 'rifiutata')
BEGIN SELECT RAISE(ABORT, 'i dati probatori della segnalazione non si modificano'); END;
CREATE TRIGGER reports_moderation_once BEFORE UPDATE OF moderation ON reports
WHEN OLD.moderation <> 'in_attesa' AND NEW.moderation <> OLD.moderation
BEGIN SELECT RAISE(ABORT, 'la decisione di moderazione non si cambia'); END;
CREATE TRIGGER reports_no_delete BEFORE DELETE ON reports
BEGIN SELECT RAISE(ABORT, 'le segnalazioni non si cancellano'); END;

CREATE TRIGGER audit_immutable BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'il registro accessi è in sola aggiunta'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'il registro accessi è in sola aggiunta'); END;
