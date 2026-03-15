// ---------------------------------------------------------------------------
// Configuration — all values come from environment variables.
// ---------------------------------------------------------------------------

export interface Config {
  account: {
    email: string;
  };
  api: {
    host: string;
    port: number;
    token: string;
  };
  db: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  imap: {
    host: string;
    port: number;
    tls: boolean;
    user: string;
    pass: string;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  };
  /** How many messages to fetch per IMAP batch during backfill */
  backfillBatchSize: number;
  /** Max concurrent IMAP commands (rate limiting) */
  maxConcurrentImap: number;
  /** Directory to store attachment blobs */
  attachmentDir: string;
  /** How long (ms) to wait before reconnecting after IDLE drop */
  idleReconnectDelay: number;
}

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export function loadConfig(): Config {
  const dbPassword = required('DB_PASSWORD');
  const imapUser = required('IMAP_USER');
  const imapPass = required('IMAP_PASS');
  return {
    account: {
      email: optional('ACCOUNT_EMAIL', imapUser),
    },
    api: {
      host: optional('SYNC_ENGINE_API_HOST', '127.0.0.1'),
      port: parseInt(optional('SYNC_ENGINE_API_PORT', '4001'), 10),
      token: optional('SYNC_ENGINE_API_TOKEN', dbPassword),
    },
    db: {
      host: optional('DB_HOST', '127.0.0.1'),
      port: parseInt(optional('DB_PORT', '5432'), 10),
      database: optional('DB_NAME', 'mailsync'),
      user: optional('DB_USER', 'mailsync'),
      password: dbPassword,
    },
    imap: {
      host: optional('IMAP_HOST', '127.0.0.1'),
      port: parseInt(optional('IMAP_PORT', '993'), 10),
      tls: optional('IMAP_TLS', 'true') === 'true',
      user: imapUser,
      pass: imapPass,
    },
    smtp: {
      host: optional('SMTP_HOST', '127.0.0.1'),
      port: parseInt(optional('SMTP_PORT', '587'), 10),
      secure: optional('SMTP_SECURE', 'false') === 'true',
      user: optional('SMTP_USER', imapUser),
      pass: optional('SMTP_PASS', imapPass),
    },
    backfillBatchSize: parseInt(optional('BACKFILL_BATCH_SIZE', '100'), 10),
    maxConcurrentImap: parseInt(optional('MAX_CONCURRENT_IMAP', '5'), 10),
    attachmentDir: optional('ATTACHMENT_DIR', '/var/lib/mail-sync-engine/attachments'),
    idleReconnectDelay: parseInt(optional('IDLE_RECONNECT_DELAY', '1000'), 10),
  };
}
