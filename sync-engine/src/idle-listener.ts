// ---------------------------------------------------------------------------
// IDLE Listener — maintains a persistent IMAP connection for real-time
// notification of new messages and flag changes.
//
// IMAP IDLE keeps a connection open on a single folder. To monitor multiple
// folders, we rotate through them or maintain multiple connections.
// For a personal mailbox, we only IDLE on INBOX (the high-traffic folder)
// and periodically poll other folders.
// ---------------------------------------------------------------------------

import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import type { Config } from './config.js';
import { query, queryOne } from './db.js';
import { log } from './logger.js';
import { parseEmail, storeAttachment } from './parser.js';
import { assignThread, refreshThreadCounts } from './threading.js';

interface AutoReplyInlineAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
  cid: string;
  contentDisposition: 'inline';
}

function parseInlineImageDataUrl(
  dataUrl: string,
): { contentType: string; base64Content: string } | null {
  const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;
  const contentType = match[1].toLowerCase();
  const base64Content = match[2].replace(/\s+/g, '');
  if (!base64Content) return null;
  return { contentType, base64Content };
}

function extensionFromMime(contentType: string): string {
  const subtype = (contentType.split('/')[1] || 'png').split('+')[0].toLowerCase();
  if (subtype === 'jpeg') return 'jpg';
  return subtype || 'png';
}

export function extractInlineDataImageAttachmentsForAutoReply(
  html: string,
  senderAddress: string,
): { html: string; inlineAttachments: AutoReplyInlineAttachment[] } {
  const inlineAttachments: AutoReplyInlineAttachment[] = [];
  const knownDataUrlToCid = new Map<string, string>();
  const senderDomain = senderAddress.split('@')[1] || 'localhost';

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
          content: Buffer.from(parsed.base64Content, 'base64'),
          cid,
          contentDisposition: 'inline',
        });
      }

      return fullTag.replace(`src=${quote}${dataUrl}${quote}`, `src=${quote}cid:${cid}${quote}`);
    },
  );

  return { html: rewrittenHtml, inlineAttachments };
}

export class IdleListener {
  private client: ImapFlow | null = null;
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Poll interval for non-INBOX folders (ms)
  private readonly pollInterval = 60_000; // 1 minute
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: Config,
    private readonly accountId: string,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    await this.connect();
    this.startPolling();
    log.info('IDLE listener started', { accountId: this.accountId });
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        // Ignore logout errors during shutdown
      }
      this.client = null;
    }

    log.info('IDLE listener stopped', { accountId: this.accountId });
  }

  // -------------------------------------------------------------------------
  // Connection management
  // -------------------------------------------------------------------------

  private async connect(): Promise<void> {
    try {
      this.client = new ImapFlow({
        host: this.config.imap.host,
        port: this.config.imap.port,
        secure: this.config.imap.tls,
        auth: {
          user: this.config.imap.user,
          pass: this.config.imap.pass,
        },
        tls: { rejectUnauthorized: false },
        logger: false,
        // Keep IDLE alive — ImapFlow handles IDLE internally
        emitLogs: false,
      });

      this.client.on('error', (err: Error) => {
        log.error('IDLE client error', { error: String(err) });
        this.scheduleReconnect();
      });

      this.client.on('close', () => {
        log.warn('IDLE connection closed');
        this.scheduleReconnect();
      });

      await this.client.connect();
      log.info('IDLE connection established');

      // Start listening on INBOX
      await this.idleOnInbox();
    } catch (err) {
      log.error('Failed to establish IDLE connection', {
        error: String(err),
      });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    if (this.reconnectTimer) return; // Already scheduled

    log.info('Scheduling IDLE reconnect', {
      delayMs: this.config.idleReconnectDelay,
    });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.running) return;

      // Clean up old client
      if (this.client) {
        try {
          await this.client.logout();
        } catch {
          // Ignore
        }
        this.client = null;
      }

      await this.connect();
    }, this.config.idleReconnectDelay);
  }

  // -------------------------------------------------------------------------
  // IDLE loop on INBOX
  // -------------------------------------------------------------------------

  private async idleOnInbox(): Promise<void> {
    if (!this.client || !this.running) return;

    try {
      const lock = await this.client.getMailboxLock('INBOX');

      try {
        // Register event handlers for real-time updates
        this.client.on('exists', async (data: { path: string; count: number; prevCount: number }) => {
          log.info('New message(s) detected via IDLE', {
            folder: data.path,
            newCount: data.count,
            prevCount: data.prevCount,
          });
          await this.handleNewMessages(data.path, data.prevCount, data.count);
        });

        this.client.on('flags', async (data: { path: string; seq: number; uid: number; flags: Set<string> }) => {
          log.debug('Flag change detected via IDLE', {
            folder: data.path,
            uid: data.uid,
            flags: Array.from(data.flags),
          });
          await this.handleFlagChange(data.path, data.uid, data.flags);
        });

        this.client.on('expunge', async (data: { path: string; seq: number }) => {
          log.info('Message expunged via IDLE', {
            folder: data.path,
            seq: data.seq,
          });
          await this.handleExpunge(data.path, data.seq);
        });

        // Enter IDLE — ImapFlow handles the IDLE command and re-issues it
        // every 5 minutes to stay alive. This blocks until the connection
        // drops or we explicitly break.
        // We don't actually call idle() in a loop — ImapFlow maintains IDLE
        // automatically while the lock is held and no commands are running.
        // The events above fire when the server pushes updates during IDLE.

        // Keep the lock held and let events flow
        await new Promise<void>((resolve) => {
          const checkInterval = setInterval(() => {
            if (!this.running) {
              clearInterval(checkInterval);
              resolve();
            }
          }, 1000);

          // Also resolve on client close
          this.client?.on('close', () => {
            clearInterval(checkInterval);
            resolve();
          });
        });
      } finally {
        lock.release();
      }
    } catch (err) {
      log.error('IDLE loop error', { error: String(err) });
      this.scheduleReconnect();
    }
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  private async handleNewMessages(
    folderPath: string,
    prevCount: number,
    newCount: number,
  ): Promise<void> {
    if (!this.client || !this.running) return;

    try {
      const folder = await queryOne<{ id: string }>(
        `SELECT id FROM folders WHERE account_id = $1 AND path = $2`,
        [this.accountId, folderPath],
      );
      if (!folder) return;

      // Fetch only the new messages (prevCount+1 to newCount)
      const range = `${prevCount + 1}:${newCount}`;

      for await (const msg of this.client.fetch(range, {
        source: true,
        flags: true,
        uid: true,
      })) {
        try {
          const parsed = await parseEmail(msg.source as Buffer);
          const flags = Array.from(msg.flags || new Set());

          const threadId = await assignThread(
            this.accountId,
            parsed.messageId,
            parsed.inReplyTo,
            parsed.references,
            parsed.subject,
            parsed.from,
            parsed.date,
            parsed.hasAttachments,
            parsed.snippet,
          );

          const inserted = await queryOne<{ id: string }>(
            `INSERT INTO messages (
               account_id, folder_id, thread_id, uid, message_id,
               in_reply_to, "references", subject, from_address,
               to_addresses, cc_addresses, bcc_addresses, reply_to,
               date, flags, text_body, html_body, snippet, headers,
               has_attachments, size_bytes
             ) VALUES (
               $1, $2, $3, $4, $5,
               $6, $7, $8, $9,
               $10, $11, $12, $13,
               $14, $15, $16, $17, $18, $19,
               $20, $21
             )
             ON CONFLICT (folder_id, uid) DO UPDATE SET
               thread_id = EXCLUDED.thread_id,
               message_id = EXCLUDED.message_id,
               in_reply_to = EXCLUDED.in_reply_to,
               "references" = EXCLUDED."references",
               subject = EXCLUDED.subject,
               from_address = EXCLUDED.from_address,
               to_addresses = EXCLUDED.to_addresses,
               cc_addresses = EXCLUDED.cc_addresses,
               bcc_addresses = EXCLUDED.bcc_addresses,
               reply_to = EXCLUDED.reply_to,
               date = EXCLUDED.date,
               flags = EXCLUDED.flags,
               text_body = EXCLUDED.text_body,
               html_body = EXCLUDED.html_body,
               snippet = EXCLUDED.snippet,
               headers = EXCLUDED.headers,
               has_attachments = EXCLUDED.has_attachments,
               size_bytes = EXCLUDED.size_bytes,
               updated_at = now()
             RETURNING id`,
            [
              this.accountId,
              folder.id,
              threadId,
              msg.uid,
              parsed.messageId,
              parsed.inReplyTo,
              parsed.references,
              parsed.subject,
              JSON.stringify(parsed.from),
              JSON.stringify(parsed.to),
              JSON.stringify(parsed.cc),
              JSON.stringify(parsed.bcc),
              JSON.stringify(parsed.replyTo),
              parsed.date,
              flags,
              parsed.textBody,
              parsed.htmlBody,
              parsed.snippet,
              JSON.stringify(parsed.headers),
              parsed.hasAttachments,
              (msg.source as Buffer).byteLength,
            ],
          );

          if (inserted) {
            // Store attachments
            for (const att of parsed.attachments) {
              const storagePath = await storeAttachment(
                this.config.attachmentDir,
                this.accountId,
                inserted.id,
                att,
              );
              await query(
                `INSERT INTO attachments (
                   message_id, filename, content_type, size_bytes,
                   content_id, content_disposition, storage_path, checksum
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                  inserted.id,
                  att.filename,
                  att.contentType,
                  att.size,
                  att.contentId,
                  att.disposition,
                  storagePath,
                  att.checksum,
                ],
              );
            }

            log.info('New message synced via IDLE', {
              uid: msg.uid,
              subject: parsed.subject,
            });

            // Send auto-reply if configured and active (INBOX only)
            if (folderPath.toUpperCase() === 'INBOX') {
              await this.maybeSendAutoReply(parsed);
            }

            // Notify webmail of new message via PostgreSQL LISTEN/NOTIFY
            const fromName = typeof parsed.from === 'object' && parsed.from !== null
              ? (parsed.from as any).name || (parsed.from as any).address || 'Unknown'
              : String(parsed.from || 'Unknown');
            const fromAddress = typeof parsed.from === 'object' && parsed.from !== null
              ? String((parsed.from as any).address || '')
              : '';
            await query(
              `SELECT pg_notify('mail_events', $1)`,
              [JSON.stringify({
                type: 'new_message',
                folder: folderPath,
                uid: msg.uid,
                subject: parsed.subject || '(No Subject)',
                from: fromName,
                fromAddress,
              })],
            );
          }
        } catch (err) {
          log.error('Failed to process IDLE message', {
            uid: msg.uid,
            error: String(err),
          });
        }
      }

      // Update folder counts
      await query(
        `UPDATE folders SET
           total_messages = (SELECT count(*) FROM messages WHERE folder_id = $1),
           unread_count   = (SELECT count(*) FROM messages WHERE folder_id = $1 AND NOT ('\\Seen' = ANY(flags))),
           updated_at     = now()
         WHERE id = $1`,
        [folder.id],
      );
    } catch (err) {
      log.error('handleNewMessages failed', { error: String(err) });
    }
  }

  private async handleFlagChange(
    folderPath: string,
    uid: number,
    flags: Set<string>,
  ): Promise<void> {
    try {
      const folder = await queryOne<{ id: string }>(
        `SELECT id FROM folders WHERE account_id = $1 AND path = $2`,
        [this.accountId, folderPath],
      );
      if (!folder) return;

      const flagsArray = Array.from(flags);

      const updated = await queryOne<{ thread_id: string | null }>(
        `UPDATE messages SET flags = $3, updated_at = now()
         WHERE folder_id = $1 AND uid = $2
         RETURNING thread_id`,
        [folder.id, uid, flagsArray],
      );

      if (updated?.thread_id) {
        await refreshThreadCounts(updated.thread_id);
      }

      // Update folder unread count
      await query(
        `UPDATE folders SET
           unread_count = (SELECT count(*) FROM messages WHERE folder_id = $1 AND NOT ('\\Seen' = ANY(flags))),
           updated_at   = now()
         WHERE id = $1`,
        [folder.id],
      );

      log.debug('Flags updated', { folder: folderPath, uid, flags: flagsArray });

      // Notify webmail of flag change
      await query(
        `SELECT pg_notify('mail_events', $1)`,
        [JSON.stringify({ type: 'flags_changed', folder: folderPath, uid })],
      );
    } catch (err) {
      log.error('handleFlagChange failed', { error: String(err) });
    }
  }

  private async handleExpunge(folderPath: string, seq: number): Promise<void> {
    try {
      const folder = await queryOne<{ id: string }>(
        `SELECT id FROM folders WHERE account_id = $1 AND path = $2`,
        [this.accountId, folderPath],
      );
      if (!folder) return;

      // Note: EXPUNGE gives us a sequence number, not UID. We can't reliably
      // map this to a UID without a local sequence-to-UID mapping. The safest
      // approach is to mark the folder as stale and re-sync it on next poll.
      await query(
        `UPDATE folders SET sync_state = 'stale', updated_at = now()
         WHERE id = $1`,
        [folder.id],
      );

      log.info('Folder marked stale due to EXPUNGE', { folder: folderPath });

      // Notify webmail of expunge
      await query(
        `SELECT pg_notify('mail_events', $1)`,
        [JSON.stringify({ type: 'expunge', folder: folderPath })],
      );
    } catch (err) {
      log.error('handleExpunge failed', { error: String(err) });
    }
  }

  // -------------------------------------------------------------------------
  // Periodic polling for non-INBOX folders
  // -------------------------------------------------------------------------

  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      if (!this.running) return;
      await this.pollStaleFolders();
    }, this.pollInterval);
  }

  private async pollStaleFolders(): Promise<void> {
    try {
      const { rows: staleFolders } = await query<{ id: string; path: string }>(
        `SELECT id, path FROM folders
         WHERE account_id = $1 AND (sync_state = 'stale' OR path != 'INBOX')
         ORDER BY
           CASE WHEN sync_state = 'stale' THEN 0 ELSE 1 END,
           last_sync_at ASC NULLS FIRST
         LIMIT 3`,
        [this.accountId],
      );

      if (staleFolders.length === 0) return;

      // Create a separate client for polling (IDLE client is busy on INBOX)
      const pollClient = new ImapFlow({
        host: this.config.imap.host,
        port: this.config.imap.port,
        secure: this.config.imap.tls,
        auth: {
          user: this.config.imap.user,
          pass: this.config.imap.pass,
        },
        tls: { rejectUnauthorized: false },
        logger: false,
      });

      try {
        await pollClient.connect();

        for (const folder of staleFolders) {
          try {
            await this.quickSyncFolder(pollClient, folder.id, folder.path);
          } catch (err) {
            log.error('Quick sync failed for folder', {
              folder: folder.path,
              error: String(err),
            });
          }
        }
      } finally {
        await pollClient.logout();
      }
    } catch (err) {
      log.error('pollStaleFolders failed', { error: String(err) });
    }
  }

  // -------------------------------------------------------------------------
  // Auto-reply
  // -------------------------------------------------------------------------

  private async maybeSendAutoReply(parsed: Awaited<ReturnType<typeof parseEmail>>): Promise<void> {
    try {
      const settings = await queryOne<{
        enabled: boolean;
        subject: string;
        body_html: string;
        body_text: string;
        start_date: string | null;
        end_date: string | null;
      }>(
        `SELECT enabled, subject, body_html, body_text, start_date, end_date
         FROM auto_reply_settings
         WHERE account_email = $1`,
        [this.config.account.email],
      );

      if (!settings?.enabled) return;

      // Check date range
      const now = new Date();
      if (settings.start_date) {
        const start = new Date(settings.start_date);
        start.setHours(0, 0, 0, 0);
        if (now < start) return;
      }
      if (settings.end_date) {
        const end = new Date(settings.end_date);
        end.setHours(23, 59, 59, 999);
        if (now > end) return;
      }

      const from = parsed.from as { name?: string; address?: string } | null;
      const fromAddress = from?.address?.trim() ?? '';
      if (!fromAddress) return;

      // Don't reply to self
      if (fromAddress.toLowerCase() === this.config.account.email.toLowerCase()) return;

      // Don't reply to auto-replies (RFC 3834 / common headers)
      const headers = parsed.headers as Record<string, string | string[]>;
      const autoSubmitted = String(headers['auto-submitted'] ?? '').toLowerCase();
      if (autoSubmitted && autoSubmitted !== 'no') return;
      const xAutoReply = String(headers['x-auto-reply-notice'] ?? '').toLowerCase();
      if (xAutoReply) return;

      // Skip bulk/list/junk precedence
      const precedence = String(headers['precedence'] ?? '').toLowerCase();
      if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') return;

      // Skip mailing list messages
      if (headers['list-id'] || headers['list-unsubscribe']) return;

      // Check if already replied to this sender within the current auto-reply period
      const dedupStart = settings.start_date ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const recent = await queryOne<{ id: number }>(
        `SELECT id FROM auto_reply_sent
         WHERE account_email = $1
           AND lower(sender_email) = lower($2)
           AND sent_at >= $3::date`,
        [this.config.account.email, fromAddress, dedupStart],
      );
      if (recent) return;

      // Send the auto-reply
      const transporter = nodemailer.createTransport({
        host: this.config.smtp.host,
        port: this.config.smtp.port,
        secure: this.config.smtp.secure,
        auth: { user: this.config.smtp.user, pass: this.config.smtp.pass },
        tls: { rejectUnauthorized: false },
      });

      const originalSubject = typeof parsed.subject === 'string' ? parsed.subject : '';
      const replySubject = settings.subject.trim() || `Auto-Reply: ${originalSubject}`;

      const originalMessageId = typeof parsed.messageId === 'string' ? parsed.messageId : undefined;
      const bodyHtml = settings.body_html || '';
      const { html: normalizedBodyHtml, inlineAttachments } = bodyHtml.trim()
        ? extractInlineDataImageAttachmentsForAutoReply(bodyHtml, this.config.account.email)
        : { html: bodyHtml, inlineAttachments: [] as AutoReplyInlineAttachment[] };
      const bodyText = settings.body_text || normalizedBodyHtml.replace(/<[^>]+>/g, '') || '';

      await transporter.sendMail({
        from: this.config.account.email,
        to: fromAddress,
        subject: replySubject,
        text: bodyText,
        html: normalizedBodyHtml || undefined,
        ...(inlineAttachments.length ? { attachments: inlineAttachments } : {}),
        ...(originalMessageId ? { inReplyTo: originalMessageId, references: originalMessageId } : {}),
        headers: {
          'Auto-Submitted': 'auto-replied',
          'X-Auto-Response-Suppress': 'All',
        },
      });

      // Record sent auto-reply to avoid duplicates
      await query(
        `INSERT INTO auto_reply_sent (account_email, sender_email) VALUES ($1, lower($2))`,
        [this.config.account.email, fromAddress],
      );

      log.info('Auto-reply sent', { to: fromAddress, subject: replySubject });
    } catch (err) {
      log.error('Failed to send auto-reply', { error: String(err) });
    }
  }

  /**
   * Quick sync: check for new messages since last uid_next and update flags
   * for recently changed messages. Lighter than a full backfill.
   */
  private async quickSyncFolder(
    client: ImapFlow,
    folderId: string,
    folderPath: string,
  ): Promise<void> {
    const lock = await client.getMailboxLock(folderPath);

    try {
      const mailbox = client.mailbox;
      if (!mailbox) return;
      const mailboxUidValidity = Number(mailbox.uidValidity);
      const mailboxUidNext = Number(mailbox.uidNext ?? 0);

      const folder = await queryOne<{
        uid_validity: number | null;
        uid_next: number | null;
      }>(
        `SELECT uid_validity, uid_next FROM folders WHERE id = $1`,
        [folderId],
      );

      if (!folder) return;

      // Check UIDVALIDITY
      if (
        folder.uid_validity !== null &&
        folder.uid_validity !== mailboxUidValidity
      ) {
        // UIDVALIDITY changed — mark for full resync
        await query(
          `UPDATE folders SET sync_state = 'pending', uid_validity = $2, updated_at = now()
           WHERE id = $1`,
          [folderId, mailboxUidValidity],
        );
        log.warn('UIDVALIDITY changed during quick sync', {
          folder: folderPath,
        });
        return;
      }

      // Fetch new messages since last uid_next
      // folders.uid_next is the next UID, so last synced UID is uid_next - 1.
      const lastUid = Math.max((folder.uid_next ?? 1) - 1, 0);
      if (mailboxUidNext > lastUid + 1) {
        const range = `${lastUid + 1}:*`;
        for await (const msg of client.fetch(range, {
          source: true,
          flags: true,
          uid: true,
        })) {
          if (msg.uid <= lastUid) continue;

          try {
            const parsed = await parseEmail(msg.source as Buffer);
            const flags = Array.from(msg.flags || new Set());

            const threadId = await assignThread(
              this.accountId,
              parsed.messageId,
              parsed.inReplyTo,
              parsed.references,
              parsed.subject,
              parsed.from,
              parsed.date,
              parsed.hasAttachments,
              parsed.snippet,
            );

            await query(
              `INSERT INTO messages (
                 account_id, folder_id, thread_id, uid, message_id,
                 in_reply_to, "references", subject, from_address,
                 to_addresses, cc_addresses, bcc_addresses, reply_to,
                 date, flags, text_body, html_body, snippet, headers,
                 has_attachments, size_bytes
               ) VALUES (
                 $1, $2, $3, $4, $5,
                 $6, $7, $8, $9,
                 $10, $11, $12, $13,
                 $14, $15, $16, $17, $18, $19,
                 $20, $21
               )
               ON CONFLICT (folder_id, uid) DO UPDATE SET
                 thread_id = EXCLUDED.thread_id,
                 message_id = EXCLUDED.message_id,
                 in_reply_to = EXCLUDED.in_reply_to,
                 "references" = EXCLUDED."references",
                 subject = EXCLUDED.subject,
                 from_address = EXCLUDED.from_address,
                 to_addresses = EXCLUDED.to_addresses,
                 cc_addresses = EXCLUDED.cc_addresses,
                 bcc_addresses = EXCLUDED.bcc_addresses,
                 reply_to = EXCLUDED.reply_to,
                 date = EXCLUDED.date,
                 flags = EXCLUDED.flags,
                 text_body = EXCLUDED.text_body,
                 html_body = EXCLUDED.html_body,
                 snippet = EXCLUDED.snippet,
                 headers = EXCLUDED.headers,
                 has_attachments = EXCLUDED.has_attachments,
                 size_bytes = EXCLUDED.size_bytes,
                 updated_at = now()`,
              [
                this.accountId,
                folderId,
                threadId,
                msg.uid,
                parsed.messageId,
                parsed.inReplyTo,
                parsed.references,
                parsed.subject,
                JSON.stringify(parsed.from),
                JSON.stringify(parsed.to),
                JSON.stringify(parsed.cc),
                JSON.stringify(parsed.bcc),
                JSON.stringify(parsed.replyTo),
                parsed.date,
                flags,
                parsed.textBody,
                parsed.htmlBody,
                parsed.snippet,
                JSON.stringify(parsed.headers),
                parsed.hasAttachments,
                (msg.source as Buffer).byteLength,
              ],
            );
          } catch (err) {
            log.error('Failed to process message in quick sync', {
              uid: msg.uid,
              error: String(err),
            });
          }
        }
      }

      // Update folder state
      await query(
        `UPDATE folders SET
           uid_validity   = $2,
           uid_next       = $3,
           total_messages = $4,
           sync_state     = 'synced',
           last_sync_at   = now(),
           updated_at     = now()
         WHERE id = $1`,
        [folderId, mailboxUidValidity, mailboxUidNext, mailbox.exists],
      );

      // Update unread count
      await query(
        `UPDATE folders SET
           unread_count = (SELECT count(*) FROM messages WHERE folder_id = $1 AND NOT ('\\Seen' = ANY(flags))),
           updated_at   = now()
         WHERE id = $1`,
        [folderId],
      );

      // Notify webmail that folder was synced
      await query(
        `SELECT pg_notify('mail_events', $1)`,
        [JSON.stringify({ type: 'folder_synced', folder: folderPath })],
      );
    } finally {
      lock.release();
    }
  }
}
