"use server";
import crypto from "node:crypto";
import { getPool } from './db';
import {
  upstreamAppendMessage,
  upstreamDeleteMessages,
  upstreamMoveMessages,
  upstreamSendMessage,
  upstreamSetFlags,
} from "./sync-engine-client";

export type MessageSyncStatus = "staged" | "imap_syncing" | "imap_synced" | "sync_error";

export interface EmailMessage {
  id: number;
  seq: number;
  subject: string;
  from: string;
  fromAddress?: string;
  to?: string[];
  cc?: string[];
  deliveredTo?: string[];
  date: string;
  flags: string[];
  snippet?: string;
  hasAttachments?: boolean;
  threadId?: string;
  messageCount?: number;
  unreadCount?: number;
  participants?: string[];
  isNew?: boolean;
  syncStatus?: MessageSyncStatus;
  folderPath?: string;
  snoozedUntil?: string;
  scheduledFor?: string;
  spamScore?: number;
}

interface CursorPayload {
  sortDate: string;
  uid: number;
}

interface VirtualLabelFilter {
  mode: "flag" | "primary";
  flag?: string;
  excludedFlags?: string[];
}

function encodeCursor(payload: CursorPayload): string {
  return `${payload.sortDate}::${payload.uid}`;
}

function decodeCursor(token?: string | null): CursorPayload | null {
  if (!token) return null;
  const sep = token.lastIndexOf("::");
  if (sep <= 0) return null;
  const sortDate = token.slice(0, sep);
  const uid = Number(token.slice(sep + 2));
  if (!sortDate || !Number.isFinite(uid)) return null;
  return { sortDate, uid };
}

function parseVirtualLabelFilter(folder: string): VirtualLabelFilter | null {
  const normalized = folder.trim();
  const lower = normalized.toLowerCase();
  if (lower === "inbox:primary") return { mode: "primary", excludedFlags: [] };
  if (lower.startsWith("inbox:primary:")) {
    const encoded = normalized.slice("inbox:primary:".length).trim();
    const excludedFlags = encoded
      .split("|")
      .map((value) => value.trim())
      .filter(Boolean);
    return { mode: "primary", excludedFlags };
  }
  if (lower === "starred") return { mode: "flag", flag: "\\Flagged" };
  if (lower === "important") return { mode: "flag", flag: "Important" };
  if (lower.startsWith("label:")) {
    const label = normalized.slice(6).trim();
    if (label) return { mode: "flag", flag: label };
  }
  return null;
}

function isScheduledFolderName(folder: string): boolean {
  const normalized = folder.trim().toLowerCase();
  return normalized === "scheduled" || normalized === "scheduled send" || normalized === "scheduled sends";
}

const SYNC_STATUS_SQL = `
  CASE
    WHEN m.uid < 0 AND '__sync_error' = ANY(m.flags) THEN 'sync_error'
    WHEN m.uid < 0 THEN 'staged'
    ELSE 'imap_synced'
  END AS sync_status
`;

export interface FullEmail extends EmailMessage {
  html?: string;
  text?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  fromAddress?: string;
  accountEmail?: string;
  folderPath?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: ReceivedEmailAttachment[];
}

export interface ReceivedEmailAttachment {
  id: string;
  filename: string;
  contentType?: string;
  sizeBytes?: number;
}

const CURRENT_USER = process.env.ADMIN_EMAIL || 'admin@local';
const DEFAULT_SENDER_NAME = "Me";

function sanitizeDisplayName(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\r\n]+/g, " ").trim();
  return normalized ? normalized : null;
}

function escapeDisplayNameForHeader(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildFromHeader(displayName: string, email: string): string {
  return `From: "${escapeDisplayNameForHeader(displayName)}" <${email}>`;
}

async function resolveCurrentUserDisplayName(preferredName?: string): Promise<string> {
  const preferred = sanitizeDisplayName(preferredName);
  if (preferred) return preferred;

  const pool = getPool();
  try {
    const authUserResult = await pool.query(
      `SELECT name
       FROM "user"
       WHERE lower(email) = lower($1)
       LIMIT 1`,
      [CURRENT_USER],
    );
    const authUserName = sanitizeDisplayName(authUserResult.rows[0]?.name);
    if (authUserName) return authUserName;
  } catch {
    // Better Auth table can be missing in some environments.
  }

  try {
    const accountResult = await pool.query(
      `SELECT display_name
       FROM accounts
       WHERE lower(email) = lower($1)
       LIMIT 1`,
      [CURRENT_USER],
    );
    const accountName = sanitizeDisplayName(accountResult.rows[0]?.display_name);
    if (accountName) return accountName;
  } catch (err) {
    console.error("[DB Error] resolveCurrentUserDisplayName (accounts):", err);
  }

  return DEFAULT_SENDER_NAME;
}

/** Normalize sidebar folder name to fallback IMAP path */
function folderPathLegacy(name: string): string {
  const upper = name.toUpperCase();
  if (upper === "INBOX") return "INBOX";
  if (upper === "SPAM") return "Junk";
  return name;
}

const FOLDER_ALIASES: Record<string, string[]> = {
  inbox: ["INBOX", "Inbox"],
  sent: ["Sent", "Sent Items", "Sent Mail", "Sent Messages", "[Gmail]/Sent Mail"],
  drafts: ["Drafts", "Draft", "[Gmail]/Drafts"],
  spam: ["Junk", "Spam", "[Gmail]/Spam"],
  trash: ["Trash", "Deleted Items", "Deleted Messages", "[Gmail]/Trash"],
  archive: ["Archive", "All Mail", "[Gmail]/All Mail"],
};

const FOLDER_SPECIAL_USE: Record<string, string> = {
  inbox: "\\Inbox",
  sent: "\\Sent",
  drafts: "\\Drafts",
  spam: "\\Junk",
  trash: "\\Trash",
  archive: "\\Archive",
};
const TRASH_RETENTION_DAYS = 30;
const TRASH_FROM_PREFIX = "__trash_from:";
const SNOOZE_SWEEP_MIN_GAP_MS = 15_000;
const SCHEDULED_SEND_SWEEP_MIN_GAP_MS = 15_000;
const BACKGROUND_SWEEP_INTERVAL_MS = 15_000;

let lastSnoozeSweepAt = 0;
let snoozeSweepInFlight: Promise<void> | null = null;
let lastScheduledSendSweepAt = 0;
let scheduledSendSweepInFlight: Promise<void> | null = null;
let backgroundSweepTickInFlight = false;
let spamScoreColumnEnsured = false;
let blockedSendersTableEnsured = false;
let autoReplyTablesEnsured = false;

type BackgroundSweepState = {
  timer: ReturnType<typeof setInterval> | null;
};

declare global {
  // eslint-disable-next-line no-var
  var __mailBackgroundSweepState: BackgroundSweepState | undefined;
}

function getBackgroundSweepState(): BackgroundSweepState {
  if (!globalThis.__mailBackgroundSweepState) {
    globalThis.__mailBackgroundSweepState = { timer: null };
  }
  return globalThis.__mailBackgroundSweepState;
}

async function runBackgroundSweepTick(): Promise<void> {
  if (backgroundSweepTickInFlight) return;
  backgroundSweepTickInFlight = true;
  try {
    await runSnoozeSweep();
  } catch (err) {
    console.error("[Sweep Error] background tick failed:", err);
  } finally {
    backgroundSweepTickInFlight = false;
  }
}

function ensureBackgroundSweepTimer(): void {
  const state = getBackgroundSweepState();
  if (state.timer) return;
  state.timer = setInterval(() => {
    void runBackgroundSweepTick();
  }, BACKGROUND_SWEEP_INTERVAL_MS);
  state.timer.unref?.();
  void runBackgroundSweepTick();
}

function folderLookupKey(name: string): string {
  return name.trim().toLowerCase();
}

async function resolveFolderPath(name: string): Promise<string> {
  const key = folderLookupKey(name);
  const aliases = Array.from(
    new Set(
      [name, folderPathLegacy(name), ...(FOLDER_ALIASES[key] || [])]
        .map((v) => v.trim())
        .filter(Boolean)
    )
  );
  const aliasesLower = aliases.map((v) => v.toLowerCase());
  const specialUse = FOLDER_SPECIAL_USE[key] || null;

  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT f.path
       FROM folders f
       JOIN accounts a ON f.account_id = a.id
       WHERE a.email = $1
         AND (
           ($2::varchar IS NOT NULL AND f.special_use = $2::varchar)
           OR lower(f.path) = ANY($3::text[])
         )
       ORDER BY
         CASE
           WHEN $4::text = 'inbox' AND upper(f.path) = 'INBOX' THEN 0
           WHEN lower(f.path) = lower($5::text) THEN 1
           WHEN ($2::varchar IS NOT NULL AND f.special_use = $2::varchar) THEN 2
           WHEN lower(f.path) = ANY($3::text[]) THEN 3
           ELSE 9
         END,
         char_length(f.path)
       LIMIT 1`,
      [CURRENT_USER, specialUse, aliasesLower, key, name]
    );

    if (result.rows.length > 0) {
      return result.rows[0].path;
    }
  } catch (err) {
    console.error(`[DB Error] resolveFolderPath ${name}:`, err);
  }

  return folderPathLegacy(name);
}

async function ensureFolderEntry(path: string, displayName: string, specialUse?: string): Promise<void> {
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO folders (account_id, path, name, special_use, sync_state)
       SELECT a.id, $2::varchar, $3::varchar, $4::varchar, 'stale'
       FROM accounts a
       WHERE a.email = $1
       ON CONFLICT (account_id, path) DO UPDATE
       SET sync_state = 'stale',
           updated_at = now(),
           name = EXCLUDED.name,
           special_use = COALESCE(folders.special_use, EXCLUDED.special_use)`,
      [CURRENT_USER, path, displayName, specialUse ?? null]
    );
  } catch (err) {
    console.error(`[DB Error] ensureFolderEntry ${path}:`, err);
  }
}

function samePath(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function trashOriginFlag(path: string): string {
  return `${TRASH_FROM_PREFIX}${path}`;
}

export function getTrashOriginFromFlags(flags: string[] | undefined): string | null {
  if (!flags || flags.length === 0) return null;
  for (let i = flags.length - 1; i >= 0; i -= 1) {
    const f = flags[i];
    if (typeof f === "string" && f.startsWith(TRASH_FROM_PREFIX)) {
      const path = f.slice(TRASH_FROM_PREFIX.length).trim();
      if (path) return path;
    }
  }
  return null;
}

function targetFolderLabel(path: string): string {
  const normalized = path.trim().toLowerCase();
  if (normalized === "inbox") return "Inbox";
  if (normalized === "drafts" || normalized === "draft") return "Drafts";
  if (normalized.startsWith("sent")) return "Sent";
  return path;
}

async function deleteMessagesFromDbByUids(folderPath: string, uids: number[]): Promise<void> {
  if (!uids.length) return;
  const pool = getPool();
  try {
    await pool.query(
      `DELETE FROM messages m
       USING folders f, accounts a
       WHERE m.folder_id = f.id
         AND f.account_id = a.id
         AND a.email = $1
         AND f.path = $2
         AND m.uid = ANY($3::bigint[])`,
      [CURRENT_USER, folderPath, uids]
    );
  } catch (err) {
    console.error("[DB Error] deleteMessagesFromDbByUids:", err);
  }
}

async function permanentlyDeleteUids(folderPath: string, uids: number[]): Promise<void> {
  if (!uids.length) return;
  try {
    await upstreamDeleteMessages(folderPath, uids);
  } catch (err) {
    console.error("[Sync Engine Error] permanentlyDeleteUids:", err);
  }
  await deleteMessagesFromDbByUids(folderPath, uids);
}

async function purgeExpiredTrashMessages(trashPath: string): Promise<void> {
  const pool = getPool();
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  try {
    const result = await pool.query(
      `SELECT m.uid::bigint AS uid
       FROM messages m
       JOIN folders f ON m.folder_id = f.id
       JOIN accounts a ON f.account_id = a.id
       WHERE a.email = $1
         AND f.path = $2
         AND m.date IS NOT NULL
         AND m.date < $3::timestamptz
       ORDER BY m.date ASC
       LIMIT 500`,
      [CURRENT_USER, trashPath, cutoff.toISOString()]
    );
    const uids = result.rows.map((r: any) => Number(r.uid)).filter((n: number) => Number.isFinite(n));
    if (uids.length === 0) return;
    await permanentlyDeleteUids(trashPath, uids);
  } catch (err) {
    console.error("[DB Error] purgeExpiredTrashMessages:", err);
  }
}

async function ensureSnoozesTable(): Promise<void> {
  const pool = getPool();
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS mail_snoozes (
         id BIGSERIAL PRIMARY KEY,
         account_email TEXT NOT NULL,
         message_id TEXT NULL,
         snoozed_uid BIGINT NOT NULL,
         return_path VARCHAR(255) NOT NULL,
         until_at TIMESTAMPTZ NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_mail_snoozes_due
       ON mail_snoozes (account_email, until_at)`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_mail_snoozes_message_id
       ON mail_snoozes (account_email, message_id)`
    );
  } catch (err) {
    console.error("[DB Error] ensureSnoozesTable:", err);
  }
}

async function ensureSpamScoreColumn(): Promise<void> {
  if (spamScoreColumnEnsured) return;
  const pool = getPool();
  try {
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS spam_score REAL`);
    spamScoreColumnEnsured = true;
  } catch (err) {
    const code = (err as any)?.code;
    if (code === "42501") {
      // Webmail DB user may not own tables in production; avoid noisy retries.
      spamScoreColumnEnsured = true;
    }
    console.error("[DB Error] ensureSpamScoreColumn:", err);
  }
}

async function ensureBlockedSendersTable(): Promise<void> {
  if (blockedSendersTableEnsured) return;
  const pool = getPool();
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS blocked_senders (
         id            BIGSERIAL    PRIMARY KEY,
         account_email TEXT         NOT NULL,
         sender_email  TEXT         NOT NULL,
         display_name  TEXT,
         blocked_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
         UNIQUE (account_email, sender_email)
       )`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_blocked_senders_account
       ON blocked_senders (account_email, lower(sender_email))`
    );
    blockedSendersTableEnsured = true;
  } catch (err) {
    console.error("[DB Error] ensureBlockedSendersTable:", err);
  }
}

async function persistDerivedSpamScoreIfMissing(folderPath: string, uid: number): Promise<void> {
  if (!Number.isFinite(uid) || uid <= 0) return;
  const pool = getPool();
  try {
    const rowResult = await pool.query(
      `SELECT m.id, m.spam_score, m.headers
       FROM messages m
       JOIN folders f ON m.folder_id = f.id
       JOIN accounts a ON f.account_id = a.id
       WHERE a.email = $1 AND f.path = $2 AND m.uid = $3
       LIMIT 1`,
      [CURRENT_USER, folderPath, uid]
    );
    const row = rowResult.rows[0];
    if (!row || row.spam_score != null) return;
    const derived = deriveSpamScoreFromHeaders(row.headers);
    if (derived == null) return;
    await pool.query(`UPDATE messages SET spam_score = $1 WHERE id = $2`, [derived, row.id]);
  } catch (err) {
    console.error("[DB Error] persistDerivedSpamScoreIfMissing:", err);
  }
}

async function emitFolderSyncedEvent(folderPath: string): Promise<void> {
  const normalized = folderPath?.trim();
  if (!normalized) return;
  const pool = getPool();
  try {
    await pool.query(
      `SELECT pg_notify('mail_events', $1)`,
      [JSON.stringify({ type: "folder_synced", folder: normalized })]
    );
  } catch (err) {
    console.error("[DB Error] emitFolderSyncedEvent:", err);
  }
}

async function releaseDueSnoozedEmails(): Promise<void> {
  await releaseDueScheduledSends();
  const now = Date.now();
  if (now - lastSnoozeSweepAt < SNOOZE_SWEEP_MIN_GAP_MS) return;
  if (snoozeSweepInFlight) {
    await snoozeSweepInFlight;
    return;
  }

  snoozeSweepInFlight = (async () => {
    lastSnoozeSweepAt = Date.now();
    await ensureSnoozesTable();
    const pool = getPool();
    const snoozedPath = await resolveFolderPath("Snoozed");

    try {
      const due = await pool.query(
        `SELECT id, message_id, snoozed_uid, return_path
         FROM mail_snoozes
         WHERE account_email = $1 AND until_at <= now()
         ORDER BY until_at ASC
         LIMIT 100`,
        [CURRENT_USER]
      );

      for (const row of due.rows) {
        let uid: number | null = null;
        let shouldDeleteSchedule = true;
        try {
          if (row.message_id) {
            const match = await pool.query(
              `SELECT m.uid::bigint AS uid
               FROM messages m
               JOIN folders f ON m.folder_id = f.id
               JOIN accounts a ON f.account_id = a.id
               WHERE a.email = $1 AND f.path = $2 AND m.message_id = $3
               ORDER BY m.date DESC NULLS LAST
               LIMIT 1`,
              [CURRENT_USER, snoozedPath, row.message_id]
            );
            if (!match.rows[0]) {
              uid = null;
            } else {
              uid = Number(match.rows[0].uid ?? NaN);
            }
          } else {
            uid = Number(row.snoozed_uid);
          }

          if (Number.isFinite(uid)) {
            // For staged rows (uid <= 0), moveToFolder performs DB-only move and skips IMAP.
            await moveToFolder(String(uid), snoozedPath, row.return_path || "INBOX");
          }
        } catch (err) {
          console.error("[Snooze Error] failed to release snoozed email:", err);
          shouldDeleteSchedule = false;
        } finally {
          if (shouldDeleteSchedule) {
            await pool.query(`DELETE FROM mail_snoozes WHERE id = $1`, [row.id]);
          }
        }
      }
    } catch (err) {
      console.error("[DB Error] releaseDueSnoozedEmails:", err);
    }
  })().finally(() => {
    snoozeSweepInFlight = null;
  });

  await snoozeSweepInFlight;
}

export async function runSnoozeSweep(): Promise<void> {
  await releaseDueSnoozedEmails();
}

ensureBackgroundSweepTimer();

function normalizeMessageId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith("<") && trimmed.endsWith(">")
    ? trimmed
    : `<${trimmed.replace(/^<|>$/g, "")}>`;
}

function makeOutgoingMessageId(fromEmail: string): string {
  const domain = fromEmail.split("@")[1] || "localhost";
  return `<${crypto.randomUUID()}@${domain}>`;
}

async function resolveThreadForOutgoingReply(
  inReplyTo?: string,
  references?: string[],
): Promise<string | null> {
  const pool = getPool();
  const candidates = new Set<string>();
  if (inReplyTo) candidates.add(inReplyTo);
  for (const ref of references || []) {
    if (ref) candidates.add(ref);
  }
  if (candidates.size === 0) return null;

  try {
    const ids = Array.from(candidates);
    const result = await pool.query(
      `SELECT m.thread_id::text AS thread_id
       FROM messages m
       JOIN accounts a ON a.id = m.account_id
       WHERE a.email = $1
         AND m.thread_id IS NOT NULL
         AND m.message_id = ANY($2::text[])
       ORDER BY m.date DESC NULLS LAST
       LIMIT 1`,
      [CURRENT_USER, ids],
    );
    return result.rows[0]?.thread_id || null;
  } catch (err) {
    console.error("[DB Error] resolveThreadForOutgoingReply:", err);
    return null;
  }
}

function buildRawHtmlMessage(
  to: string,
  subject: string,
  body: string,
  fromName: string,
  cc?: string,
  bcc?: string,
  options?: { messageId?: string; inReplyTo?: string; references?: string[]; date?: Date },
): string {
  const headers = [
    buildFromHeader(fromName, CURRENT_USER),
    `To: ${to || ""}`,
    `Subject: ${subject || "(No Subject)"}`,
    `Date: ${(options?.date ?? new Date()).toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=utf-8`,
  ];
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  if (options?.messageId) headers.push(`Message-ID: ${options.messageId}`);
  if (options?.inReplyTo) headers.push(`In-Reply-To: ${options.inReplyTo}`);
  if (options?.references?.length) headers.push(`References: ${options.references.join(" ")}`);
  return headers.join("\r\n") + "\r\n\r\n" + (body || "");
}

function htmlToPlainText(body: string): string {
  return body
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function extractInlineDataImageAttachments(html: string): { html: string; inlineAttachments: EmailAttachment[] } {
  const inlineAttachments: EmailAttachment[] = [];
  const knownDataUrlToCid = new Map<string, string>();
  const senderDomain = CURRENT_USER.split("@")[1] || "localhost";

  const rewrittenHtml = html.replace(
    /<img\b[^>]*\bsrc=(["'])(data:image\/[^"']+)\1[^>]*>/gi,
    (fullTag: string, quote: string, dataUrl: string) => {
      const parsed = parseInlineImageDataUrl(dataUrl);
      if (!parsed) return fullTag;

      const existingCid = knownDataUrlToCid.get(dataUrl);
      const cid = existingCid || `inline-${crypto.randomUUID()}@${senderDomain}`;
      if (!existingCid) {
        knownDataUrlToCid.set(dataUrl, cid);
        inlineAttachments.push({
          filename: `inline-image-${inlineAttachments.length + 1}.${extensionFromMime(parsed.contentType)}`,
          contentType: parsed.contentType,
          content: parsed.base64Content,
          cid,
          contentDisposition: "inline",
        });
      }

      return fullTag.replace(`src=${quote}${dataUrl}${quote}`, `src=${quote}cid:${cid}${quote}`);
    },
  );

  return { html: rewrittenHtml, inlineAttachments };
}

function parseInlineImageDataUrl(dataUrl: string): { contentType: string; base64Content: string } | null {
  const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;
  const contentType = match[1].toLowerCase();
  const base64Content = match[2].replace(/\s+/g, "");
  if (!base64Content) return null;
  return { contentType, base64Content };
}

function extensionFromMime(contentType: string): string {
  const subtype = (contentType.split("/")[1] || "png").split("+")[0].toLowerCase();
  if (subtype === "jpeg") return "jpg";
  return subtype || "png";
}

function addressListJson(input?: string): string {
  const items = (input || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((address) => ({ address }));
  return JSON.stringify(items);
}

async function upsertLocalMessageCopy(params: {
  folderPath: string;
  folderName: string;
  specialUse?: string;
  threadId?: string;
  uid: number;
  subject: string;
  html: string;
  text: string;
  to?: string;
  cc?: string;
  bcc?: string;
  flags: string[];
  hasAttachments: boolean;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  fromName: string;
}): Promise<void> {
  const pool = getPool();
  const fromJson = JSON.stringify({ name: params.fromName, address: CURRENT_USER });
  const toJson = addressListJson(params.to);
  const ccJson = addressListJson(params.cc);
  const bccJson = addressListJson(params.bcc);
  const snippet = (params.text || "").slice(0, 200);

  try {
    await pool.query(
      `WITH a AS (
         SELECT id FROM accounts WHERE email = $1 LIMIT 1
       ),
       f AS (
         INSERT INTO folders (account_id, path, name, special_use, sync_state)
         SELECT a.id, $2::varchar, $3::varchar, $4::varchar, 'stale' FROM a
         ON CONFLICT (account_id, path) DO UPDATE
         SET name = EXCLUDED.name,
             special_use = COALESCE(folders.special_use, EXCLUDED.special_use),
             sync_state = 'stale',
             updated_at = now()
         RETURNING id, account_id
       ),
       rf AS (
         SELECT id, account_id FROM f
         UNION ALL
         SELECT f2.id, f2.account_id
         FROM folders f2
         JOIN a ON f2.account_id = a.id
         WHERE f2.path = $2
         LIMIT 1
       )
       INSERT INTO messages (
         account_id, folder_id, thread_id, uid, message_id, in_reply_to, "references", subject, from_address,
         to_addresses, cc_addresses, bcc_addresses, date, flags, text_body, html_body, snippet, has_attachments, updated_at
       )
       SELECT
         rf.account_id, rf.id, $5::uuid, $6, $7, $8, $9::text[], $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb,
         now(), $15::text[], $16, $17, $18, $19, now()
       FROM rf
       ON CONFLICT (folder_id, uid) DO UPDATE SET
         thread_id = COALESCE(messages.thread_id, EXCLUDED.thread_id),
         message_id = COALESCE(messages.message_id, EXCLUDED.message_id),
         in_reply_to = COALESCE(messages.in_reply_to, EXCLUDED.in_reply_to),
         "references" = CASE
           WHEN COALESCE(array_length(messages."references", 1), 0) = 0
             THEN EXCLUDED."references"
           ELSE messages."references"
         END,
         subject = EXCLUDED.subject,
         from_address = EXCLUDED.from_address,
         to_addresses = EXCLUDED.to_addresses,
         cc_addresses = EXCLUDED.cc_addresses,
         bcc_addresses = EXCLUDED.bcc_addresses,
         date = EXCLUDED.date,
         flags = EXCLUDED.flags,
         text_body = EXCLUDED.text_body,
         html_body = EXCLUDED.html_body,
         snippet = EXCLUDED.snippet,
         has_attachments = EXCLUDED.has_attachments,
         updated_at = now()`,
      [
        CURRENT_USER,
        params.folderPath,
        params.folderName,
        params.specialUse ?? null,
        params.threadId ?? null,
        params.uid,
        params.messageId ?? null,
        params.inReplyTo ?? null,
        params.references ?? [],
        params.subject || "(No Subject)",
        fromJson,
        toJson,
        ccJson,
        bccJson,
        params.flags,
        params.text,
        params.html,
        snippet,
        params.hasAttachments,
      ]
    );
  } catch (err) {
    console.error("[DB Error] upsertLocalMessageCopy:", err);
  }
}

/** Extract email addresses from a JSONB address array ([{"name":"…","address":"…"}]) */
function extractAddresses(jsonb: unknown): string[] {
  if (!Array.isArray(jsonb)) return [];
  return jsonb.map((a: any) => a.address).filter(Boolean);
}

async function listMessageAttachmentsByIds(messageIds: string[]): Promise<Map<string, ReceivedEmailAttachment[]>> {
  const uniqueIds = Array.from(new Set(messageIds.filter(Boolean)));
  if (!uniqueIds.length) return new Map();

  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT id, message_id, filename, content_type, size_bytes, content_disposition
       FROM attachments
       WHERE message_id = ANY($1::uuid[])
         AND COALESCE(content_disposition, 'attachment') <> 'inline'
       ORDER BY created_at ASC`,
      [uniqueIds],
    );

    const byMessage = new Map<string, ReceivedEmailAttachment[]>();
    for (const row of result.rows) {
      if (!row?.message_id || !row?.id) continue;
      const filename = typeof row.filename === "string" && row.filename.trim() ? row.filename : "attachment";
      const current = byMessage.get(row.message_id) || [];
      current.push({
        id: row.id,
        filename,
        contentType: row.content_type || undefined,
        sizeBytes: row.size_bytes == null ? undefined : Number(row.size_bytes),
      });
      byMessage.set(row.message_id, current);
    }
    return byMessage;
  } catch (err) {
    console.error("[DB Error] listMessageAttachmentsByIds:", err);
    return new Map();
  }
}

function extractEmailsFromHeaderValue(input: string | undefined): string[] {
  if (!input) return [];
  const matches = input.match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi) || [];
  return matches.map((v) => v.trim());
}

function extractDeliveredToFromHeaders(headers: unknown): string[] {
  if (!headers || typeof headers !== "object") return [];
  const map = headers as Record<string, unknown>;
  const values: string[] = [];
  for (const key of ["delivered-to", "x-original-to"]) {
    const value = map[key];
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") values.push(item);
      }
    }
  }

  const emails = values.flatMap((value) => extractEmailsFromHeaderValue(value));
  return Array.from(new Set(emails.map((v) => v.toLowerCase())));
}

function parseSpamScoreFromHeaderValue(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const rspamdMatch = trimmed.match(/\[\s*(-?[\d.]+)\s*\//);
  if (rspamdMatch) {
    const score = Number.parseFloat(rspamdMatch[1]);
    if (Number.isFinite(score)) return score;
  }

  const genericScore = Number.parseFloat(trimmed);
  if (Number.isFinite(genericScore)) return genericScore;
  return undefined;
}

function deriveSpamScoreFromHeaders(headers: unknown): number | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const map = headers as Record<string, unknown>;
  return (
    parseSpamScoreFromHeaderValue(map["x-spamd-result"]) ??
    parseSpamScoreFromHeaderValue(map["X-Spamd-Result"]) ??
    parseSpamScoreFromHeaderValue(map["x-spam-score"]) ??
    parseSpamScoreFromHeaderValue(map["X-Spam-Score"])
  );
}

function normalizeConversationSubject(subject: string | undefined): string {
  if (!subject) return "";
  return subject
    .replace(/^(\s*(re|fwd?|aw|wg)\s*(\[\d+\])?\s*:\s*)+/i, "")
    .trim()
    .toLowerCase();
}

function parseIsoDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pickCounterpartyAddress(email: FullEmail): string | null {
  const me = CURRENT_USER.toLowerCase();
  const from = (email.fromAddress || "").toLowerCase();
  if (from && from !== me) return from;

  const pools = [email.to || [], email.cc || [], email.replyTo || []];
  for (const arr of pools) {
    for (const addr of arr) {
      const normalized = (addr || "").toLowerCase();
      if (normalized && normalized !== me) return normalized;
    }
  }
  return null;
}

function emailDedupKey(email: FullEmail): string {
  return `${(email.folderPath || "").toLowerCase()}#${email.seq}`;
}

// =============================================================================
// READ OPERATIONS — all queries go to PostgreSQL (populated by the Sync Engine)
// =============================================================================

export async function getFolderCounts(
  folders: string[]
): Promise<Record<string, { unread: number; total: number }>> {
  const pool = getPool();
  const counts: Record<string, { unread: number; total: number }> = {};

  try {
    await releaseDueSnoozedEmails();
    if (folders.some((f) => folderLookupKey(f) === "trash")) {
      const trashPath = await resolveFolderPath("Trash");
      await purgeExpiredTrashMessages(trashPath);
    }

    // --- regular folders ---
    const regularFolders = folders.filter((f) => f !== "Starred" && f !== "Important" && !isScheduledFolderName(f));
    const pathEntries = await Promise.all(
      regularFolders.map(async (folder) => [folder, await resolveFolderPath(folder)] as const)
    );
    const paths = Array.from(new Set(pathEntries.map(([, path]) => path)));

    const result = await pool.query(
      `WITH requested(path) AS (
         SELECT unnest($2::text[])::varchar
       )
       SELECT
         r.path,
         COALESCE(f.total_messages, 0)::int AS total_messages,
         COALESCE(f.unread_count, 0)::int AS unread_count
       FROM requested r
       JOIN accounts a ON a.email = $1
       LEFT JOIN folders f ON f.account_id = a.id AND f.path = r.path`,
      [CURRENT_USER, paths]
    );

    for (const folder of regularFolders) {
      const path = pathEntries.find(([name]) => name === folder)?.[1] || folderPathLegacy(folder);
      const row = result.rows.find((r: any) => r.path === path);
      counts[folder] = {
        total: row?.total_messages ?? 0,
        unread: row?.unread_count ?? 0,
      };
    }

    // --- starred (virtual folder: count flagged messages across all folders) ---
    if (folders.includes("Starred")) {
      const starredResult = await pool.query(
        `SELECT
           COUNT(*)::int AS total_count,
           COUNT(*) FILTER (WHERE NOT ('\\Seen' = ANY(m.flags)))::int AS unread_count
         FROM messages m
         JOIN accounts a ON m.account_id = a.id
         WHERE a.email = $1 AND '\\Flagged' = ANY(m.flags)`,
        [CURRENT_USER]
      );
      counts["Starred"] = {
        total: starredResult.rows[0]?.total_count ?? 0,
        unread: starredResult.rows[0]?.unread_count ?? 0,
      };
    }

    // --- important (virtual label: count messages with "Important" keyword across all folders) ---
    if (folders.includes("Important")) {
      const importantResult = await pool.query(
        `SELECT
           COUNT(*)::int AS total_count,
           COUNT(*) FILTER (WHERE NOT ('\\Seen' = ANY(m.flags)))::int AS unread_count
         FROM messages m
         JOIN accounts a ON m.account_id = a.id
         WHERE a.email = $1 AND 'Important' = ANY(m.flags)`,
        [CURRENT_USER]
      );
      counts["Important"] = {
        total: importantResult.rows[0]?.total_count ?? 0,
        unread: importantResult.rows[0]?.unread_count ?? 0,
      };
    }

    if (folders.some((f) => isScheduledFolderName(f))) {
      await ensureScheduledSendsTable();
      const scheduledResult = await pool.query(
        `SELECT COUNT(*)::int AS total_count
         FROM mail_scheduled_sends
         WHERE account_email = $1`,
        [CURRENT_USER],
      );
      counts["Scheduled"] = {
        total: Number(scheduledResult.rows[0]?.total_count ?? 0),
        unread: 0,
      };
    }
  } catch (err) {
    console.error("[DB Error] getFolderCounts:", err);
    for (const folder of folders) {
      counts[folder] = { total: 0, unread: 0 };
    }
  }

  return counts;
}

export async function getUnreadCountForSection(section: string): Promise<number> {
  const pool = getPool();
  try {
    await releaseDueSnoozedEmails();
    const virtualFilter = parseVirtualLabelFilter(section);
    if (virtualFilter) {
      if (virtualFilter.mode === "primary") {
        const inboxPath = await resolveFolderPath("INBOX");
        const excludedCategories = Array.from(
          new Set(
            (virtualFilter.excludedFlags || [])
              .map((label) => label.trim())
              .filter(Boolean)
              .map((label) => label.toLowerCase())
          )
        );
        const useExclusions = excludedCategories.length > 0;
        const unreadResult = await pool.query(
          `SELECT COUNT(*)::int AS unread_count
           FROM messages m
           JOIN accounts a ON m.account_id = a.id
           JOIN folders f ON m.folder_id = f.id
           WHERE a.email = $1
             AND f.path = $2
             AND NOT ('\\Seen' = ANY(m.flags))
             AND (
               $3::boolean = false
               OR m.uid < 0
               OR NOT EXISTS (
                 SELECT 1 FROM unnest(m.flags) flag
                 WHERE lower(flag) = ANY($4::text[])
               )
             )`,
          [CURRENT_USER, inboxPath, useExclusions, excludedCategories]
        );
        return Number(unreadResult.rows[0]?.unread_count ?? 0);
      }

      const unreadResult = await pool.query(
        `SELECT COUNT(*)::int AS unread_count
         FROM messages m
         JOIN accounts a ON m.account_id = a.id
         WHERE a.email = $1
           AND NOT ('\\Seen' = ANY(m.flags))
           AND EXISTS (
             SELECT 1 FROM unnest(m.flags) flag
             WHERE lower(flag) = lower($2)
           )`,
        [CURRENT_USER, virtualFilter.flag]
      );
      return Number(unreadResult.rows[0]?.unread_count ?? 0);
    }

    const folderPath = await resolveFolderPath(section);
    const unreadResult = await pool.query(
      `SELECT COALESCE(f.unread_count, 0)::int AS unread_count
       FROM accounts a
       LEFT JOIN folders f ON f.account_id = a.id AND f.path = $2
       WHERE a.email = $1
       LIMIT 1`,
      [CURRENT_USER, folderPath]
    );
    return Number(unreadResult.rows[0]?.unread_count ?? 0);
  } catch (err) {
    console.error(`[DB Error] getUnreadCountForSection ${section}:`, err);
    return 0;
  }
}

export async function fetchEmails(folder = "INBOX"): Promise<EmailMessage[]> {
  const pool = getPool();
  try {
    await releaseDueSnoozedEmails();
    const path = await resolveFolderPath(folder);
    const trashPath = await resolveFolderPath("Trash");
    if (samePath(path, trashPath)) {
      await purgeExpiredTrashMessages(trashPath);
    }
    const folderResult = await pool.query(
      `SELECT f.id
       FROM folders f
       JOIN accounts a ON f.account_id = a.id
       WHERE a.email = $1 AND f.path = $2
       LIMIT 1`,
      [CURRENT_USER, path]
    );
    if (folderResult.rows.length === 0) return [];

    const folderId = folderResult.rows[0].id;
    const result = await pool.query(
      `SELECT m.uid, m.subject,
              COALESCE(m.from_address->>'name', m.from_address->>'address', 'Unknown') AS from_display,
              m.from_address->>'address' AS from_email,
              m.to_addresses, m.cc_addresses, m.headers,
              m.date, m.flags, m.snippet, m.has_attachments,
              (
                SELECT ms.until_at
                FROM mail_snoozes ms
                WHERE ms.account_email = $2
                  AND (
                    (ms.message_id IS NOT NULL AND ms.message_id = m.message_id)
                    OR (ms.message_id IS NULL AND ms.snoozed_uid = m.uid)
                  )
                ORDER BY ms.until_at DESC
                LIMIT 1
              ) AS snoozed_until,
              ${SYNC_STATUS_SQL}
       FROM messages m
       WHERE m.folder_id = $1
       ORDER BY m.date DESC, m.uid DESC`,
      [folderId, CURRENT_USER]
    );

    return result.rows.map((row: any) => ({
      id: Number(row.uid),
      seq: Number(row.uid),
      subject: row.subject || '(No Subject)',
      from: row.from_display || 'Unknown',
      fromAddress: row.from_email || undefined,
      to: extractAddresses(row.to_addresses),
      cc: extractAddresses(row.cc_addresses),
      deliveredTo: extractDeliveredToFromHeaders(row.headers),
      date: row.date ? new Date(row.date).toISOString() : new Date().toISOString(),
      flags: row.flags || [],
      snippet: row.snippet || undefined,
      hasAttachments: row.has_attachments || false,
      syncStatus: row.sync_status || "imap_synced",
      snoozedUntil: row.snoozed_until ? new Date(row.snoozed_until).toISOString() : undefined,
    }));
  } catch (err) {
    console.error(`[DB Error] fetchEmails ${folder}:`, err);
  return [];
}

function parseSpamScoreFromHeaderValue(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const rspamdMatch = trimmed.match(/\[\s*(-?[\d.]+)\s*\//);
  if (rspamdMatch) {
    const score = Number.parseFloat(rspamdMatch[1]);
    if (Number.isFinite(score)) return score;
  }

  const genericScore = Number.parseFloat(trimmed);
  if (Number.isFinite(genericScore)) return genericScore;
  return undefined;
}

function deriveSpamScoreFromHeaders(headers: unknown): number | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const map = headers as Record<string, unknown>;
  return (
    parseSpamScoreFromHeaderValue(map["x-spamd-result"]) ??
    parseSpamScoreFromHeaderValue(map["X-Spamd-Result"]) ??
    parseSpamScoreFromHeaderValue(map["x-spam-score"]) ??
    parseSpamScoreFromHeaderValue(map["X-Spam-Score"])
  );
}
}

export async function fetchEmailsPaginated(
  folder = "INBOX",
  page = 1,
  perPage = 50,
  cursor?: string | null
): Promise<{ emails: EmailMessage[]; total: number; nextCursor: string | null; hasMore: boolean }> {
  const pool = getPool();
  try {
    await ensureSpamScoreColumn();
    await releaseDueSnoozedEmails();
    if (isScheduledFolderName(folder)) {
      await ensureScheduledSendsTable();
      const pageSize = Math.max(1, perPage);
      const pageNumber = Math.max(1, page);
      const offset = (pageNumber - 1) * pageSize;

      const totalResult = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM mail_scheduled_sends
         WHERE account_email = $1`,
        [CURRENT_USER],
      );
      const total = Number(totalResult.rows[0]?.total ?? 0);

      const rowsResult = await pool.query(
        `SELECT id, to_recipients, subject, body_html, send_at, created_at, attachments
         FROM mail_scheduled_sends
         WHERE account_email = $1
         ORDER BY send_at ASC, id ASC
         LIMIT $2 OFFSET $3`,
        [CURRENT_USER, pageSize, offset],
      );

      const emails: EmailMessage[] = rowsResult.rows.map((row: any) => {
        const body = typeof row.body_html === "string" ? row.body_html : "";
        const plain = body
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const scheduledOn = row.created_at ? new Date(row.created_at) : null;
        const sendAt = row.send_at ? new Date(row.send_at) : null;
        const scheduledOnLabel = scheduledOn && Number.isFinite(scheduledOn.getTime())
          ? scheduledOn.toLocaleString()
          : "Unknown";
        const sendAtLabel = sendAt && Number.isFinite(sendAt.getTime())
          ? sendAt.toLocaleString()
          : "Unknown";
        const attachmentCount = Array.isArray(row.attachments) ? row.attachments.length : 0;
        return {
          id: -Number(row.id),
          seq: -Number(row.id),
          subject: row.subject || "(No Subject)",
          from: `To: ${row.to_recipients || "(No recipients)"}`,
          date: row.send_at ? new Date(row.send_at).toISOString() : new Date().toISOString(),
          flags: ["\\Seen", "__scheduled"],
          snippet: `Scheduled on ${scheduledOnLabel}${plain ? ` • ${plain}` : ""}`.slice(0, 200),
          hasAttachments: attachmentCount > 0,
          syncStatus: "imap_synced",
          folderPath: "Scheduled",
          scheduledFor: sendAt && Number.isFinite(sendAt.getTime()) ? sendAt.toISOString() : undefined,
        };
      });

      return {
        emails,
        total,
        nextCursor: null,
        hasMore: offset + emails.length < total,
      };
    }
    const virtualFilter = parseVirtualLabelFilter(folder);
    if (virtualFilter) {
      const pageSize = Math.max(1, perPage);
      const parsedCursor = decodeCursor(cursor);
      let total = 0;
      let emailsResult;

      if (virtualFilter.mode === "primary") {
        const inboxPath = await resolveFolderPath("INBOX");
        const excludedCategories = Array.from(
          new Set(
            (virtualFilter.excludedFlags || [])
              .map((label) => label.trim())
              .filter(Boolean)
              .map((label) => label.toLowerCase())
          )
        );
        const useExclusions = excludedCategories.length > 0;
        const totalResult = await pool.query(
          `SELECT COUNT(*)::int AS total
           FROM messages m
           JOIN accounts a ON m.account_id = a.id
           JOIN folders f ON m.folder_id = f.id
           WHERE a.email = $1
             AND f.path = $2
             AND (
               $3::boolean = false
               OR m.uid < 0
               OR NOT EXISTS (
                 SELECT 1 FROM unnest(m.flags) flag
                 WHERE lower(flag) = ANY($4::text[])
               )
             )`,
          [CURRENT_USER, inboxPath, useExclusions, excludedCategories]
        );
        total = Number(totalResult.rows[0]?.total ?? 0);

        emailsResult = await pool.query(
          `SELECT m.uid, m.subject,
                  COALESCE(m.from_address->>'name', m.from_address->>'address', 'Unknown') AS from_display,
                  m.from_address->>'address' AS from_email,
                  m.to_addresses, m.cc_addresses, m.headers,
                  m.date, m.flags, m.snippet, m.has_attachments, m.spam_score,
                  f.path AS folder_path,
                  (
                    SELECT ms.until_at
                    FROM mail_snoozes ms
                    WHERE ms.account_email = $1
                      AND (
                        (ms.message_id IS NOT NULL AND ms.message_id = m.message_id)
                        OR (ms.message_id IS NULL AND ms.snoozed_uid = m.uid)
                      )
                    ORDER BY ms.until_at DESC
                    LIMIT 1
                  ) AS snoozed_until,
                  ${SYNC_STATUS_SQL}
           FROM messages m
           JOIN accounts a ON m.account_id = a.id
           JOIN folders f ON m.folder_id = f.id
           WHERE a.email = $1
             AND f.path = $2
             AND (
               $3::boolean = false
               OR m.uid < 0
               OR NOT EXISTS (
                 SELECT 1 FROM unnest(m.flags) flag
                 WHERE lower(flag) = ANY($4::text[])
               )
             )
             AND (
               $5::timestamptz IS NULL
               OR COALESCE(m.date, to_timestamp(0)) < $5::timestamptz
               OR (
                 COALESCE(m.date, to_timestamp(0)) = $5::timestamptz
                 AND m.uid < $6::bigint
               )
             )
           ORDER BY COALESCE(m.date, to_timestamp(0)) DESC, m.uid DESC
           LIMIT $7`,
          [CURRENT_USER, inboxPath, useExclusions, excludedCategories, parsedCursor?.sortDate ?? null, parsedCursor?.uid ?? null, pageSize + 1]
        );
      } else {
        const totalResult = await pool.query(
          `SELECT COUNT(*)::int AS total
           FROM messages m
           JOIN accounts a ON m.account_id = a.id
           WHERE a.email = $1
             AND EXISTS (
               SELECT 1 FROM unnest(m.flags) flag
               WHERE lower(flag) = lower($2)
             )`,
          [CURRENT_USER, virtualFilter.flag]
        );
        total = Number(totalResult.rows[0]?.total ?? 0);

        emailsResult = await pool.query(
          `SELECT m.uid, m.subject,
                  COALESCE(m.from_address->>'name', m.from_address->>'address', 'Unknown') AS from_display,
                  m.from_address->>'address' AS from_email,
                  m.to_addresses, m.cc_addresses, m.headers,
                  m.date, m.flags, m.snippet, m.has_attachments, m.spam_score,
                  f.path AS folder_path,
                  (
                    SELECT ms.until_at
                    FROM mail_snoozes ms
                    WHERE ms.account_email = $1
                      AND (
                        (ms.message_id IS NOT NULL AND ms.message_id = m.message_id)
                        OR (ms.message_id IS NULL AND ms.snoozed_uid = m.uid)
                      )
                    ORDER BY ms.until_at DESC
                    LIMIT 1
                  ) AS snoozed_until,
                  ${SYNC_STATUS_SQL}
           FROM messages m
           JOIN accounts a ON m.account_id = a.id
           JOIN folders f ON m.folder_id = f.id
           WHERE a.email = $1
             AND EXISTS (
               SELECT 1 FROM unnest(m.flags) flag
               WHERE lower(flag) = lower($2)
             )
             AND (
               $3::timestamptz IS NULL
               OR COALESCE(m.date, to_timestamp(0)) < $3::timestamptz
               OR (
                 COALESCE(m.date, to_timestamp(0)) = $3::timestamptz
                 AND m.uid < $4::bigint
               )
             )
           ORDER BY COALESCE(m.date, to_timestamp(0)) DESC, m.uid DESC
           LIMIT $5`,
          [CURRENT_USER, virtualFilter.flag, parsedCursor?.sortDate ?? null, parsedCursor?.uid ?? null, pageSize + 1]
        );
      }

      const hasMore = emailsResult.rows.length > pageSize;
      const visibleRows = hasMore ? emailsResult.rows.slice(0, pageSize) : emailsResult.rows;
      const emails: EmailMessage[] = visibleRows.map((row: any) => ({
        // Fall back to header-derived score for older rows not yet backfilled.
        id: Number(row.uid),
        seq: Number(row.uid),
        subject: row.subject || '(No Subject)',
        from: row.from_display || 'Unknown',
        fromAddress: row.from_email || undefined,
        to: extractAddresses(row.to_addresses),
        cc: extractAddresses(row.cc_addresses),
        deliveredTo: extractDeliveredToFromHeaders(row.headers),
        date: row.date ? new Date(row.date).toISOString() : new Date().toISOString(),
        flags: row.flags || [],
        snippet: row.snippet || undefined,
        hasAttachments: row.has_attachments || false,
        syncStatus: row.sync_status || "imap_synced",
        folderPath: row.folder_path || undefined,
        snoozedUntil: row.snoozed_until ? new Date(row.snoozed_until).toISOString() : undefined,
        spamScore: row.spam_score != null ? Number(row.spam_score) : deriveSpamScoreFromHeaders(row.headers),
      }));
      const last = visibleRows[visibleRows.length - 1];
      const nextCursor = hasMore && last
        ? encodeCursor({
            sortDate: last.date ? new Date(last.date).toISOString() : new Date(0).toISOString(),
            uid: Number(last.uid),
          })
        : null;

      return { emails, total, nextCursor, hasMore };
    }

    const path = await resolveFolderPath(folder);
    const trashPath = await resolveFolderPath("Trash");
    if (samePath(path, trashPath)) {
      await purgeExpiredTrashMessages(trashPath);
    }
    const pageSize = Math.max(1, perPage);
    const folderResult = await pool.query(
      `SELECT f.id, f.total_messages
       FROM folders f
       JOIN accounts a ON f.account_id = a.id
       WHERE a.email = $1 AND f.path = $2
       LIMIT 1`,
      [CURRENT_USER, path]
    );
    if (folderResult.rows.length === 0) return { emails: [], total: 0, nextCursor: null, hasMore: false };

    const folderId = folderResult.rows[0].id;
    const total = Number(folderResult.rows[0].total_messages ?? 0);
    const parsedCursor = decodeCursor(cursor);

    const emailsResult = await pool.query(
      `SELECT m.uid, m.subject,
              COALESCE(m.from_address->>'name', m.from_address->>'address', 'Unknown') AS from_display,
              m.from_address->>'address' AS from_email,
              m.to_addresses, m.cc_addresses, m.headers,
              m.date, m.flags, m.snippet, m.has_attachments, m.spam_score,
              f.path AS folder_path,
              (
                SELECT ms.until_at
                FROM mail_snoozes ms
                WHERE ms.account_email = $5
                  AND (
                    (ms.message_id IS NOT NULL AND ms.message_id = m.message_id)
                    OR (ms.message_id IS NULL AND ms.snoozed_uid = m.uid)
                  )
                ORDER BY ms.until_at DESC
                LIMIT 1
              ) AS snoozed_until,
              ${SYNC_STATUS_SQL}
       FROM messages m
       JOIN folders f ON m.folder_id = f.id
       WHERE m.folder_id = $1
         AND (
           $2::timestamptz IS NULL
           OR COALESCE(m.date, to_timestamp(0)) < $2::timestamptz
           OR (
             COALESCE(m.date, to_timestamp(0)) = $2::timestamptz
             AND m.uid < $3::bigint
           )
         )
       ORDER BY COALESCE(m.date, to_timestamp(0)) DESC, m.uid DESC
       LIMIT $4`,
      [folderId, parsedCursor?.sortDate ?? null, parsedCursor?.uid ?? null, pageSize + 1, CURRENT_USER]
    );

    const hasMore = emailsResult.rows.length > pageSize;
    const visibleRows = hasMore ? emailsResult.rows.slice(0, pageSize) : emailsResult.rows;
    const emails: EmailMessage[] = visibleRows.map((row: any) => ({
      // Fall back to header-derived score for older rows not yet backfilled.
      id: Number(row.uid),
      seq: Number(row.uid),
      subject: row.subject || '(No Subject)',
      from: row.from_display || 'Unknown',
      fromAddress: row.from_email || undefined,
      to: extractAddresses(row.to_addresses),
      cc: extractAddresses(row.cc_addresses),
      deliveredTo: extractDeliveredToFromHeaders(row.headers),
      date: row.date ? new Date(row.date).toISOString() : new Date().toISOString(),
      flags: row.flags || [],
      snippet: row.snippet || undefined,
      hasAttachments: row.has_attachments || false,
      syncStatus: row.sync_status || "imap_synced",
      folderPath: row.folder_path || undefined,
      snoozedUntil: row.snoozed_until ? new Date(row.snoozed_until).toISOString() : undefined,
      spamScore: row.spam_score != null ? Number(row.spam_score) : deriveSpamScoreFromHeaders(row.headers),
    }));
    const last = visibleRows[visibleRows.length - 1];
    const nextCursor = hasMore && last
      ? encodeCursor({
          sortDate: last.date ? new Date(last.date).toISOString() : new Date(0).toISOString(),
          uid: Number(last.uid),
        })
      : null;

    return { emails, total, nextCursor, hasMore };
  } catch (err) {
    console.error(`[DB Error] fetchEmailsPaginated ${folder}:`, err);
    return { emails: [], total: 0, nextCursor: null, hasMore: false };
  }
}

export async function fetchThreadsPaginated(
  folder = "INBOX",
  page = 1,
  perPage = 50
): Promise<{ emails: EmailMessage[]; total: number; nextCursor: string | null; hasMore: boolean }> {
  const pool = getPool();
  try {
    await releaseDueSnoozedEmails();
    const path = await resolveFolderPath(folder);
    const trashPath = await resolveFolderPath("Trash");
    if (samePath(path, trashPath)) {
      await purgeExpiredTrashMessages(trashPath);
    }

    // Get the folder ID and account ID
    const folderResult = await pool.query(
      `SELECT f.id, f.account_id FROM folders f
       JOIN accounts a ON f.account_id = a.id
       WHERE a.email = $1 AND f.path = $2`,
      [CURRENT_USER, path]
    );
    if (folderResult.rows.length === 0) return { emails: [], total: 0, nextCursor: null, hasMore: false };
    const folderId = folderResult.rows[0].id;
    const accountId = folderResult.rows[0].account_id;

    const offset = (page - 1) * perPage;

    // Count distinct threads in this folder + messages without threads
    const [countResult, threadsResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS total FROM (
           SELECT COALESCE(m.thread_id::text, m.id::text) AS group_id
           FROM messages m
           WHERE m.folder_id = $1
           GROUP BY group_id
         ) sub`,
        [folderId]
      ),
      pool.query(
        `SELECT
           COALESCE(m.thread_id::text, m.id::text) AS group_id,
           m.thread_id,
           MAX(m.date) AS last_date
         FROM messages m
         WHERE m.folder_id = $1
         GROUP BY group_id, m.thread_id
         ORDER BY last_date DESC
         LIMIT $2 OFFSET $3`,
        [folderId, perPage, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0]?.total ?? '0', 10);

    // For each group, fetch details with cross-folder aggregation
    const emails: EmailMessage[] = [];
    for (const row of threadsResult.rows) {
      const threadId = row.thread_id;

      if (threadId) {
        // Thread: aggregate counts across ALL folders, get latest message from current folder
        const [latestMsg, crossFolderStats, participantsResult, sentFallbackStats] = await Promise.all([
          pool.query(
            `SELECT m.uid, m.subject, m.date, m.flags, m.snippet, m.has_attachments, ${SYNC_STATUS_SQL},
                    COALESCE(m.from_address->>'name', m.from_address->>'address', 'Unknown') AS from_display,
                    m.from_address->>'address' AS from_email,
                    m.to_addresses, m.cc_addresses, m.headers,
                    (
                      SELECT ms.until_at
                      FROM mail_snoozes ms
                      WHERE ms.account_email = $3
                        AND (
                          (ms.message_id IS NOT NULL AND ms.message_id = m.message_id)
                          OR (ms.message_id IS NULL AND ms.snoozed_uid = m.uid)
                        )
                      ORDER BY ms.until_at DESC
                      LIMIT 1
                    ) AS snoozed_until
             FROM messages m
             WHERE m.thread_id = $1 AND m.folder_id = $2
             ORDER BY m.date DESC
             LIMIT 1`,
            [threadId, folderId, CURRENT_USER]
          ),
          // Cross-folder: count ALL messages in thread across all folders
          pool.query(
            `SELECT
               COUNT(*) AS message_count,
               COUNT(*) FILTER (WHERE NOT ('\\Seen' = ANY(m.flags))) AS unread_count,
               BOOL_OR(m.has_attachments) AS has_attachments
             FROM messages m
             WHERE m.thread_id = $1 AND m.account_id = $2`,
            [threadId, accountId]
          ),
          // Cross-folder: get ALL participants from all folders
          pool.query(
            `SELECT DISTINCT COALESCE(m.from_address->>'name', m.from_address->>'address', 'Unknown') AS sender
             FROM messages m
             WHERE m.thread_id = $1 AND m.account_id = $2
             ORDER BY sender`,
            [threadId, accountId]
          ),
          // Include sent replies linked by headers, even if thread_id is missing/split.
          pool.query(
            `WITH thread_msgids AS (
               SELECT m.message_id
               FROM messages m
               WHERE m.thread_id = $1 AND m.account_id = $2 AND m.message_id IS NOT NULL
             ),
             thread_inreply AS (
               SELECT m.in_reply_to
               FROM messages m
               WHERE m.thread_id = $1 AND m.account_id = $2 AND m.in_reply_to IS NOT NULL
             )
             SELECT
               COUNT(*)::int AS extra_count,
               BOOL_OR(s.has_attachments) AS extra_has_attachments
             FROM messages s
             JOIN folders sf ON sf.id = s.folder_id
             WHERE s.account_id = $2
               AND lower(sf.path) LIKE 'sent%'
               AND (s.thread_id IS NULL OR s.thread_id <> $1)
               AND (
                 (s.in_reply_to IS NOT NULL AND s.in_reply_to IN (SELECT message_id FROM thread_msgids))
                 OR (s.message_id IS NOT NULL AND s.message_id IN (SELECT in_reply_to FROM thread_inreply))
                 OR EXISTS (
                   SELECT 1
                   FROM unnest(COALESCE(s."references", '{}'::text[])) r
                   JOIN thread_msgids t ON t.message_id = r
                 )
               )`,
            [threadId, accountId]
          ),
        ]);

        const stats = crossFolderStats.rows[0];
        const extra = sentFallbackStats.rows[0];
        const extraCount = parseInt(extra?.extra_count ?? '0', 10);
        const msgCount = parseInt(stats?.message_count ?? '1', 10) + extraCount;

        if (latestMsg.rows.length > 0) {
          const msg = latestMsg.rows[0];
          const participants = participantsResult.rows.map((r: any) => r.sender);
          if (extraCount > 0 && !participants.some((p: string) => p.toLowerCase() === CURRENT_USER.toLowerCase())) {
            participants.push(CURRENT_USER);
          }
          emails.push({
            id: Number(msg.uid),
            seq: Number(msg.uid),
            subject: msg.subject || '(No Subject)',
            from: participants.length > 1 ? participants.join(', ') : msg.from_display || 'Unknown',
            fromAddress: msg.from_email || undefined,
            to: extractAddresses(msg.to_addresses),
            cc: extractAddresses(msg.cc_addresses),
            deliveredTo: extractDeliveredToFromHeaders(msg.headers),
            date: msg.date ? new Date(msg.date).toISOString() : new Date().toISOString(),
            flags: msg.flags || [],
            snippet: msg.snippet || undefined,
            hasAttachments: Boolean(stats?.has_attachments || extra?.extra_has_attachments),
            syncStatus: msg.sync_status || "imap_synced",
            threadId,
            messageCount: msgCount,
            unreadCount: parseInt(stats?.unread_count ?? '0', 10),
            participants,
            snoozedUntil: msg.snoozed_until ? new Date(msg.snoozed_until).toISOString() : undefined,
          });
        }
      } else {
        // Single message (no thread)
        const msgResult = await pool.query(
          `SELECT m.uid, m.subject, m.date, m.flags, m.snippet, m.has_attachments, ${SYNC_STATUS_SQL}, m.thread_id,
                  COALESCE(m.from_address->>'name', m.from_address->>'address', 'Unknown') AS from_display,
                  m.from_address->>'address' AS from_email,
                  m.to_addresses, m.cc_addresses, m.headers,
                  (
                    SELECT ms.until_at
                    FROM mail_snoozes ms
                    WHERE ms.account_email = $3
                      AND (
                        (ms.message_id IS NOT NULL AND ms.message_id = m.message_id)
                        OR (ms.message_id IS NULL AND ms.snoozed_uid = m.uid)
                      )
                    ORDER BY ms.until_at DESC
                    LIMIT 1
                  ) AS snoozed_until
           FROM messages m
           WHERE m.folder_id = $1
             AND COALESCE(m.thread_id::text, m.id::text) = $2
           ORDER BY m.date DESC
           LIMIT 1`,
          [folderId, row.group_id, CURRENT_USER]
        );

        if (msgResult.rows.length > 0) {
          const msg = msgResult.rows[0];
          emails.push({
            id: Number(msg.uid),
            seq: Number(msg.uid),
            subject: msg.subject || '(No Subject)',
            from: msg.from_display || 'Unknown',
            fromAddress: msg.from_email || undefined,
            to: extractAddresses(msg.to_addresses),
            cc: extractAddresses(msg.cc_addresses),
            deliveredTo: extractDeliveredToFromHeaders(msg.headers),
            date: msg.date ? new Date(msg.date).toISOString() : new Date().toISOString(),
            flags: msg.flags || [],
            snippet: msg.snippet || undefined,
            hasAttachments: msg.has_attachments || false,
            syncStatus: msg.sync_status || "imap_synced",
            threadId: msg.thread_id || undefined,
            messageCount: 1,
            unreadCount: !(msg.flags || []).includes('\\Seen') ? 1 : 0,
            snoozedUntil: msg.snoozed_until ? new Date(msg.snoozed_until).toISOString() : undefined,
          });
        }
      }
    }

    return { emails, total, nextCursor: null, hasMore: page * perPage < total };
  } catch (err) {
    console.error(`[DB Error] fetchThreadsPaginated ${folder}:`, err);
    return { emails: [], total: 0, nextCursor: null, hasMore: false };
  }
}

export async function getEmail(seq: string, folder = "INBOX"): Promise<FullEmail | null> {
  const pool = getPool();
  try {
    await ensureSpamScoreColumn();
    const path = await resolveFolderPath(folder);
    const uid = parseInt(seq, 10);

    const result = await pool.query(
      `SELECT m.id AS message_row_id, m.uid, m.subject,
              COALESCE(m.from_address->>'name', m.from_address->>'address', 'Unknown') AS from_display,
              m.from_address->>'address' AS from_email,
              m.date, m.flags, m.html_body, m.text_body, m.snippet, m.has_attachments,
              m.spam_score,
              ${SYNC_STATUS_SQL},
              m.to_addresses, m.cc_addresses, m.bcc_addresses, m.reply_to, m.headers,
              m.message_id, m.in_reply_to, m."references"
       FROM messages m
       JOIN folders f ON m.folder_id = f.id
       JOIN accounts a ON f.account_id = a.id
       WHERE a.email = $1 AND f.path = $2 AND m.uid = $3`,
      [CURRENT_USER, path, uid]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const attachments = await listMessageAttachmentsByIds([row.message_row_id]);
    return {
      id: Number(row.uid),
      seq: Number(row.uid),
      subject: row.subject || '(No Subject)',
      from: row.from_display || 'Unknown',
      date: row.date ? new Date(row.date).toISOString() : new Date().toISOString(),
      flags: row.flags || [],
      html: row.html_body || undefined,
      text: row.text_body || undefined,
      to: extractAddresses(row.to_addresses),
      cc: extractAddresses(row.cc_addresses),
      bcc: extractAddresses(row.bcc_addresses),
      replyTo: extractAddresses(row.reply_to),
      snippet: row.snippet || undefined,
      hasAttachments: row.has_attachments || false,
      syncStatus: row.sync_status || "imap_synced",
      fromAddress: row.from_email || undefined,
      accountEmail: CURRENT_USER,
      messageId: row.message_id || undefined,
      inReplyTo: row.in_reply_to || undefined,
      references: Array.isArray(row.references) ? row.references : undefined,
      attachments: attachments.get(row.message_row_id) || [],
      spamScore: row.spam_score != null ? Number(row.spam_score) : deriveSpamScoreFromHeaders(row.headers),
    };
  } catch (err) {
    console.error(`[DB Error] getEmail ${folder}/${seq}:`, err);
    return null;
  }
}

interface ParsedSearchQuery {
  includeTerms: string[];
  excludeTerms: string[];
  from: string[];
  to: string[];
  cc: string[];
  subject: string[];
  hasAttachment?: boolean;
  isRead?: boolean;
  isUnread?: boolean;
  isStarred?: boolean;
  mailbox?: string;
  after?: string;
  before?: string;
  largerThanBytes?: number;
  smallerThanBytes?: number;
}

function tokenizeSearchQuery(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (current.trim()) tokens.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) tokens.push(current.trim());

  return tokens;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseBytes(value: string): number | null {
  const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)([kmgt]?b?)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;

  const unit = match[2];
  const scale =
    unit === "k" || unit === "kb" ? 1024
    : unit === "m" || unit === "mb" ? 1024 ** 2
    : unit === "g" || unit === "gb" ? 1024 ** 3
    : unit === "t" || unit === "tb" ? 1024 ** 4
    : 1;
  return Math.round(amount * scale);
}

function parseAbsoluteDate(value: string, mode: "before" | "after"): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/\//g, "-");
  const dateOnly = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;

    const dt = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
    if (Number.isNaN(dt.getTime())) return null;
    if (mode === "before") dt.setUTCDate(dt.getUTCDate() + 1);
    return dt.toISOString();
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function parseRelativeDate(value: string, mode: "older" | "newer"): string | null {
  const match = value.trim().toLowerCase().match(/^(\d+)\s*([dwmy])$/);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const now = new Date();
  if (match[2] === "d") now.setUTCDate(now.getUTCDate() - amount);
  if (match[2] === "w") now.setUTCDate(now.getUTCDate() - amount * 7);
  if (match[2] === "m") now.setUTCMonth(now.getUTCMonth() - amount);
  if (match[2] === "y") now.setUTCFullYear(now.getUTCFullYear() - amount);

  if (mode === "older") {
    return now.toISOString();
  }
  return now.toISOString();
}

function normalizeMailboxToken(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "all" || normalized === "allmail" || normalized === "anywhere") return undefined;
  if (normalized === "inbox") return "INBOX";
  if (normalized === "sent") return "Sent";
  if (normalized === "drafts") return "Drafts";
  if (normalized === "trash") return "Trash";
  if (normalized === "spam" || normalized === "junk") return "Junk";
  if (normalized === "archive") return "Archive";
  return value.trim();
}

function parseSearchQuery(rawQuery: string): ParsedSearchQuery {
  const parsed: ParsedSearchQuery = {
    includeTerms: [],
    excludeTerms: [],
    from: [],
    to: [],
    cc: [],
    subject: [],
  };

  const tokens = tokenizeSearchQuery(rawQuery);
  for (const token of tokens) {
    if (!token) continue;
    const negated = token.startsWith("-");
    const body = negated ? token.slice(1) : token;
    if (!body) continue;

    const colonIdx = body.indexOf(":");
    if (colonIdx > 0) {
      const key = body.slice(0, colonIdx).trim().toLowerCase();
      const rawValue = stripWrappingQuotes(body.slice(colonIdx + 1));
      if (!rawValue) continue;

      if (key === "from") parsed.from.push(rawValue);
      else if (key === "to") parsed.to.push(rawValue);
      else if (key === "cc") parsed.cc.push(rawValue);
      else if (key === "subject") parsed.subject.push(rawValue);
      else if (key === "has" && rawValue.toLowerCase() === "attachment") parsed.hasAttachment = true;
      else if (key === "is" && rawValue.toLowerCase() === "unread") parsed.isUnread = true;
      else if (key === "is" && rawValue.toLowerCase() === "read") parsed.isRead = true;
      else if (key === "is" && rawValue.toLowerCase() === "starred") parsed.isStarred = true;
      else if (key === "in") parsed.mailbox = normalizeMailboxToken(rawValue);
      else if (key === "before") parsed.before = parseAbsoluteDate(rawValue, "before") ?? parsed.before;
      else if (key === "after") parsed.after = parseAbsoluteDate(rawValue, "after") ?? parsed.after;
      else if (key === "older_than") parsed.before = parseRelativeDate(rawValue, "older") ?? parsed.before;
      else if (key === "newer_than") parsed.after = parseRelativeDate(rawValue, "newer") ?? parsed.after;
      else if (key === "larger") parsed.largerThanBytes = parseBytes(rawValue) ?? parsed.largerThanBytes;
      else if (key === "smaller") parsed.smallerThanBytes = parseBytes(rawValue) ?? parsed.smallerThanBytes;
      else if (key === "includes") parsed.includeTerms.push(rawValue);
      else if (key === "without") parsed.excludeTerms.push(rawValue);
      else if (negated) parsed.excludeTerms.push(rawValue);
      else parsed.includeTerms.push(rawValue);
      continue;
    }

    const plain = stripWrappingQuotes(body);
    if (!plain) continue;
    if (negated) parsed.excludeTerms.push(plain);
    else parsed.includeTerms.push(plain);
  }

  return parsed;
}

function buildWebSearchExpression(terms: string[]): string {
  return terms
    .map((term) => {
      const cleaned = term.trim().replaceAll('"', "");
      if (!cleaned) return "";
      return cleaned.includes(" ") ? `"${cleaned}"` : cleaned;
    })
    .filter(Boolean)
    .join(" ");
}

export async function searchEmails(query: string, folder = "INBOX"): Promise<EmailMessage[]> {
  if (!query.trim()) return fetchEmails(folder);

  const pool = getPool();
  try {
    const parsed = parseSearchQuery(query);
    const where: string[] = ["a.email = $1"];
    const params: unknown[] = [CURRENT_USER];

    const addParam = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (parsed.mailbox) {
      const folderPath = await resolveFolderPath(parsed.mailbox);
      where.push(`f.path = ${addParam(folderPath)}`);
    }
    if (parsed.hasAttachment !== undefined) where.push(`m.has_attachments = ${addParam(parsed.hasAttachment)}`);
    if (parsed.isUnread) where.push(`NOT ('\\Seen' = ANY(m.flags))`);
    if (parsed.isRead) where.push(`'\\Seen' = ANY(m.flags)`);
    if (parsed.isStarred) where.push(`'\\Flagged' = ANY(m.flags)`);
    if (parsed.after) where.push(`m.date >= ${addParam(parsed.after)}::timestamptz`);
    if (parsed.before) where.push(`m.date < ${addParam(parsed.before)}::timestamptz`);
    if (parsed.largerThanBytes !== undefined) where.push(`COALESCE(m.size_bytes, 0) >= ${addParam(parsed.largerThanBytes)}`);
    if (parsed.smallerThanBytes !== undefined) where.push(`COALESCE(m.size_bytes, 0) <= ${addParam(parsed.smallerThanBytes)}`);

    for (const value of parsed.from) {
      const pattern = `%${value}%`;
      where.push(
        `(COALESCE(m.from_address->>'address', '') ILIKE ${addParam(pattern)} OR COALESCE(m.from_address->>'name', '') ILIKE ${addParam(pattern)})`
      );
    }
    for (const value of parsed.to) {
      where.push(`COALESCE(m.to_addresses::text, '') ILIKE ${addParam(`%${value}%`)}`);
    }
    for (const value of parsed.cc) {
      where.push(`COALESCE(m.cc_addresses::text, '') ILIKE ${addParam(`%${value}%`)}`);
    }
    for (const value of parsed.subject) {
      where.push(`COALESCE(m.subject, '') ILIKE ${addParam(`%${value}%`)}`);
    }

    const includeExpression = buildWebSearchExpression(parsed.includeTerms);
    if (includeExpression) {
      where.push(
        `to_tsvector('english', coalesce(m.subject, '') || ' ' || coalesce(m.text_body, ''))
         @@ websearch_to_tsquery('english', ${addParam(includeExpression)})`
      );
    }
    for (const excludedTerm of parsed.excludeTerms) {
      where.push(
        `NOT (
          to_tsvector('english', coalesce(m.subject, '') || ' ' || coalesce(m.text_body, ''))
          @@ plainto_tsquery('english', ${addParam(excludedTerm)})
        )`
      );
    }

    const result = await pool.query(
      `SELECT m.uid, m.subject,
              COALESCE(m.from_address->>'name', m.from_address->>'address', 'Unknown') AS from_display,
              m.from_address->>'address' AS from_email,
              m.to_addresses, m.cc_addresses, m.headers,
              m.date, m.flags, m.snippet, m.has_attachments,
              f.path AS folder_path,
              ${SYNC_STATUS_SQL}
       FROM messages m
       JOIN folders f ON m.folder_id = f.id
       JOIN accounts a ON m.account_id = a.id
       WHERE ${where.join("\n         AND ")}
       ORDER BY m.date DESC
       LIMIT 100`,
      params
    );

    return result.rows.map((row: any) => ({
      id: Number(row.uid),
      seq: Number(row.uid),
      subject: row.subject || '(No Subject)',
      from: row.from_display || 'Unknown',
      fromAddress: row.from_email || undefined,
      to: extractAddresses(row.to_addresses),
      cc: extractAddresses(row.cc_addresses),
      deliveredTo: extractDeliveredToFromHeaders(row.headers),
      date: row.date ? new Date(row.date).toISOString() : new Date().toISOString(),
      flags: row.flags || [],
      snippet: row.snippet || undefined,
      hasAttachments: row.has_attachments || false,
      syncStatus: row.sync_status || "imap_synced",
      folderPath: row.folder_path || undefined,
    }));
  } catch (err) {
    console.error(`[DB Error] searchEmails:`, err);
    return [];
  }
}

export async function fetchSentContacts(): Promise<string[]> {
  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT c.email
       FROM contacts c
       JOIN accounts a ON c.account_id = a.id
       WHERE a.email = $1
       ORDER BY c.frequency DESC, c.last_contacted_at DESC NULLS LAST
       LIMIT 200`,
      [CURRENT_USER]
    );
    return result.rows.map((r: any) => r.email);
  } catch (err) {
    console.error("[DB Error] fetchSentContacts:", err);
    return [];
  }
}

// =============================================================================
// CONTACTS
// =============================================================================

export interface ContactEntry {
  id: string;
  email: string;
  displayName: string | null;
  frequency: number;
  lastContactedAt: string | null;
  source: string;
}

export async function fetchAllContacts(): Promise<ContactEntry[]> {
  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT c.id, c.email, c.display_name, c.frequency, c.last_contacted_at, c.source
       FROM contacts c
       JOIN accounts a ON c.account_id = a.id
       WHERE a.email = $1
       ORDER BY c.frequency DESC, c.last_contacted_at DESC NULLS LAST`,
      [CURRENT_USER]
    );
    return result.rows.map((r: any) => ({
      id: r.id,
      email: r.email,
      displayName: r.display_name,
      frequency: r.frequency,
      lastContactedAt: r.last_contacted_at,
      source: r.source,
    }));
  } catch (err) {
    console.error("[DB Error] fetchAllContacts:", err);
    return [];
  }
}

export async function addContactToDb(email: string, displayName?: string): Promise<void> {
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO contacts (account_id, email, display_name, source)
       SELECT a.id, $2, $3, 'manual'
       FROM accounts a WHERE a.email = $1
       ON CONFLICT (account_id, email) DO UPDATE SET
         display_name = COALESCE(EXCLUDED.display_name, contacts.display_name),
         updated_at = now()`,
      [CURRENT_USER, email.toLowerCase().trim(), displayName || null]
    );
  } catch (err) {
    console.error("[DB Error] addContactToDb:", err);
    throw err;
  }
}

export async function deleteContact(contactId: string): Promise<void> {
  const pool = getPool();
  try {
    await pool.query(
      `DELETE FROM contacts c
       USING accounts a
       WHERE c.account_id = a.id AND a.email = $1 AND c.id = $2`,
      [CURRENT_USER, contactId]
    );
  } catch (err) {
    console.error("[DB Error] deleteContact:", err);
    throw err;
  }
}

// =============================================================================
// WRITE OPERATIONS — delegated to sync-engine's localhost API so the webmail
// service no longer needs direct IMAP/SMTP access.
// =============================================================================

export async function markAsRead(seq: string, folder = "INBOX"): Promise<void> {
  const pool = getPool();
  const uid = parseInt(seq, 10);
  const path = await resolveFolderPath(folder);

  // Update DB immediately for responsive UI
  try {
    await pool.query(
      `UPDATE messages m
       SET flags = array_append(m.flags, '\\Seen'),
           updated_at = now()
       FROM folders f
       JOIN accounts a ON f.account_id = a.id
       WHERE m.folder_id = f.id AND a.email = $1 AND f.path = $2 AND m.uid = $3
         AND NOT ('\\Seen' = ANY(m.flags))`,
      [CURRENT_USER, path, uid]
    );
    // Update folder unread count
    await pool.query(
      `UPDATE folders f SET unread_count = GREATEST(0, unread_count - 1)
       FROM accounts a
       WHERE f.account_id = a.id AND a.email = $1 AND f.path = $2`,
      [CURRENT_USER, path]
    );
  } catch (err) {
    console.error("[DB Error] markAsRead DB update:", err);
  }

  // Also update via IMAP for upstream sync
  try {
    await upstreamSetFlags(path, [uid], ["\\Seen"], "add");
  } catch (err) {
    console.error("[Sync Engine Error] markAsRead:", err);
  }
}

export async function markAsUnread(seq: string, folder = "INBOX"): Promise<void> {
  const pool = getPool();
  const uid = parseInt(seq, 10);
  const path = await resolveFolderPath(folder);

  // Update DB immediately for responsive UI
  try {
    await pool.query(
      `UPDATE messages m
       SET flags = array_remove(m.flags, '\\Seen'),
           updated_at = now()
       FROM folders f
       JOIN accounts a ON f.account_id = a.id
       WHERE m.folder_id = f.id AND a.email = $1 AND f.path = $2 AND m.uid = $3`,
      [CURRENT_USER, path, uid]
    );
    // Update folder unread count
    await pool.query(
      `UPDATE folders f SET unread_count = unread_count + 1
       FROM accounts a
       WHERE f.account_id = a.id AND a.email = $1 AND f.path = $2`,
      [CURRENT_USER, path]
    );
  } catch (err) {
    console.error("[DB Error] markAsUnread DB update:", err);
  }

  // Also update via IMAP for upstream sync
  try {
    await upstreamSetFlags(path, [uid], ["\\Seen"], "remove");
  } catch (err) {
    console.error("[Sync Engine Error] markAsUnread:", err);
  }
}

export async function toggleStar(seq: string, starred: boolean, folder = "INBOX"): Promise<void> {
  const pool = getPool();
  const uid = parseInt(seq, 10);
  const path = await resolveFolderPath(folder);

  // Optimistic DB update for immediate UI feedback
  try {
    if (starred) {
      await pool.query(
        `UPDATE messages m
         SET flags = array_append(m.flags, '\\Flagged'),
             updated_at = now()
         FROM folders f
         JOIN accounts a ON f.account_id = a.id
         WHERE m.folder_id = f.id AND a.email = $1 AND f.path = $2 AND m.uid = $3
           AND NOT ('\\Flagged' = ANY(m.flags))`,
        [CURRENT_USER, path, uid]
      );
    } else {
      await pool.query(
        `UPDATE messages m
         SET flags = array_remove(m.flags, '\\Flagged'),
             updated_at = now()
         FROM folders f
         JOIN accounts a ON f.account_id = a.id
         WHERE m.folder_id = f.id AND a.email = $1 AND f.path = $2 AND m.uid = $3`,
        [CURRENT_USER, path, uid]
      );
    }
  } catch (err) {
    console.error("[DB Error] toggleStar DB update:", err);
  }

  // Also update via IMAP for upstream sync
  try {
    await upstreamSetFlags(path, [uid], ["\\Flagged"], starred ? "add" : "remove");
  } catch (err) {
    console.error("[Sync Engine Error] toggleStar:", err);
  }
}

export async function deleteEmail(seq: string, currentFolder = "INBOX"): Promise<void> {
  const pool = getPool();
  const uid = parseInt(seq, 10);
  const sourcePath = await resolveFolderPath(currentFolder);
  const targetPath = await resolveFolderPath("Trash");
  const deletingFromTrash = samePath(sourcePath, targetPath);

  if (deletingFromTrash) {
    await permanentlyDeleteUids(sourcePath, [uid]);
    return;
  }

  const restoreMarker = trashOriginFlag(sourcePath);

  // Optimistic DB move for immediate UI feedback
  try {
    await pool.query(
      `INSERT INTO folders (account_id, path, name, sync_state)
       SELECT a.id, $2::varchar, $2::varchar, 'stale'
       FROM accounts a
       WHERE a.email = $1
         AND NOT EXISTS (
           SELECT 1 FROM folders f
           WHERE f.account_id = a.id AND f.path = $2::varchar
         )`,
      [CURRENT_USER, targetPath]
    );
    await pool.query(
      `WITH src AS (
         SELECT m.id
         FROM messages m
         JOIN folders f ON m.folder_id = f.id
         JOIN accounts a ON f.account_id = a.id
         WHERE a.email = $1 AND f.path = $2 AND m.uid = $3
       ),
       dst AS (
         SELECT f.id
         FROM folders f
         JOIN accounts a ON f.account_id = a.id
         WHERE a.email = $1 AND f.path = $4
         LIMIT 1
       )
       UPDATE messages m
       SET folder_id = (SELECT id FROM dst),
           flags = array_append(
             ARRAY(
               SELECT f FROM unnest(m.flags) f
               WHERE f NOT LIKE '__trash_from:%'
             ),
             $5
           ),
           updated_at = now()
       WHERE m.id IN (SELECT id FROM src)
         AND EXISTS (SELECT 1 FROM dst)`,
      [CURRENT_USER, sourcePath, uid, targetPath, restoreMarker]
    );
  } catch (err) {
    console.error("[DB Error] deleteEmail DB update:", err);
  }

  // Move to Trash via IMAP for upstream sync
  try {
    await upstreamMoveMessages(sourcePath, targetPath, [uid]);
  } catch (err) {
    console.error("[Sync Engine Error] deleteEmail:", err);
  }
}

export async function deleteEmailsBatch(seqs: string[], currentFolder = "INBOX"): Promise<void> {
  if (seqs.length === 0) return;
  const pool = getPool();
  const uids = seqs.map(s => parseInt(s, 10));
  const sourcePath = await resolveFolderPath(currentFolder);
  const targetPath = await resolveFolderPath("Trash");
  const deletingFromTrash = samePath(sourcePath, targetPath);

  if (deletingFromTrash) {
    await permanentlyDeleteUids(sourcePath, uids);
    return;
  }

  const restoreMarker = trashOriginFlag(sourcePath);

  // Optimistic DB move for immediate UI feedback
  try {
    await pool.query(
      `INSERT INTO folders (account_id, path, name, sync_state)
       SELECT a.id, $2::varchar, $2::varchar, 'stale'
       FROM accounts a
       WHERE a.email = $1
         AND NOT EXISTS (
           SELECT 1 FROM folders f
           WHERE f.account_id = a.id AND f.path = $2::varchar
         )`,
      [CURRENT_USER, targetPath]
    );
    await pool.query(
      `WITH src AS (
         SELECT m.id
         FROM messages m
         JOIN folders f ON m.folder_id = f.id
         JOIN accounts a ON f.account_id = a.id
         WHERE a.email = $1 AND f.path = $2 AND m.uid = ANY($3)
       ),
       dst AS (
         SELECT f.id
         FROM folders f
         JOIN accounts a ON f.account_id = a.id
         WHERE a.email = $1 AND f.path = $4
         LIMIT 1
       )
       UPDATE messages m
       SET folder_id = (SELECT id FROM dst),
           flags = array_append(
             ARRAY(
               SELECT f FROM unnest(m.flags) f
               WHERE f NOT LIKE '__trash_from:%'
             ),
             $5
           ),
           updated_at = now()
       WHERE m.id IN (SELECT id FROM src)
         AND EXISTS (SELECT 1 FROM dst)`,
      [CURRENT_USER, sourcePath, uids, targetPath, restoreMarker]
    );
  } catch (err) {
    console.error("[DB Error] deleteEmailsBatch DB update:", err);
  }

  // Move to Trash via IMAP for upstream sync
  try {
    await upstreamMoveMessages(sourcePath, targetPath, uids);
  } catch (err) {
    console.error("[Sync Engine Error] deleteEmailsBatch:", err);
  }
}

export async function archiveEmails(seqs: string[], currentFolder = "INBOX"): Promise<void> {
  if (seqs.length === 0) return;
  const pool = getPool();
  const uids = seqs.map(s => parseInt(s, 10));
  const sourcePath = await resolveFolderPath(currentFolder);
  const targetPath = await resolveFolderPath("Archive");

  // Optimistic DB move for immediate UI feedback
  try {
    await pool.query(
      `INSERT INTO folders (account_id, path, name, sync_state)
       SELECT a.id, $2::varchar, $2::varchar, 'stale'
       FROM accounts a
       WHERE a.email = $1
         AND NOT EXISTS (
           SELECT 1 FROM folders f
           WHERE f.account_id = a.id AND f.path = $2::varchar
         )`,
      [CURRENT_USER, targetPath]
    );
    await pool.query(
      `WITH src AS (
         SELECT m.id
         FROM messages m
         JOIN folders f ON m.folder_id = f.id
         JOIN accounts a ON f.account_id = a.id
         WHERE a.email = $1 AND f.path = $2 AND m.uid = ANY($3)
       ),
       dst AS (
         SELECT f.id
         FROM folders f
         JOIN accounts a ON f.account_id = a.id
         WHERE a.email = $1 AND f.path = $4
         LIMIT 1
       )
       UPDATE messages m
       SET folder_id = (SELECT id FROM dst),
           updated_at = now()
       WHERE m.id IN (SELECT id FROM src)
         AND EXISTS (SELECT 1 FROM dst)`,
      [CURRENT_USER, sourcePath, uids, targetPath]
    );
  } catch (err) {
    console.error("[DB Error] archiveEmails DB update:", err);
  }

  // Move to Archive via IMAP for upstream sync
  try {
    await upstreamMoveMessages(sourcePath, targetPath, uids);
  } catch (err) {
    console.error("[Sync Engine Error] archiveEmails:", err);
  }
}

export async function addEmailLabel(seq: string, label: string, folder = "INBOX"): Promise<void> {
  const pool = getPool();
  const uid = parseInt(seq, 10);
  const path = await resolveFolderPath(folder);

  // Optimistic DB update for immediate UI feedback
  try {
    await pool.query(
      `UPDATE messages m
       SET flags = array_append(m.flags, $4),
           updated_at = now()
       FROM folders f
       JOIN accounts a ON f.account_id = a.id
       WHERE m.folder_id = f.id AND a.email = $1 AND f.path = $2 AND m.uid = $3
         AND NOT ($4 = ANY(m.flags))`,
      [CURRENT_USER, path, uid, label]
    );
  } catch (err) {
    console.error("[DB Error] addEmailLabel DB update:", err);
  }

  // Also update via IMAP for upstream sync
  try {
    await upstreamSetFlags(path, [uid], [label], "add");
  } catch (err) {
    console.error("[Sync Engine Error] addEmailLabel:", err);
  }
}

export async function removeEmailLabel(seq: string, label: string, folder = "INBOX"): Promise<void> {
  const pool = getPool();
  const uid = parseInt(seq, 10);
  const path = await resolveFolderPath(folder);

  // Optimistic DB update for immediate UI feedback
  try {
    await pool.query(
      `UPDATE messages m
       SET flags = array_remove(m.flags, $4),
           updated_at = now()
       FROM folders f
       JOIN accounts a ON f.account_id = a.id
       WHERE m.folder_id = f.id AND a.email = $1 AND f.path = $2 AND m.uid = $3`,
      [CURRENT_USER, path, uid, label]
    );
  } catch (err) {
    console.error("[DB Error] removeEmailLabel DB update:", err);
  }

  // Also update via IMAP for upstream sync
  try {
    await upstreamSetFlags(path, [uid], [label], "remove");
  } catch (err) {
    console.error("[Sync Engine Error] removeEmailLabel:", err);
  }
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: string; // base64
  cid?: string;
  contentDisposition?: "attachment" | "inline";
}

export interface SendEmailOptions {
  scheduledAt?: Date | string | null;
}

export type SendEmailResult =
  | { status: "sent" }
  | { status: "scheduled"; scheduledFor: string };

interface ScheduledSendPayload {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  attachments?: EmailAttachment[];
  threading?: { inReplyTo?: string; references?: string[] };
  fromName?: string;
}

function parseScheduledAt(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

async function ensureScheduledSendsTable(): Promise<void> {
  const pool = getPool();
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS mail_scheduled_sends (
         id BIGSERIAL PRIMARY KEY,
         account_email TEXT NOT NULL,
         to_recipients TEXT NOT NULL,
         subject TEXT NOT NULL,
         body_html TEXT NOT NULL,
         cc_recipients TEXT NULL,
         bcc_recipients TEXT NULL,
         attachments JSONB NULL,
         threading JSONB NULL,
         from_name TEXT NULL,
         send_at TIMESTAMPTZ NOT NULL,
         retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         attempts INT NOT NULL DEFAULT 0,
         last_error TEXT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_mail_scheduled_sends_due
       ON mail_scheduled_sends (account_email, send_at, retry_at)`,
    );
  } catch (err) {
    console.error("[DB Error] ensureScheduledSendsTable:", err);
  }
}

function isEmailAttachment(value: unknown): value is EmailAttachment {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.filename === "string"
    && typeof candidate.contentType === "string"
    && typeof candidate.content === "string"
    && (candidate.cid === undefined || typeof candidate.cid === "string")
    && (candidate.contentDisposition === undefined || candidate.contentDisposition === "attachment" || candidate.contentDisposition === "inline")
  );
}

function parseThreading(value: unknown): { inReplyTo?: string; references?: string[] } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const inReplyTo = typeof candidate.inReplyTo === "string" ? candidate.inReplyTo : undefined;
  const references = Array.isArray(candidate.references)
    ? candidate.references.filter((item): item is string => typeof item === "string")
    : undefined;
  if (!inReplyTo && (!references || references.length === 0)) return undefined;
  return { inReplyTo, references };
}

async function queueScheduledEmail(payload: ScheduledSendPayload, sendAt: Date): Promise<void> {
  await ensureScheduledSendsTable();
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO mail_scheduled_sends (
         account_email, to_recipients, subject, body_html, cc_recipients, bcc_recipients, attachments, threading, from_name, send_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
      [
        CURRENT_USER,
        payload.to,
        payload.subject,
        payload.body,
        payload.cc ?? null,
        payload.bcc ?? null,
        JSON.stringify(payload.attachments ?? []),
        JSON.stringify(payload.threading ?? null),
        payload.fromName ?? null,
        sendAt.toISOString(),
      ],
    );
  } catch (err) {
    console.error("[DB Error] queueScheduledEmail:", err);
    throw err;
  }
}

export async function cancelScheduledEmail(seq: string): Promise<void> {
  await ensureScheduledSendsTable();
  const id = Math.abs(parseInt(seq, 10));
  if (!Number.isFinite(id) || id <= 0) return;
  const pool = getPool();
  try {
    await pool.query(
      `DELETE FROM mail_scheduled_sends
       WHERE account_email = $1 AND id = $2`,
      [CURRENT_USER, id],
    );
  } catch (err) {
    console.error("[DB Error] cancelScheduledEmail:", err);
    throw err;
  }
}

export async function cancelScheduledEmails(seqs: string[]): Promise<void> {
  await ensureScheduledSendsTable();
  const ids = Array.from(
    new Set(
      seqs
        .map((seq) => Math.abs(parseInt(seq, 10)))
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  );
  if (!ids.length) return;
  const pool = getPool();
  try {
    await pool.query(
      `DELETE FROM mail_scheduled_sends
       WHERE account_email = $1 AND id = ANY($2::bigint[])`,
      [CURRENT_USER, ids],
    );
  } catch (err) {
    console.error("[DB Error] cancelScheduledEmails:", err);
    throw err;
  }
}

async function releaseDueScheduledSends(): Promise<void> {
  const now = Date.now();
  if (now - lastScheduledSendSweepAt < SCHEDULED_SEND_SWEEP_MIN_GAP_MS) return;
  if (scheduledSendSweepInFlight) {
    await scheduledSendSweepInFlight;
    return;
  }

  scheduledSendSweepInFlight = (async () => {
    lastScheduledSendSweepAt = Date.now();
    await ensureScheduledSendsTable();
    const pool = getPool();
    try {
      const due = await pool.query(
        `SELECT id, to_recipients, subject, body_html, cc_recipients, bcc_recipients, attachments, threading, from_name
         FROM mail_scheduled_sends
         WHERE account_email = $1 AND send_at <= now() AND retry_at <= now()
         ORDER BY send_at ASC
         LIMIT 20`,
        [CURRENT_USER],
      );

      for (const row of due.rows) {
        const attachments = Array.isArray(row.attachments)
          ? row.attachments.filter((item: unknown): item is EmailAttachment => isEmailAttachment(item))
          : [];
        const threading = parseThreading(row.threading);
        try {
          await sendEmailNow(
            row.to_recipients,
            row.subject,
            row.body_html,
            row.cc_recipients ?? undefined,
            row.bcc_recipients ?? undefined,
            attachments.length > 0 ? attachments : undefined,
            threading,
            row.from_name ?? undefined,
          );
          await pool.query(`DELETE FROM mail_scheduled_sends WHERE id = $1`, [row.id]);
        } catch (err) {
          console.error("[Schedule Error] releaseDueScheduledSends send:", err);
          await pool.query(
            `UPDATE mail_scheduled_sends
             SET attempts = attempts + 1,
                 last_error = left($2, 1000),
                 retry_at = now() + interval '5 minutes'
             WHERE id = $1`,
            [row.id, err instanceof Error ? err.message : String(err)],
          );
        }
      }
    } catch (err) {
      console.error("[DB Error] releaseDueScheduledSends:", err);
    }
  })().finally(() => {
    scheduledSendSweepInFlight = null;
  });

  await scheduledSendSweepInFlight;
}

async function sendEmailNow(
  to: string,
  subject: string,
  body: string,
  cc?: string,
  bcc?: string,
  attachments?: EmailAttachment[],
  threading?: { inReplyTo?: string; references?: string[] },
  fromName?: string,
): Promise<void> {
  const isHtml = body.trimStart().startsWith("<");
  const { html: normalizedHtmlBody, inlineAttachments } = isHtml
    ? extractInlineDataImageAttachments(body)
    : { html: body, inlineAttachments: [] as EmailAttachment[] };
  const plainText = isHtml ? htmlToPlainText(normalizedHtmlBody) : body;
  const date = new Date();
  const messageId = makeOutgoingMessageId(CURRENT_USER);
  const inReplyTo = threading?.inReplyTo ? normalizeMessageId(threading.inReplyTo) : undefined;
  const references = Array.from(
    new Set(
      (threading?.references ?? [])
        .filter(Boolean)
        .map(normalizeMessageId)
        .concat(inReplyTo ? [inReplyTo] : [])
    )
  );
  const outgoingThreadId = await resolveThreadForOutgoingReply(inReplyTo, references);
  const senderDisplayName = await resolveCurrentUserDisplayName(fromName);

  const mergedAttachments = [...(attachments ?? []), ...inlineAttachments];
  await upstreamSendMessage({
    from: { name: senderDisplayName, address: CURRENT_USER },
    to,
    subject,
    text: plainText,
    date: date.toISOString(),
    messageId,
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references.length ? { references } : {}),
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
    ...(isHtml ? { html: normalizedHtmlBody } : {}),
    ...(mergedAttachments.length ? { attachments: mergedAttachments } : {}),
  });

  // Persist a copy in Sent for providers that don't auto-save SMTP messages.
  const sentPath = await resolveFolderPath("Sent");
  try {
    const rawMessage = buildRawHtmlMessage(to, subject, normalizedHtmlBody, senderDisplayName, cc, bcc, {
      date,
      messageId,
      inReplyTo,
      references,
    });
    const appendResult = await upstreamAppendMessage(sentPath, rawMessage, ["\\Seen"]);
    await ensureFolderEntry(sentPath, "Sent", "\\Sent");
    if (appendResult?.uid != null) {
      await upsertLocalMessageCopy({
        folderPath: sentPath,
        folderName: "Sent",
        specialUse: "\\Sent",
        threadId: outgoingThreadId || undefined,
        uid: appendResult.uid,
        subject,
        html: normalizedHtmlBody,
        text: plainText,
        to,
        cc,
        bcc,
        flags: ["\\Seen"],
        hasAttachments: mergedAttachments.length > 0,
        messageId,
        inReplyTo,
        references,
        fromName: senderDisplayName,
      });
    }
  } catch (err) {
    console.error("[Sync Engine Error] sendEmail append to Sent:", err);
  }
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  cc?: string,
  bcc?: string,
  attachments?: EmailAttachment[],
  threading?: { inReplyTo?: string; references?: string[] },
  fromName?: string,
  options?: SendEmailOptions,
): Promise<SendEmailResult> {
  const scheduledAt = parseScheduledAt(options?.scheduledAt);
  if (scheduledAt) {
    if (scheduledAt.getTime() <= Date.now()) {
      throw new Error("Scheduled send time must be in the future");
    }
    await queueScheduledEmail(
      { to, subject, body, cc, bcc, attachments, threading, fromName },
      scheduledAt,
    );
    return { status: "scheduled", scheduledFor: scheduledAt.toISOString() };
  }

  await sendEmailNow(to, subject, body, cc, bcc, attachments, threading, fromName);
  return { status: "sent" };
}

// =============================================================================
// THREAD / CONVERSATION OPERATIONS
// =============================================================================

export async function getThreadMessages(threadId: string): Promise<FullEmail[]> {
  const pool = getPool();
  try {
    const baseResult = await pool.query(
      `SELECT m.id AS message_row_id, m.uid, m.subject,
              COALESCE(m.from_address->>'name', m.from_address->>'address', 'Unknown') AS from_display,
              m.from_address->>'address' AS from_email,
              m.date, m.flags, m.html_body, m.text_body, m.snippet, m.has_attachments,
              ${SYNC_STATUS_SQL},
              m.to_addresses, m.cc_addresses, m.reply_to,
              m.message_id, m.in_reply_to, m."references",
              m.thread_id::text AS thread_id,
              f.path AS folder_path
       FROM messages m
       JOIN accounts a ON m.account_id = a.id
       JOIN folders f ON m.folder_id = f.id
       WHERE a.email = $1 AND m.thread_id = $2
       ORDER BY m.date ASC`,
      [CURRENT_USER, threadId]
    );

    let attachmentsByMessageId = await listMessageAttachmentsByIds(
      baseResult.rows.map((row: any) => row.message_row_id).filter(Boolean),
    );

    const mapRow = (row: any): FullEmail => ({
      id: Number(row.uid),
      seq: Number(row.uid),
      subject: row.subject || '(No Subject)',
      from: row.from_display || 'Unknown',
      date: row.date ? new Date(row.date).toISOString() : new Date().toISOString(),
      flags: row.flags || [],
      html: row.html_body || undefined,
      text: row.text_body || undefined,
      to: extractAddresses(row.to_addresses),
      cc: extractAddresses(row.cc_addresses),
      replyTo: extractAddresses(row.reply_to),
      snippet: row.snippet || undefined,
      hasAttachments: row.has_attachments || false,
      syncStatus: row.sync_status || "imap_synced",
      fromAddress: row.from_email || undefined,
      accountEmail: CURRENT_USER,
      folderPath: row.folder_path || undefined,
      messageId: row.message_id || undefined,
      inReplyTo: row.in_reply_to || undefined,
      references: Array.isArray(row.references) ? row.references : undefined,
      attachments: attachmentsByMessageId.get(row.message_row_id) || [],
    });

    const baseMessages = baseResult.rows.map(mapRow);
    if (baseMessages.length === 0) return [];

    // Gmail-style fallback: include nearby same-subject messages with the same counterparty
    // even if they landed in a different thread_id (legacy/local sent copies).
    const normSubject = normalizeConversationSubject(baseMessages[0].subject);
    const counterparty = pickCounterpartyAddress(baseMessages[baseMessages.length - 1]) || pickCounterpartyAddress(baseMessages[0]);
    const firstDate = parseIsoDate(baseMessages[0].date);
    const lastDate = parseIsoDate(baseMessages[baseMessages.length - 1].date);
    if (!normSubject || !counterparty || !firstDate || !lastDate) {
      return baseMessages;
    }

    const from = new Date(firstDate.getTime() - 7 * 24 * 60 * 60 * 1000);
    const to = new Date(lastDate.getTime() + 7 * 24 * 60 * 60 * 1000);

    const candidateThreadsResult = await pool.query(
      `SELECT DISTINCT m.thread_id::text AS thread_id, m.subject
       FROM messages m
       JOIN accounts a ON m.account_id = a.id
       WHERE a.email = $1
         AND m.thread_id IS NOT NULL
         AND m.thread_id <> $2::uuid
         AND m.date BETWEEN $3::timestamptz AND $4::timestamptz
         AND (
           lower(COALESCE(m.from_address->>'address', '')) = $5
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(m.to_addresses) x WHERE lower(COALESCE(x->>'address', '')) = $5)
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(m.cc_addresses) x WHERE lower(COALESCE(x->>'address', '')) = $5)
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(m.reply_to) x WHERE lower(COALESCE(x->>'address', '')) = $5)
         )`,
      [CURRENT_USER, threadId, from.toISOString(), to.toISOString(), counterparty]
    );

    const relatedThreadIds = new Set<string>([threadId]);
    for (const row of candidateThreadsResult.rows) {
      if (normalizeConversationSubject(row.subject || "") === normSubject) {
        relatedThreadIds.add(row.thread_id);
      }
    }

    let merged = baseMessages;
    if (relatedThreadIds.size > 1) {
      const mergedResult = await pool.query(
        `SELECT m.id AS message_row_id, m.uid, m.subject,
                COALESCE(m.from_address->>'name', m.from_address->>'address', 'Unknown') AS from_display,
                m.from_address->>'address' AS from_email,
                m.date, m.flags, m.html_body, m.text_body, m.snippet, m.has_attachments,
                ${SYNC_STATUS_SQL},
                m.to_addresses, m.cc_addresses, m.reply_to,
                m.message_id, m.in_reply_to, m."references",
                m.thread_id::text AS thread_id,
                f.path AS folder_path
         FROM messages m
         JOIN accounts a ON m.account_id = a.id
         JOIN folders f ON m.folder_id = f.id
         WHERE a.email = $1
           AND m.thread_id = ANY($2::uuid[])
         ORDER BY m.date ASC`,
        [CURRENT_USER, Array.from(relatedThreadIds)]
      );
      const mergedAttachments = await listMessageAttachmentsByIds(
        mergedResult.rows.map((row: any) => row.message_row_id).filter(Boolean),
      );
      if (mergedAttachments.size > 0) {
        attachmentsByMessageId = new Map([...attachmentsByMessageId, ...mergedAttachments]);
      }
      merged = mergedResult.rows.map(mapRow);
    }

    // Include matching Sent messages even when they still have NULL thread_id.
    const byKey = new Map<string, FullEmail>();
    for (const msg of merged) byKey.set(emailDedupKey(msg), msg);

    try {
      const sentFallbackResult = await pool.query(
        `SELECT m.id AS message_row_id, m.uid, m.subject,
                COALESCE(m.from_address->>'name', m.from_address->>'address', 'Unknown') AS from_display,
                m.from_address->>'address' AS from_email,
                m.date, m.flags, m.html_body, m.text_body, m.snippet, m.has_attachments,
                ${SYNC_STATUS_SQL},
                m.to_addresses, m.cc_addresses, m.reply_to,
                m.message_id, m.in_reply_to, m."references",
                m.thread_id::text AS thread_id,
                f.path AS folder_path
         FROM messages m
         JOIN accounts a ON m.account_id = a.id
         JOIN folders f ON m.folder_id = f.id
         WHERE a.email = $1
           AND f.path = 'Sent'
           AND m.date BETWEEN $2::timestamptz AND $3::timestamptz
           AND lower(regexp_replace(coalesce(m.subject, ''), '^(\\s*(re|fwd?|aw|wg)\\s*(\\[\\d+\\])?\\s*:\\s*)+', '', 'i')) = $4
           AND (
             lower(COALESCE(m.from_address->>'address', '')) = $5
             OR EXISTS (
               SELECT 1
               FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(m.to_addresses) = 'array' THEN m.to_addresses ELSE '[]'::jsonb END
               ) x
               WHERE lower(COALESCE(x->>'address', '')) = $5
             )
             OR EXISTS (
               SELECT 1
               FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(m.cc_addresses) = 'array' THEN m.cc_addresses ELSE '[]'::jsonb END
               ) x
               WHERE lower(COALESCE(x->>'address', '')) = $5
             )
             OR EXISTS (
               SELECT 1
               FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(m.reply_to) = 'array' THEN m.reply_to ELSE '[]'::jsonb END
               ) x
               WHERE lower(COALESCE(x->>'address', '')) = $5
             )
           )
         ORDER BY m.date ASC`,
        [CURRENT_USER, from.toISOString(), to.toISOString(), normSubject, counterparty]
      );
      const sentFallbackAttachments = await listMessageAttachmentsByIds(
        sentFallbackResult.rows.map((row: any) => row.message_row_id).filter(Boolean),
      );
      if (sentFallbackAttachments.size > 0) {
        attachmentsByMessageId = new Map([...attachmentsByMessageId, ...sentFallbackAttachments]);
      }

      const sentFallback = sentFallbackResult.rows.map(mapRow);
      for (const msg of sentFallback) {
        const key = emailDedupKey(msg);
        if (!byKey.has(key)) byKey.set(key, msg);
      }
    } catch (err) {
      console.error("[DB Error] getThreadMessages sent fallback:", err);
    }

    return Array.from(byKey.values()).sort((a, b) => {
      const da = parseIsoDate(a.date)?.getTime() ?? 0;
      const db = parseIsoDate(b.date)?.getTime() ?? 0;
      return da - db;
    });
  } catch (err) {
    console.error(`[DB Error] getThreadMessages ${threadId}:`, err);
    return [];
  }
}

export async function getThreadIdForMessage(uid: number, folder: string): Promise<string | null> {
  const pool = getPool();
  try {
    const path = await resolveFolderPath(folder);
    const result = await pool.query(
      `SELECT m.thread_id::text
       FROM messages m
       JOIN folders f ON m.folder_id = f.id
       JOIN accounts a ON f.account_id = a.id
       WHERE a.email = $1 AND f.path = $2 AND m.uid = $3 AND m.thread_id IS NOT NULL`,
      [CURRENT_USER, path, uid]
    );
    return result.rows[0]?.thread_id || null;
  } catch (err) {
    console.error(`[DB Error] getThreadIdForMessage:`, err);
    return null;
  }
}

// --- Drafts ---

export async function saveDraft(to: string, subject: string, body: string, cc?: string, bcc?: string): Promise<void> {
  const draftsPath = await resolveFolderPath("Drafts");
  const isHtml = body.trimStart().startsWith("<");
  const plainText = isHtml ? htmlToPlainText(body) : body;
  try {
    const rawMessage = buildRawHtmlMessage(to, subject, body, cc, bcc);
    const appendResult = await upstreamAppendMessage(draftsPath, rawMessage, ["\\Draft", "\\Seen"]);
    await ensureFolderEntry(draftsPath, "Drafts", "\\Drafts");
    if (appendResult?.uid != null) {
      await upsertLocalMessageCopy({
        folderPath: draftsPath,
        folderName: "Drafts",
        specialUse: "\\Drafts",
        uid: appendResult.uid,
        subject,
        html: body,
        text: plainText,
        to,
        cc,
        bcc,
        flags: ["\\Draft", "\\Seen"],
        hasAttachments: false,
      });
    }
  } catch (err) {
    console.error("[Sync Engine Error] saveDraft:", err);
    throw err;
  }
}

export async function deleteDraft(seq: string): Promise<void> {
  const draftsPath = await resolveFolderPath("Drafts");
  try {
    const uid = parseInt(seq, 10);
    if (!Number.isFinite(uid)) return;
    await upstreamDeleteMessages(draftsPath, [uid]);
  } catch {
    // Drafts folder may not exist yet
  }
}

// --- Move to folder ---

export async function snoozeEmails(
  seqs: string[],
  currentFolder = "INBOX",
  untilISO: string,
): Promise<void> {
  if (!seqs.length) return;
  const until = new Date(untilISO);
  if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
    throw new Error("Snooze time must be in the future");
  }

  await ensureSnoozesTable();
  const pool = getPool();
  const sourcePath = await resolveFolderPath(currentFolder);

  for (const seq of seqs) {
    const uid = parseInt(seq, 10);
    if (!Number.isFinite(uid)) continue;

    let messageId: string | null = null;
    try {
      const lookup = await pool.query(
        `SELECT m.message_id
         FROM messages m
         JOIN folders f ON m.folder_id = f.id
         JOIN accounts a ON f.account_id = a.id
         WHERE a.email = $1 AND f.path = $2 AND m.uid = $3
         LIMIT 1`,
        [CURRENT_USER, sourcePath, uid]
      );
      messageId = lookup.rows[0]?.message_id ?? null;
    } catch (err) {
      console.error("[DB Error] snoozeEmails lookup:", err);
    }

    await moveToFolder(String(uid), sourcePath, "Snoozed");

    try {
      if (messageId) {
        await pool.query(
          `DELETE FROM mail_snoozes
           WHERE account_email = $1 AND message_id = $2`,
          [CURRENT_USER, messageId]
        );
      } else {
        await pool.query(
          `DELETE FROM mail_snoozes
           WHERE account_email = $1 AND snoozed_uid = $2`,
          [CURRENT_USER, uid]
        );
      }
      await pool.query(
        `INSERT INTO mail_snoozes (account_email, message_id, snoozed_uid, return_path, until_at)
         VALUES ($1, $2, $3, $4, $5::timestamptz)`,
        [CURRENT_USER, messageId, uid, sourcePath, until.toISOString()]
      );
    } catch (err) {
      console.error("[DB Error] snoozeEmails schedule:", err);
    }
  }
}

export async function moveToFolder(seq: string, fromFolder: string, toFolder: string): Promise<void> {
  const pool = getPool();
  const uid = parseInt(seq, 10);
  const sourcePath = await resolveFolderPath(fromFolder);
  const targetPath = await resolveFolderPath(toFolder);

  // Optimistic DB move for immediate UI/count updates
  try {
    await pool.query(
      `INSERT INTO folders (account_id, path, name, sync_state)
       SELECT a.id, $2::varchar, $2::varchar, 'stale'
       FROM accounts a
       WHERE a.email = $1
         AND NOT EXISTS (
           SELECT 1 FROM folders f
           WHERE f.account_id = a.id AND f.path = $2::varchar
         )`,
      [CURRENT_USER, targetPath]
    );
    await pool.query(
      `WITH src AS (
         SELECT m.id
         FROM messages m
         JOIN folders f ON m.folder_id = f.id
         JOIN accounts a ON f.account_id = a.id
         WHERE a.email = $1 AND f.path = $2 AND m.uid = $3
       ),
       dst AS (
         SELECT f.id
         FROM folders f
         JOIN accounts a ON f.account_id = a.id
         WHERE a.email = $1 AND f.path = $4
         LIMIT 1
       )
       UPDATE messages m
       SET folder_id = (SELECT id FROM dst),
           flags = ARRAY(
             SELECT f FROM unnest(m.flags) f
             WHERE f NOT LIKE '__trash_from:%'
           ),
           updated_at = now()
       WHERE m.id IN (SELECT id FROM src)
         AND EXISTS (SELECT 1 FROM dst)`,
      [CURRENT_USER, sourcePath, uid, targetPath]
    );
  } catch (err) {
    console.error("[DB Error] moveToFolder DB update:", err);
  }

  await persistDerivedSpamScoreIfMissing(targetPath, uid);

  if (!Number.isFinite(uid)) return;
  if (uid <= 0) {
    // Staged/importing rows have synthetic negative UIDs and cannot be moved in IMAP yet.
    await emitFolderSyncedEvent(sourcePath);
    await emitFolderSyncedEvent(targetPath);
    return;
  }

  try {
    await upstreamMoveMessages(sourcePath, targetPath, [uid]);
  } catch (err) {
    console.error("[Sync Engine Error] moveToFolder:", err);
    throw err;
  }
  await persistDerivedSpamScoreIfMissing(targetPath, uid);
  await emitFolderSyncedEvent(sourcePath);
  await emitFolderSyncedEvent(targetPath);
}

export async function restoreFromTrash(seq: string, folder = "Trash"): Promise<string> {
  const pool = getPool();
  const trashPath = await resolveFolderPath(folder);
  const trashCanonical = await resolveFolderPath("Trash");
  const uid = parseInt(seq, 10);

  if (!samePath(trashPath, trashCanonical)) {
    await moveToFolder(seq, folder, "INBOX");
    return "INBOX";
  }

  let target = "INBOX";
  try {
    const result = await pool.query(
      `SELECT m.flags
       FROM messages m
       JOIN folders f ON m.folder_id = f.id
       JOIN accounts a ON f.account_id = a.id
       WHERE a.email = $1 AND f.path = $2 AND m.uid = $3
       LIMIT 1`,
      [CURRENT_USER, trashPath, uid]
    );
    const origin = getTrashOriginFromFlags(result.rows[0]?.flags || []);
    if (origin) target = origin;
  } catch (err) {
    console.error("[DB Error] restoreFromTrash lookup:", err);
  }

  await moveToFolder(seq, trashPath, target);
  return targetFolderLabel(target);
}

// ---------------------------------------------------------------------------
// Blocked Senders
// ---------------------------------------------------------------------------

export interface BlockedSender {
  id: number;
  senderEmail: string;
  displayName: string | null;
  blockedAt: string;
}

export async function getBlockedSenders(): Promise<BlockedSender[]> {
  await ensureBlockedSendersTable();
  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT id, sender_email, display_name, blocked_at
       FROM blocked_senders
       WHERE account_email = $1
       ORDER BY blocked_at DESC`,
      [CURRENT_USER]
    );
    return result.rows.map((row) => ({
      id: row.id,
      senderEmail: row.sender_email,
      displayName: row.display_name ?? null,
      blockedAt: row.blocked_at instanceof Date ? row.blocked_at.toISOString() : String(row.blocked_at),
    }));
  } catch (err) {
    console.error("[DB Error] getBlockedSenders:", err);
    return [];
  }
}

export async function blockSender(senderEmail: string, displayName: string): Promise<void> {
  if (!senderEmail) return;
  await ensureBlockedSendersTable();
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO blocked_senders (account_email, sender_email, display_name)
       VALUES ($1, lower($2), $3)
       ON CONFLICT (account_email, sender_email) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             blocked_at   = now()`,
      [CURRENT_USER, senderEmail.trim(), displayName.trim() || null]
    );
  } catch (err) {
    console.error("[DB Error] blockSender:", err);
  }
}

export async function unblockSender(senderEmail: string): Promise<void> {
  if (!senderEmail) return;
  await ensureBlockedSendersTable();
  const pool = getPool();
  try {
    await pool.query(
      `DELETE FROM blocked_senders
       WHERE account_email = $1
         AND lower(sender_email) = lower($2)`,
      [CURRENT_USER, senderEmail.trim()]
    );
  } catch (err) {
    console.error("[DB Error] unblockSender:", err);
  }
}

// ---------------------------------------------------------------------------
// Auto Reply
// ---------------------------------------------------------------------------

async function ensureAutoReplyTables(): Promise<void> {
  if (autoReplyTablesEnsured) return;
  const pool = getPool();
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS auto_reply_settings (
         account_email TEXT        NOT NULL PRIMARY KEY,
         enabled       BOOLEAN     NOT NULL DEFAULT false,
         subject       TEXT        NOT NULL DEFAULT '',
         body_html     TEXT        NOT NULL DEFAULT '',
         body_text     TEXT        NOT NULL DEFAULT '',
         start_date    DATE,
         end_date      DATE,
         updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );
    await pool.query(
      `CREATE TABLE IF NOT EXISTS auto_reply_sent (
         id            BIGSERIAL   PRIMARY KEY,
         account_email TEXT        NOT NULL,
         sender_email  TEXT        NOT NULL,
         sent_at       TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_auto_reply_sent_lookup
       ON auto_reply_sent (account_email, lower(sender_email), sent_at DESC)`
    );
    autoReplyTablesEnsured = true;
  } catch (err) {
    console.error("[DB Error] ensureAutoReplyTables:", err);
  }
}

export interface AutoReplySettings {
  enabled: boolean;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  startDate: string | null;
  endDate: string | null;
}

export function shouldResetAutoReplyDedup(wasEnabled: boolean, nextEnabled: boolean): boolean {
  return !wasEnabled && nextEnabled;
}

export async function getAutoReplySettings(): Promise<AutoReplySettings> {
  await ensureAutoReplyTables();
  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT enabled, subject, body_html, body_text, start_date, end_date
       FROM auto_reply_settings
       WHERE account_email = $1`,
      [CURRENT_USER]
    );
    if (result.rows.length === 0) {
      return { enabled: false, subject: "", bodyHtml: "", bodyText: "", startDate: null, endDate: null };
    }
    const row = result.rows[0];
    return {
      enabled: row.enabled,
      subject: row.subject ?? "",
      bodyHtml: row.body_html ?? "",
      bodyText: row.body_text ?? "",
      startDate: row.start_date ? new Date(row.start_date).toISOString().slice(0, 10) : null,
      endDate: row.end_date ? new Date(row.end_date).toISOString().slice(0, 10) : null,
    };
  } catch (err) {
    console.error("[DB Error] getAutoReplySettings:", err);
    return { enabled: false, subject: "", bodyHtml: "", bodyText: "", startDate: null, endDate: null };
  }
}

export async function saveAutoReplySettings(settings: AutoReplySettings): Promise<void> {
  await ensureAutoReplyTables();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const previous = await client.query<{ enabled: boolean }>(
      `SELECT enabled
         FROM auto_reply_settings
        WHERE account_email = $1
        FOR UPDATE`,
      [CURRENT_USER],
    );
    const wasEnabled = Boolean(previous.rows[0]?.enabled);

    await client.query(
      `INSERT INTO auto_reply_settings
         (account_email, enabled, subject, body_html, body_text, start_date, end_date, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (account_email) DO UPDATE SET
         enabled    = EXCLUDED.enabled,
         subject    = EXCLUDED.subject,
         body_html  = EXCLUDED.body_html,
         body_text  = EXCLUDED.body_text,
         start_date = EXCLUDED.start_date,
         end_date   = EXCLUDED.end_date,
         updated_at = now()`,
      [
        CURRENT_USER,
        settings.enabled,
        settings.subject.trim(),
        settings.bodyHtml,
        settings.bodyText,
        settings.startDate || null,
        settings.endDate || null,
      ]
    );

    // Re-enabling auto-reply should start a fresh sender cycle.
    if (shouldResetAutoReplyDedup(wasEnabled, settings.enabled)) {
      await client.query(
        `DELETE FROM auto_reply_sent WHERE account_email = $1`,
        [CURRENT_USER],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[DB Error] saveAutoReplySettings:", err);
    throw err;
  } finally {
    client.release();
  }
}
