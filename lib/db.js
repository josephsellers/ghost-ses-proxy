var Database = require('better-sqlite3');

var db = new Database('/data/ses-proxy.db');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// --- message_map: batch metadata from send requests ---
db.exec(
  'CREATE TABLE IF NOT EXISTS message_map (' +
  '  batch_message_id TEXT PRIMARY KEY,' +
  '  ghost_email_id TEXT,' +
  '  tags TEXT,' +
  '  created_at TEXT DEFAULT (datetime(\'now\'))' +
  ')'
);

// --- recipient_emails: SES message ID -> batch mapping ---
db.exec(
  'CREATE TABLE IF NOT EXISTS recipient_emails (' +
  '  ses_message_id TEXT PRIMARY KEY,' +
  '  batch_message_id TEXT NOT NULL,' +
  '  recipient TEXT NOT NULL,' +
  '  ghost_email_id TEXT,' +
  '  tags TEXT,' +
  '  created_at TEXT DEFAULT (datetime(\'now\'))' +
  ')'
);

db.exec('CREATE INDEX IF NOT EXISTS idx_recipient_emails_batch ON recipient_emails (batch_message_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_recipient_emails_recipient ON recipient_emails (recipient)');
db.exec('CREATE INDEX IF NOT EXISTS idx_recipient_emails_ghost_email ON recipient_emails (ghost_email_id)');

// --- send_claims: idempotency for (ghost email, recipient) so Ghost retries
//     after a timeout cannot deliver a second SES message. ---
db.exec(
  'CREATE TABLE IF NOT EXISTS send_claims (' +
  '  ghost_email_id TEXT NOT NULL,' +
  '  recipient TEXT NOT NULL,' +
  '  batch_message_id TEXT NOT NULL,' +
  '  created_at TEXT DEFAULT (datetime(\'now\')),' +
  '  PRIMARY KEY (ghost_email_id, recipient)' +
  ')'
);

// --- events: for Phase C (event polling) ---
db.exec(
  'CREATE TABLE IF NOT EXISTS events (' +
  '  id TEXT PRIMARY KEY,' +
  '  event_type TEXT NOT NULL,' +
  '  severity TEXT,' +
  '  recipient TEXT NOT NULL,' +
  '  timestamp INTEGER NOT NULL,' +
  '  message_id TEXT,' +
  '  email_id TEXT,' +
  '  delivery_status_code INTEGER,' +
  '  delivery_status_message TEXT,' +
  '  delivery_status_enhanced TEXT,' +
  '  tags TEXT,' +
  '  created_at TEXT DEFAULT (datetime(\'now\'))' +
  ')'
);

db.exec('CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events (timestamp)');
db.exec('CREATE INDEX IF NOT EXISTS idx_events_type ON events (event_type)');
db.exec('CREATE INDEX IF NOT EXISTS idx_events_message ON events (message_id)');

// --- suppressions: for Phase C ---
db.exec(
  'CREATE TABLE IF NOT EXISTS suppressions (' +
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,' +
  '  email TEXT NOT NULL,' +
  '  type TEXT NOT NULL,' +
  '  reason TEXT,' +
  '  created_at TEXT DEFAULT (datetime(\'now\')),' +
  '  UNIQUE(email, type)' +
  ')'
);

// --- Prepared insert statements ---

var insertMessageMap = db.prepare(
  'INSERT OR IGNORE INTO message_map (batch_message_id, ghost_email_id, tags) VALUES (?, ?, ?)'
);

var insertRecipientEmail = db.prepare(
  'INSERT OR IGNORE INTO recipient_emails (ses_message_id, batch_message_id, recipient, ghost_email_id, tags) VALUES (?, ?, ?, ?, ?)'
);

// INSERT OR IGNORE — returns changes=0 when already claimed (prior send/retry)
var insertSendClaim = db.prepare(
  'INSERT OR IGNORE INTO send_claims (ghost_email_id, recipient, batch_message_id) VALUES (?, ?, ?)'
);

/**
 * Try to claim (ghost_email_id, recipient) for this batch.
 * Returns true if this call won the claim (should send), false if already claimed.
 * When ghost_email_id is empty, always claims (cannot dedupe without an email id).
 */
function tryClaimRecipient(ghostEmailId, recipient, batchMessageId) {
  if (!ghostEmailId) {
    return true;
  }
  var info = insertSendClaim.run(ghostEmailId, recipient, batchMessageId);
  return info.changes > 0;
}

// --- Phase C prepared statements ---

var insertEvent = db.prepare(
  'INSERT OR IGNORE INTO events (id, event_type, severity, recipient, timestamp,' +
  ' message_id, email_id, delivery_status_code, delivery_status_message,' +
  ' delivery_status_enhanced, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
);

var insertSuppression = db.prepare(
  'INSERT OR IGNORE INTO suppressions (email, type, reason) VALUES (?, ?, ?)'
);

var deleteSuppression = db.prepare(
  'DELETE FROM suppressions WHERE email = ? AND type = ?'
);

var lookupRecipientEmail = db.prepare(
  'SELECT * FROM recipient_emails WHERE ses_message_id = ?'
);

// --- 90-day cleanup (runs daily) ---
function cleanup() {
  var cutoff = "datetime('now', '-90 days')";
  db.exec("DELETE FROM message_map WHERE created_at < " + cutoff);
  db.exec("DELETE FROM recipient_emails WHERE created_at < " + cutoff);
  db.exec("DELETE FROM send_claims WHERE created_at < " + cutoff);
  db.exec("DELETE FROM events WHERE created_at < " + cutoff);
  db.exec("DELETE FROM suppressions WHERE created_at < " + cutoff);
  console.log('Completed 90-day database cleanup');
}

// Run cleanup daily (24 hours = 86400000ms)
setInterval(cleanup, 86400000);

module.exports = {
  db: db,
  insertMessageMap: insertMessageMap,
  insertRecipientEmail: insertRecipientEmail,
  tryClaimRecipient: tryClaimRecipient,
  insertEvent: insertEvent,
  insertSuppression: insertSuppression,
  deleteSuppression: deleteSuppression,
  lookupRecipientEmail: lookupRecipientEmail
};
