import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type { Config } from './config.js';
import { log } from './logger.js';

type MessageFlagsPayload = {
  folderPath: string;
  uids: number[];
  flags: string[];
  mode: 'add' | 'remove';
};

type MessageMovePayload = {
  folderPath: string;
  targetPath: string;
  uids: number[];
};

type MessageDeletePayload = {
  folderPath: string;
  uids: number[];
};

type AppendMessagePayload = {
  folderPath: string;
  rawMessage: string;
  flags?: string[];
};

type SendAttachmentPayload = {
  filename: string;
  contentType?: string;
  content: string;
  cid?: string;
  contentDisposition?: 'attachment' | 'inline';
};

type SendMessagePayload = {
  from: {
    address: string;
    name?: string;
  };
  to: string;
  subject: string;
  text: string;
  html?: string;
  cc?: string;
  bcc?: string;
  date?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: SendAttachmentPayload[];
};

export interface InternalApiServer {
  close(): Promise<void>;
}

function createImapClient(config: Config): ImapFlow {
  return new ImapFlow({
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
}

async function withImapClient<T>(
  config: Config,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = createImapClient(config);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function ensureMailboxExists(client: ImapFlow, path: string): Promise<void> {
  const mailboxes = await client.list();
  if (!mailboxes.some((mailbox) => mailbox.path === path)) {
    await client.mailboxCreate(path);
  }
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, statusCode: number, message: string): void {
  sendJson(res, statusCode, { error: message });
}

function requireAuthorization(req: IncomingMessage, token: string): boolean {
  const auth = req.headers.authorization;
  return auth === `Bearer ${token}`;
}

async function readJsonBody<T>(req: IncomingMessage, maxBytes = 25 * 1024 * 1024): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error('Request body too large');
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    throw new Error('Missing request body');
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function normalizeUids(uids: unknown): number[] {
  if (!Array.isArray(uids)) return [];
  return uids
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.trunc(value));
}

async function handleMessageFlags(config: Config, payload: MessageFlagsPayload): Promise<void> {
  const uids = normalizeUids(payload.uids);
  if (!payload.folderPath || !uids.length || !Array.isArray(payload.flags) || payload.flags.length === 0) {
    throw new Error('Invalid flag payload');
  }

  await withImapClient(config, async (client) => {
    const lock = await client.getMailboxLock(payload.folderPath);
    try {
      const uidRange = uids.join(',');
      if (payload.mode === 'add') {
        await client.messageFlagsAdd(uidRange, payload.flags, { uid: true });
      } else {
        await client.messageFlagsRemove(uidRange, payload.flags, { uid: true });
      }
    } finally {
      lock.release();
    }
  });
}

async function handleMessageMove(config: Config, payload: MessageMovePayload): Promise<void> {
  const uids = normalizeUids(payload.uids);
  if (!payload.folderPath || !payload.targetPath || !uids.length) {
    throw new Error('Invalid move payload');
  }

  await withImapClient(config, async (client) => {
    await ensureMailboxExists(client, payload.targetPath);
    const lock = await client.getMailboxLock(payload.folderPath);
    try {
      await client.messageMove(uids.join(','), payload.targetPath, { uid: true });
    } finally {
      lock.release();
    }
  });
}

async function handleMessageDelete(config: Config, payload: MessageDeletePayload): Promise<void> {
  const uids = normalizeUids(payload.uids);
  if (!payload.folderPath || !uids.length) {
    throw new Error('Invalid delete payload');
  }

  await withImapClient(config, async (client) => {
    const lock = await client.getMailboxLock(payload.folderPath);
    try {
      await client.messageDelete(uids.join(','), { uid: true });
    } finally {
      lock.release();
    }
  });
}

async function handleAppendMessage(config: Config, payload: AppendMessagePayload): Promise<{ uid: number | null }> {
  if (!payload.folderPath || !payload.rawMessage) {
    throw new Error('Invalid append payload');
  }

  return withImapClient(config, async (client) => {
    await ensureMailboxExists(client, payload.folderPath);
    const result = await client.append(
      payload.folderPath,
      Buffer.from(payload.rawMessage, 'base64'),
      Array.isArray(payload.flags) ? payload.flags : [],
    );
    return { uid: typeof result?.uid === 'number' ? result.uid : null };
  });
}

async function handleSendMessage(config: Config, payload: SendMessagePayload): Promise<void> {
  if (!payload.from?.address || !payload.to || !payload.subject || !payload.text) {
    throw new Error('Invalid send payload');
  }

  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
    tls: { rejectUnauthorized: false },
  });

  const attachments = Array.isArray(payload.attachments)
    ? payload.attachments.map((attachment) => ({
        filename: attachment.filename,
        content: Buffer.from(attachment.content, 'base64'),
        contentType: attachment.contentType,
        ...(attachment.cid ? { cid: attachment.cid } : {}),
        ...(attachment.contentDisposition ? { contentDisposition: attachment.contentDisposition } : {}),
      }))
    : [];

  await transporter.sendMail({
    from: payload.from.name
      ? { name: payload.from.name, address: payload.from.address }
      : payload.from.address,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    ...(payload.html ? { html: payload.html } : {}),
    ...(payload.cc ? { cc: payload.cc } : {}),
    ...(payload.bcc ? { bcc: payload.bcc } : {}),
    ...(payload.date ? { date: new Date(payload.date) } : {}),
    ...(payload.messageId ? { messageId: payload.messageId } : {}),
    ...(payload.inReplyTo ? { inReplyTo: payload.inReplyTo } : {}),
    ...(payload.references?.length ? { references: payload.references.join(' ') } : {}),
    ...(attachments.length ? { attachments } : {}),
  });
}

export function startInternalApiServer(config: Config): InternalApiServer {
  const server = createServer(async (req, res) => {
    if (!requireAuthorization(req, config.api.token)) {
      sendError(res, 401, 'Unauthorized');
      return;
    }

    if (req.method !== 'POST') {
      sendError(res, 405, 'Method not allowed');
      return;
    }

    try {
      switch (req.url) {
        case '/internal/upstream/flags': {
          const payload = await readJsonBody<MessageFlagsPayload>(req);
          await handleMessageFlags(config, payload);
          sendJson(res, 200, { ok: true });
          return;
        }
        case '/internal/upstream/move': {
          const payload = await readJsonBody<MessageMovePayload>(req);
          await handleMessageMove(config, payload);
          sendJson(res, 200, { ok: true });
          return;
        }
        case '/internal/upstream/delete': {
          const payload = await readJsonBody<MessageDeletePayload>(req);
          await handleMessageDelete(config, payload);
          sendJson(res, 200, { ok: true });
          return;
        }
        case '/internal/upstream/append': {
          const payload = await readJsonBody<AppendMessagePayload>(req);
          const result = await handleAppendMessage(config, payload);
          sendJson(res, 200, result);
          return;
        }
        case '/internal/upstream/send': {
          const payload = await readJsonBody<SendMessagePayload>(req);
          await handleSendMessage(config, payload);
          sendJson(res, 200, { ok: true });
          return;
        }
        default:
          sendError(res, 404, 'Not found');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Internal API request failed', { path: req.url ?? '', error: message });
      sendError(res, 400, message);
    }
  });

  server.listen(config.api.port, config.api.host, () => {
    log.info('Internal API listening', {
      host: config.api.host,
      port: config.api.port,
    });
  });

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  };
}
