// ---------------------------------------------------------------------------
// Mail Sync Engine — Entry Point
//
// Orchestrates:
//   1. Initial backfill (IMAP → Postgres)
//   2. IDLE listener for real-time updates
//   3. Periodic re-sync of stale folders
//
// Run as a standalone systemd service on NixOS.
// ---------------------------------------------------------------------------

import { ImapFlow } from 'imapflow';
import { loadConfig } from './config.js';
import { initDb, migrateDb, shutdownDb, query, queryOne } from './db.js';
import { log } from './logger.js';
import { runBackfill } from './backfill.js';
import { IdleListener } from './idle-listener.js';
import { startInternalApiServer, type InternalApiServer } from './internal-api.js';
import { RateLimitedQueue } from './queue.js';

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;
let idleListener: IdleListener | null = null;
let internalApiServer: InternalApiServer | null = null;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info(`Received ${signal}, shutting down gracefully…`);

  if (idleListener) {
    await idleListener.stop();
  }

  if (internalApiServer) {
    await internalApiServer.close().catch(() => undefined);
    internalApiServer = null;
  }

  await shutdownDb();

  log.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log.info('Mail Sync Engine starting…');

  // 1. Load configuration
  const config = loadConfig();

  // 2. Connect to PostgreSQL
  initDb(config);
  log.info('Connected to PostgreSQL', {
    host: config.db.host,
    database: config.db.database,
  });

  // 2b. Auto-migrate schema if needed
  await migrateDb();

  // 2c. Expose a localhost-only API for upstream write operations so the
  // webmail app no longer needs to connect to IMAP/SMTP directly.
  internalApiServer = startInternalApiServer(config);

  // 3. Ensure account exists in DB
  const accountId = await ensureAccount(config);
  log.info('Account ready', { accountId, email: config.account.email });

  // 4. Create rate-limited queue for IMAP operations
  const queue = new RateLimitedQueue(config.maxConcurrentImap);

  // 5. Run initial backfill
  log.info('Starting initial backfill…');
  const backfillClient = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.tls,
    auth: {
      user: config.imap.user,
      pass: config.imap.pass,
    },
    tls: { rejectUnauthorized: false },
    logger: false,
  });

  try {
    await backfillClient.connect();
    await runBackfill(backfillClient, accountId, config, queue);
  } catch (err) {
    log.error('Backfill failed', { error: String(err) });
    // Don't exit — still start IDLE listener for real-time updates
  } finally {
    try {
      await backfillClient.logout();
    } catch {
      // Ignore
    }
  }

  // 6. Start IDLE listener for real-time sync
  if (!shuttingDown) {
    idleListener = new IdleListener(config, accountId);
    await idleListener.start();
    log.info('Sync engine running — IDLE listener active');
  }

  // Keep process alive
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (shuttingDown) {
        clearInterval(check);
        resolve();
      }
    }, 1000);
  });
}

// ---------------------------------------------------------------------------
// Account bootstrap
// ---------------------------------------------------------------------------

async function ensureAccount(config: ReturnType<typeof loadConfig>): Promise<string> {
  // Try to find existing account
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM accounts WHERE email = $1`,
    [config.account.email],
  );

  if (existing) {
    await query(
      `UPDATE accounts
       SET display_name = $2,
           imap_host = $3,
           imap_port = $4,
           imap_tls = $5,
           smtp_host = $6,
           smtp_port = $7,
           username = $8,
           password = $9,
           updated_at = now()
       WHERE id = $1`,
      [
        existing.id,
        config.account.email.split('@')[0],
        config.imap.host,
        config.imap.port,
        config.imap.tls,
        config.smtp.host,
        config.smtp.port,
        config.imap.user,
        config.imap.pass,
      ],
    );
    return existing.id;
  }

  // Create new account
  const result = await queryOne<{ id: string }>(
    `INSERT INTO accounts (email, display_name, imap_host, imap_port, imap_tls, smtp_host, smtp_port, username, password)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      config.account.email,
      config.account.email.split('@')[0],
      config.imap.host,
      config.imap.port,
      config.imap.tls,
      config.smtp.host,
      config.smtp.port,
      config.imap.user,
      config.imap.pass, // In production, encrypt this or use a secret manager
    ],
  );

  if (!result) throw new Error('Failed to create account');

  log.info('Created new account', { id: result.id, email: config.account.email });
  return result.id;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  log.error('Fatal error', { error: String(err), stack: (err as Error).stack });
  process.exit(1);
});
