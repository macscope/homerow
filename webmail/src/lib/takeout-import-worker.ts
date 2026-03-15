"use server";

import fs from "node:fs";
import path from "node:path";
import { appendFile, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import tar from "tar-stream";
import PostalMime from "postal-mime";
import { getPool } from "~/lib/db";
import { upstreamAppendMessage } from "~/lib/sync-engine-client";
import { parseTakeoutBlockedAddressesJson } from "~/lib/takeout-blocked-addresses";
import {
  beginTakeoutImportEstimation,
  cancelTakeoutImportJob,
  claimNextQueuedTakeoutImportJob,
  clearTakeoutImportEstimationState,
  completeTakeoutImportJob,
  failTakeoutImportJob,
  getTakeoutImportJob,
  requeueStaleRunningTakeoutImportJobs,
  setTakeoutImportEstimatedTotalMessages,
  updateTakeoutImportEstimationProgress,
  updateTakeoutImportProgress,
} from "~/lib/takeout-import-jobs";

let workerRunning = false;
let activeJobId: string | null = null;
const cancelRequested = new Set<string>();

interface LabelMapping {
  folder: string | null;
  flag?: string;
}

const LABEL_MAP: Record<string, LabelMapping> = {
  inbox: { folder: "INBOX" },
  "\\inbox": { folder: "INBOX" },
  sent: { folder: "Sent" },
  "sent mail": { folder: "Sent" },
  "\\sent": { folder: "Sent" },
  drafts: { folder: "Drafts" },
  draft: { folder: "Drafts" },
  "\\draft": { folder: "Drafts" },
  "\\drafts": { folder: "Drafts" },
  spam: { folder: "Junk" },
  junk: { folder: "Junk" },
  "\\junk": { folder: "Junk" },
  trash: { folder: "Trash" },
  bin: { folder: "Trash" },
  "\\trash": { folder: "Trash" },
  archived: { folder: "Archive" },
  "all mail": { folder: "Archive" },
  "\\all": { folder: "Archive" },
  "\\allmail": { folder: "Archive" },
  "\\archive": { folder: "Archive" },
  starred: { folder: null, flag: "\\Flagged" },
  "\\starred": { folder: null, flag: "\\Flagged" },
  important: { folder: null, flag: "Important" },
  "\\important": { folder: null, flag: "Important" },
  unread: { folder: null },
  opened: { folder: null },
  chat: { folder: null },
};

export interface TakeoutAnalyzedSignature {
  title: string;
  text: string;
}

export interface TakeoutArchiveAnalysis {
  estimatedTotalMessages: number;
  customLabels: Array<{ name: string; count: number }>;
  systemLabels: {
    sent: number;
    spam: number;
    trash: number;
    drafts: number;
    inbox: number;
    archive: number;
  };
  signatures: TakeoutAnalyzedSignature[];
  blockedSenders: string[];
}

interface ImportCustomLabelMapping {
  sourceName: string;
  targetName: string;
  enabled?: boolean;
}

interface ImportLabelPreferences {
  importCustomLabels: boolean;
  includeSent: boolean;
  includeSpam: boolean;
  includeTrash: boolean;
  customLabelMap: Map<string, string>;
  disabledCustomLabels: Set<string>;
}

interface ImportProgress {
  processed: number;
  imported: number;
  dbImported: number;
  imapSynced: number;
  skipped: number;
  errors: number;
}

interface ImportResult extends ImportProgress {
  cancelled: boolean;
}

interface Checkpoint {
  totalImported: number;
  lastImportedAt: string;
}

interface ParsedStageContent {
  htmlBody: string | null;
  textBody: string | null;
  snippet: string | null;
  hasAttachments: boolean;
}

async function emitFolderSyncedEvent(folderPath: string): Promise<void> {
  const normalized = folderPath?.trim();
  if (!normalized) return;
  const pool = getPool();
  try {
    await pool.query(
      `SELECT pg_notify('mail_events', $1)`,
      [JSON.stringify({ type: "folder_synced", folder: normalized })],
    );
  } catch {
    // Best-effort SSE signal only.
  }
}

function loadConfigEnv(): Record<string, string> {
  const configPath = path.resolve(process.cwd(), "config.env");
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const match = line.match(/^(\w+)="?([^"]*)"?$/);
      if (match) vars[match[1]] = match[2];
    }
    return vars;
  } catch {
    return {};
  }
}

function mapLabel(label: string, preferences?: ImportLabelPreferences): LabelMapping {
  const lower = label.toLowerCase().trim();
  const normalized = lower.replace(/^\\+/, "");
  if (LABEL_MAP[lower]) return LABEL_MAP[lower];
  if (LABEL_MAP[normalized]) return LABEL_MAP[normalized];
  if (preferences && !preferences.importCustomLabels) return { folder: null };
  if (preferences?.disabledCustomLabels.has(lower)) return { folder: null };
  const mapped = preferences?.customLabelMap.get(lower);
  const target = (mapped || label).trim();
  // Keep custom labels both as a folder target and as a message flag so
  // local UI label chips/filtering works immediately from PostgreSQL.
  return { folder: target ? `Labels/${target}` : null, flag: target || undefined };
}

function isCustomGmailLabel(label: string): boolean {
  const lower = label.toLowerCase().trim();
  if (!lower) return false;
  if (LABEL_MAP[lower]) return false;
  return true;
}

function parseGmailLabels(raw: string): string[] {
  const labels: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      if (current.trim()) labels.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }

  if (current.trim()) labels.push(current.trim());
  return labels;
}

function resolveLabels(labels: string[], preferences?: ImportLabelPreferences): { folder: string | null; flags: string[] } {
  const flags: string[] = ["\\Seen"];
  let folder: string | null = null;
  const normalized = new Set(labels.map((label) => label.toLowerCase().trim()));

  if (preferences) {
    if (!preferences.includeSpam && (normalized.has("spam") || normalized.has("junk"))) {
      return { folder: null, flags };
    }
    if (!preferences.includeTrash && (normalized.has("trash") || normalized.has("bin"))) {
      return { folder: null, flags };
    }
    if (!preferences.includeSent && (normalized.has("sent") || normalized.has("sent mail"))) {
      return { folder: null, flags };
    }
  }

  for (const label of labels) {
    const mapping = mapLabel(label, preferences);

    if (label.toLowerCase().trim() === "unread") {
      const seenIdx = flags.indexOf("\\Seen");
      if (seenIdx !== -1) flags.splice(seenIdx, 1);
      continue;
    }

    if (mapping.flag && !flags.includes(mapping.flag)) flags.push(mapping.flag);
    if (!folder && mapping.folder) folder = mapping.folder;
  }

  return { folder: folder || "Archive", flags };
}

function normalizeHeaderLines(raw: Buffer, maxBytes = 16384): string[] {
  const headerSection = raw.subarray(0, maxBytes).toString("utf-8");
  const headerOnly = headerSection.split(/\r?\n\r?\n/, 1)[0] || "";
  return headerOnly.split(/\r?\n/);
}

function extractHeaderValue(raw: Buffer, name: string, maxBytes = 16384): string | null {
  const target = `${name.toLowerCase()}:`;
  const lines = normalizeHeaderLines(raw, maxBytes);
  let collecting = false;
  let value = "";

  for (const line of lines) {
    if (!collecting) {
      if (line.toLowerCase().startsWith(target)) {
        value = line.slice(line.indexOf(":") + 1).trim();
        collecting = true;
      }
      continue;
    }

    if (/^[ \t]/.test(line)) {
      value += ` ${line.trim()}`;
      continue;
    }
    break;
  }

  return collecting ? value.trim() : null;
}

function decodeRfc2047Words(value: string): string {
  if (!value.includes("=?")) return value;

  const decodeQ = (input: string): Buffer => {
    const bytes: number[] = [];
    const normalized = input.replace(/_/g, " ");
    for (let i = 0; i < normalized.length; i += 1) {
      const ch = normalized[i];
      if (ch === "=" && i + 2 < normalized.length) {
        const hex = normalized.slice(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(Number.parseInt(hex, 16));
          i += 2;
          continue;
        }
      }
      bytes.push(ch.charCodeAt(0));
    }
    return Buffer.from(bytes);
  };

  const decodeWithCharset = (buf: Buffer, charset: string): string => {
    const c = charset.trim().toLowerCase();
    if (c === "utf-8" || c === "utf8") return buf.toString("utf8");
    if (c === "iso-8859-1" || c === "latin1" || c === "windows-1252") return buf.toString("latin1");
    try {
      return buf.toString("utf8");
    } catch {
      return buf.toString("latin1");
    }
  };

  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_match, charset: string, enc: string, payload: string) => {
    try {
      const bytes = enc.toUpperCase() === "B" ? Buffer.from(payload, "base64") : decodeQ(payload);
      return decodeWithCharset(bytes, charset);
    } catch {
      return _match;
    }
  });
}

function extractMessageId(raw: Buffer): string | null {
  return extractHeaderValue(raw, "Message-ID", 16384);
}

function extractGmailLabels(raw: Buffer): string[] {
  const value = extractHeaderValue(raw, "X-Gmail-Labels", 16384);
  if (!value) return [];
  return parseGmailLabels(value);
}

function parseTakeoutSignaturesJson(content: string): TakeoutAnalyzedSignature[] {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const fromMultiple = Array.isArray(parsed.multipleSignatureEntry) ? parsed.multipleSignatureEntry : [];
    const fromSignature = Array.isArray(parsed.signature) ? parsed.signature : [];
    const merged = [...fromMultiple, ...fromSignature];
    const signatures: TakeoutAnalyzedSignature[] = [];
    for (const entry of merged) {
      if (!entry || typeof entry !== "object") continue;
      const value = entry as Record<string, unknown>;
      const text = typeof value.text === "string" ? value.text.trim() : "";
      if (!text) continue;
      const title = typeof value.title === "string" && value.title.trim()
        ? value.title.trim()
        : "Imported Signature";
      signatures.push({ title, text });
    }
    return signatures;
  } catch {
    return [];
  }
}

export async function analyzeTakeoutArchive(options: {
  tgzPath: string;
  onProgress?: (bytesRead: number, totalBytes: number) => void;
}): Promise<TakeoutArchiveAnalysis> {
  if (!fs.existsSync(options.tgzPath)) {
    throw new Error(`Takeout file not found: ${options.tgzPath}`);
  }

  const totalBytes = fs.statSync(options.tgzPath).size;
  const customLabelCounts = new Map<string, number>();
  let estimatedTotalMessages = 0;
  const systemLabels = {
    sent: 0,
    spam: 0,
    trash: 0,
    drafts: 0,
    inbox: 0,
    archive: 0,
  };
  let signatures: TakeoutAnalyzedSignature[] = [];
  const blockedSenderSet = new Set<string>();

  await new Promise<void>((resolve, reject) => {
    const extract = tar.extract();
    const gunzip = createGunzip();
    const source = fs.createReadStream(options.tgzPath);
    let bytesRead = 0;
    let settled = false;

    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };

    source.on("data", (chunk: Buffer) => {
      bytesRead += chunk.length;
      if (options.onProgress) options.onProgress(Math.min(bytesRead, totalBytes), totalBytes);
    });

    source.on("error", (error) => done(error instanceof Error ? error : new Error("Could not read archive.")));
    gunzip.on("error", (error) => done(error instanceof Error ? error : new Error("Could not unzip archive.")));
    extract.on("error", (error) => done(error instanceof Error ? error : new Error("Could not extract archive.")));

    extract.on("entry", (header, stream, next) => {
      const entryName = (header.name || "").toLowerCase();

      if (entryName.endsWith(".mbox")) {
        void (async () => {
          try {
            for await (const rawMessage of parseMbox(stream as Readable)) {
              estimatedTotalMessages += 1;
              const labels = extractGmailLabels(rawMessage);
              let classifiedAsArchive = true;
              for (const label of labels) {
                const trimmed = label.trim();
                if (!trimmed) continue;
                const lower = trimmed.toLowerCase();
                if (lower === "sent" || lower === "sent mail") {
                  systemLabels.sent += 1;
                  classifiedAsArchive = false;
                } else if (lower === "spam" || lower === "junk") {
                  systemLabels.spam += 1;
                  classifiedAsArchive = false;
                } else if (lower === "trash" || lower === "bin") {
                  systemLabels.trash += 1;
                  classifiedAsArchive = false;
                } else if (lower === "drafts" || lower === "draft") {
                  systemLabels.drafts += 1;
                  classifiedAsArchive = false;
                } else if (lower === "inbox") {
                  systemLabels.inbox += 1;
                  classifiedAsArchive = false;
                }
                if (isCustomGmailLabel(trimmed)) {
                  customLabelCounts.set(trimmed, (customLabelCounts.get(trimmed) ?? 0) + 1);
                }
              }
              if (classifiedAsArchive) {
                systemLabels.archive += 1;
              }
            }
            next();
          } catch (error) {
            done(error instanceof Error ? error : new Error("Could not parse .mbox messages."));
          }
        })();
        return;
      }

      if (entryName.endsWith("/user settings/signatures.json") || entryName.endsWith("signatures.json")) {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("error", (error) => done(error instanceof Error ? error : new Error("Could not read signatures.")));
        stream.on("end", () => {
          const parsed = parseTakeoutSignaturesJson(Buffer.concat(chunks).toString("utf-8"));
          if (parsed.length > 0) signatures = parsed;
          next();
        });
        return;
      }

      if (entryName.endsWith("/blocked addresses.json") || entryName.endsWith("blocked addresses.json")) {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("error", (error) => done(error instanceof Error ? error : new Error("Could not read blocked addresses.")));
        stream.on("end", () => {
          const parsed = parseTakeoutBlockedAddressesJson(Buffer.concat(chunks).toString("utf-8"));
          for (const address of parsed) blockedSenderSet.add(address);
          next();
        });
        return;
      }

      stream.on("end", next);
      stream.resume();
    });

    extract.on("finish", () => done());
    source.pipe(gunzip).pipe(extract);
  });

  return {
    estimatedTotalMessages: Math.max(1, estimatedTotalMessages),
    customLabels: Array.from(customLabelCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    systemLabels,
    signatures,
    blockedSenders: Array.from(blockedSenderSet).sort((a, b) => a.localeCompare(b)),
  };
}

async function* parseMbox(stream: Readable): AsyncGenerator<Buffer> {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let messageLines: string[] = [];

  for await (const line of rl) {
    if (line.startsWith("From ") && messageLines.length > 0) {
      yield Buffer.from(messageLines.join("\r\n"));
      messageLines = [];
    } else if (line.startsWith(">From ")) {
      messageLines.push(line.slice(1));
    } else {
      messageLines.push(line);
    }
  }

  if (messageLines.length > 0) yield Buffer.from(messageLines.join("\r\n"));
}

function extractMboxFromTgz(
  archivePath: string,
  onCompressedProgress?: (bytesRead: number) => void,
): Promise<Readable> {
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    const gunzip = createGunzip();
    let resolved = false;
    let bytesRead = 0;
    const source = fs.createReadStream(archivePath);

    source.on("data", (chunk: Buffer) => {
      bytesRead += chunk.length;
      if (onCompressedProgress) onCompressedProgress(bytesRead);
    });

    extract.on("entry", (header, stream, next) => {
      if (header.name.endsWith(".mbox") && !resolved) {
        resolved = true;
        resolve(stream);
      } else {
        stream.on("end", next);
        stream.resume();
      }
    });

    extract.on("finish", () => {
      if (!resolved) reject(new Error("No .mbox file found in archive"));
    });

    extract.on("error", reject);
    gunzip.on("error", reject);

    source.pipe(gunzip).pipe(extract);
  });
}

async function estimateTotalMessagesInTakeout(
  tgzPath: string,
  onProgress?: (bytesRead: number, totalBytes: number) => void,
): Promise<number> {
  const totalBytes = fs.statSync(tgzPath).size;
  const mboxStream = await extractMboxFromTgz(tgzPath, (bytesRead) => {
    if (onProgress) onProgress(bytesRead, totalBytes);
  });
  const rl = createInterface({ input: mboxStream, crlfDelay: Infinity });
  let total = 0;
  for await (const line of rl) {
    if (line.startsWith("From ")) total += 1;
  }
  return Math.max(1, total);
}

function checkpointBaseName(tgzPath: string): string {
  const file = path.basename(tgzPath);
  if (file.endsWith(".tar.gz")) return file.slice(0, -".tar.gz".length);
  if (file.endsWith(".tgz")) return file.slice(0, -".tgz".length);
  return file;
}

function checkpointMetaPathForArchive(tgzPath: string): string {
  return path.join(path.dirname(tgzPath), `.import-checkpoint-${checkpointBaseName(tgzPath)}.json`);
}

function checkpointIdsPathForArchive(tgzPath: string): string {
  return path.join(path.dirname(tgzPath), `.import-checkpoint-${checkpointBaseName(tgzPath)}.ids`);
}

function loadCheckpoint(tgzPath: string): Set<string> {
  const imported = new Set<string>();

  try {
    const content = fs.readFileSync(checkpointIdsPathForArchive(tgzPath), "utf-8");
    for (const line of content.split("\n")) {
      const id = line.trim();
      if (id) imported.add(id);
    }
  } catch {
    // Ignore missing or unreadable checkpoint file.
  }

  return imported;
}

async function appendCheckpointIds(tgzPath: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await appendFile(checkpointIdsPathForArchive(tgzPath), `${ids.join("\n")}\n`);
}

function saveCheckpointMeta(tgzPath: string, imported: Set<string>): void {
  const checkpoint: Checkpoint = {
    totalImported: imported.size,
    lastImportedAt: new Date().toISOString(),
  };
  fs.writeFileSync(checkpointMetaPathForArchive(tgzPath), JSON.stringify(checkpoint));
}

interface TakeoutMailboxConfig {
  accountEmail: string;
  host: string;
  port: number;
  smtpHost: string;
  smtpPort: number;
  imapUser: string;
  pass: string;
  tls: boolean;
}

function getMailboxConfig(): TakeoutMailboxConfig {
  const config = loadConfigEnv();
  const host = process.env.IMAP_HOST || "127.0.0.1";
  const port = Number.parseInt(process.env.IMAP_PORT || "3143", 10);
  const smtpHost = process.env.SMTP_HOST || host;
  const smtpPort = Number.parseInt(process.env.SMTP_PORT || "587", 10);
  const accountEmail =
    process.env.USER_EMAIL ||
    process.env.ADMIN_EMAIL ||
    config.EMAIL ||
    process.env.IMAP_USER ||
    "";
  const imapUser = process.env.IMAP_USER || accountEmail;
  const pass = process.env.IMAP_PASS || config.MAIL_PASSWORD || "";
  const tls = process.env.IMAP_TLS === "true";

  if (!accountEmail || !imapUser || !pass) {
    throw new Error("Missing mailbox credentials for takeout import.");
  }
  return { accountEmail, host, port, smtpHost, smtpPort, imapUser, pass, tls };
}

function guessSpecialUse(pathValue: string): string | null {
  const lower = pathValue.trim().toLowerCase();
  if (lower === "inbox") return "\\Inbox";
  if (lower === "sent") return "\\Sent";
  if (lower === "drafts") return "\\Drafts";
  if (lower === "trash") return "\\Trash";
  if (lower === "junk" || lower === "spam") return "\\Junk";
  if (lower === "archive") return "\\Archive";
  return null;
}

function folderDisplayName(pathValue: string): string {
  const parts = pathValue.split("/");
  return parts[parts.length - 1] || pathValue;
}

function extractSubject(raw: Buffer): string {
  const rawSubject = extractHeaderValue(raw, "Subject", 16384);
  if (!rawSubject) return "(No Subject)";
  return decodeRfc2047Words(rawSubject).replace(/\s{2,}/g, " ").trim() || "(No Subject)";
}

function extractDateIso(raw: Buffer): string {
  const rawDate = extractHeaderValue(raw, "Date", 16384);
  if (!rawDate) return new Date().toISOString();
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}

function extractFromAddress(raw: Buffer): { name: string; address: string } {
  const fromValue = extractHeaderValue(raw, "From", 16384) || "";
  const angle = fromValue.match(/^(.*)<([^>]+)>/);
  if (angle) {
    const decodedName = decodeRfc2047Words(angle[1]).replace(/^"+|"+$/g, "").trim();
    const name = decodedName || angle[2].trim();
    return { name, address: angle[2].trim() };
  }
  const emailMatch = fromValue.match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i);
  if (emailMatch) {
    const decoded = decodeRfc2047Words(fromValue).trim();
    return { name: decoded || emailMatch[0], address: emailMatch[0] };
  }
  return { name: "Unknown", address: "" };
}

function extractAddressListHeader(raw: Buffer, name: string): Array<{ address: string; name?: string }> {
  const value = extractHeaderValue(raw, name, 16384);
  if (!value) return [];
  const decoded = decodeRfc2047Words(value);
  const tokens = decoded.split(",").map((part) => part.trim()).filter(Boolean);
  const out: Array<{ address: string; name?: string }> = [];
  for (const token of tokens) {
    const angled = token.match(/^(.*)<([^>]+)>$/);
    if (angled) {
      const display = angled[1].replace(/^"+|"+$/g, "").trim();
      const address = angled[2].trim();
      if (address) out.push(display ? { address, name: display } : { address });
      continue;
    }
    const emailOnly = token.match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i);
    if (emailOnly) out.push({ address: emailOnly[0] });
  }
  return out;
}

function extractSnippet(raw: Buffer, maxLen = 180): string {
  const body = raw.toString("utf-8").split(/\r?\n\r?\n/, 2)[1] || "";
  const normalized = body
    .replace(/=\r?\n/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "Content is syncing from IMAP…";
  return normalized.slice(0, maxLen);
}

function computeTakeoutHash(raw: Buffer): string {
  return createHash("sha1").update(raw).digest("hex");
}

async function parseStageContent(raw: Buffer): Promise<ParsedStageContent | null> {
  try {
    const parser = new PostalMime();
    const parsed = await parser.parse(raw);
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    const html = typeof parsed.html === "string" ? parsed.html : "";
    const snippetSource = text || html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return {
      htmlBody: html || null,
      textBody: text || null,
      snippet: snippetSource ? snippetSource.slice(0, 180) : null,
      hasAttachments: Array.isArray(parsed.attachments) && parsed.attachments.length > 0,
    };
  } catch {
    return null;
  }
}

async function ensureImportAccount(params: {
  email: string;
  host: string;
  port: number;
  tls: boolean;
  smtpHost: string;
  smtpPort: number;
  username: string;
  password: string;
}): Promise<string> {
  const pool = getPool();
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM accounts WHERE lower(email) = lower($1) LIMIT 1`,
    [params.email],
  );
  if (existing.rows[0]?.id) return existing.rows[0].id;

  const created = await pool.query<{ id: string }>(
    `INSERT INTO accounts (
       email, display_name, imap_host, imap_port, imap_tls,
       smtp_host, smtp_port, username, password
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      params.email,
      params.email.split("@")[0] || params.email,
      params.host,
      params.port,
      params.tls,
      params.smtpHost,
      params.smtpPort,
      params.username,
      params.password,
    ],
  );
  return created.rows[0].id;
}

async function ensureImportFolder(accountId: string, folderPath: string): Promise<string> {
  const pool = getPool();
  const folderName = folderDisplayName(folderPath);
  const specialUse = guessSpecialUse(folderPath);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO folders (account_id, path, name, special_use, sync_state)
     VALUES ($1, $2, $3, $4, 'stale')
     ON CONFLICT (account_id, path) DO UPDATE
     SET name = EXCLUDED.name,
         special_use = COALESCE(folders.special_use, EXCLUDED.special_use),
         updated_at = now()
     RETURNING id`,
    [accountId, folderPath, folderName, specialUse],
  );
  return result.rows[0].id;
}

async function nextTempUid(folderId: string, cache: Map<string, number>): Promise<number> {
  const cached = cache.get(folderId);
  if (typeof cached === "number") {
    cache.set(folderId, cached - 1);
    return cached;
  }

  const pool = getPool();
  const result = await pool.query<{ min_uid: number | null }>(
    `SELECT MIN(uid)::bigint AS min_uid FROM messages WHERE folder_id = $1`,
    [folderId],
  );
  const minUid = Number(result.rows[0]?.min_uid ?? 0);
  const start = minUid < 0 ? minUid - 1 : -1;
  cache.set(folderId, start - 1);
  return start;
}

async function stageMessageInDb(params: {
  accountId: string;
  folderId: string;
  rawMessage: Buffer;
  messageId: string | null;
  flags: string[];
  tempUidCache: Map<string, number>;
  takeoutHash: string;
  parsedStageContent?: ParsedStageContent | null;
}): Promise<{ stagedMessageId: string; tempUid: number } | null> {
  const pool = getPool();
  const mergeFlagsIntoExisting = async (messageRowId: string): Promise<void> => {
    await pool.query(
      `UPDATE messages
       SET flags = (
             SELECT ARRAY(
               SELECT DISTINCT f
               FROM unnest(COALESCE(messages.flags, '{}'::text[]) || $2::text[]) AS f
             )
           ),
           updated_at = now()
       WHERE id = $1`,
      [messageRowId, params.flags],
    );
  };

  if (params.messageId) {
    const duplicate = await pool.query<{ id: string }>(
      `SELECT id
       FROM messages
       WHERE folder_id = $1 AND message_id = $2
       LIMIT 1`,
      [params.folderId, params.messageId],
    );
    if (duplicate.rows.length > 0) {
      await mergeFlagsIntoExisting(duplicate.rows[0].id);
      return null;
    }
  }
  const duplicateByHash = await pool.query<{ id: string }>(
    `SELECT id
     FROM messages
     WHERE folder_id = $1
       AND headers->>'takeout_hash' = $2
     LIMIT 1`,
    [params.folderId, params.takeoutHash],
  );
  if (duplicateByHash.rows.length > 0) {
    await mergeFlagsIntoExisting(duplicateByHash.rows[0].id);
    return null;
  }

  const tempUid = await nextTempUid(params.folderId, params.tempUidCache);
  const fromAddress = extractFromAddress(params.rawMessage);
  const toAddresses = extractAddressListHeader(params.rawMessage, "To");
  const ccAddresses = extractAddressListHeader(params.rawMessage, "Cc");
  const bccAddresses = extractAddressListHeader(params.rawMessage, "Bcc");
  const replyToAddresses = extractAddressListHeader(params.rawMessage, "Reply-To");
  const subject = extractSubject(params.rawMessage);
  const snippet = params.parsedStageContent?.snippet || extractSnippet(params.rawMessage);
  const dateIso = extractDateIso(params.rawMessage);
  const isUnread = !params.flags.includes("\\Seen");
  const placeholder = `<p style="color:#6b7280">This email is still syncing from IMAP.</p>`;
  const textBody = params.parsedStageContent?.textBody || snippet;
  const htmlBody = params.parsedStageContent?.htmlBody || placeholder;
  const hasAttachments = params.parsedStageContent?.hasAttachments ?? false;

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO messages (
       account_id, folder_id, uid, message_id, subject, from_address,
       to_addresses, cc_addresses, bcc_addresses, reply_to, date, flags,
       text_body, html_body, snippet, headers, has_attachments
     ) VALUES (
       $1, $2, $3, $4, $5, $6::jsonb,
       $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::timestamptz, $12::text[],
       $13, $14, $15, $16::jsonb, $17
     )
     RETURNING id`,
    [
      params.accountId,
      params.folderId,
      tempUid,
      params.messageId,
      subject,
      JSON.stringify(fromAddress),
      JSON.stringify(toAddresses),
      JSON.stringify(ccAddresses),
      JSON.stringify(bccAddresses),
      JSON.stringify(replyToAddresses),
      dateIso,
      params.flags,
      textBody,
      htmlBody,
      snippet,
      JSON.stringify({ takeout_hash: params.takeoutHash }),
      hasAttachments,
    ],
  );

  await pool.query(
    `UPDATE folders
     SET total_messages = total_messages + 1,
         unread_count = unread_count + CASE WHEN $2 THEN 1 ELSE 0 END,
         updated_at = now()
     WHERE id = $1`,
    [params.folderId, isUnread],
  );

  return { stagedMessageId: inserted.rows[0].id, tempUid };
}

async function findPendingStagedMessage(params: {
  accountId: string;
  folderId: string;
  messageId: string | null;
  takeoutHash: string;
}): Promise<{ id: string; folderPath: string; flags: string[] } | null> {
  const pool = getPool();
  if (params.messageId) {
    const result = await pool.query<{ id: string; folder_path: string; flags: string[] }>(
      `SELECT m.id, f.path AS folder_path, m.flags
       FROM messages m
       JOIN folders f ON m.folder_id = f.id
       WHERE m.account_id = $1
         AND m.uid < 0
         AND (m.message_id = $3 OR m.headers->>'takeout_hash' = $4)
       ORDER BY
         CASE
           WHEN m.folder_id = $2 AND m.message_id = $3 THEN 0
           WHEN m.folder_id = $2 THEN 1
           WHEN m.message_id = $3 THEN 2
           ELSE 3
         END,
         m.created_at ASC
       LIMIT 1`,
      [params.accountId, params.folderId, params.messageId, params.takeoutHash],
    );
    if (!result.rows[0]) return null;
    return {
      id: result.rows[0].id,
      folderPath: result.rows[0].folder_path,
      flags: Array.isArray(result.rows[0].flags) ? result.rows[0].flags : [],
    };
  }

  const byHash = await pool.query<{ id: string; folder_path: string; flags: string[] }>(
    `SELECT m.id, f.path AS folder_path, m.flags
     FROM messages m
     JOIN folders f ON m.folder_id = f.id
     WHERE m.account_id = $1
       AND m.uid < 0
       AND m.headers->>'takeout_hash' = $3
     ORDER BY
       CASE WHEN m.folder_id = $2 THEN 0 ELSE 1 END,
       m.created_at ASC
     LIMIT 1`,
    [params.accountId, params.folderId, params.takeoutHash],
  );
  if (!byHash.rows[0]) return null;
  return {
    id: byHash.rows[0].id,
    folderPath: byHash.rows[0].folder_path,
    flags: Array.isArray(byHash.rows[0].flags) ? byHash.rows[0].flags : [],
  };
}

async function markStagedMessageSyncError(messageRowId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE messages
     SET flags = CASE
           WHEN '__sync_error' = ANY(flags) THEN flags
           ELSE array_append(flags, '__sync_error')
         END,
         updated_at = now()
     WHERE id = $1`,
    [messageRowId],
  );
}

async function markStagedMessageImapSynced(params: {
  messageRowId: string;
  accountEmail: string;
  imapUid?: number | null;
}): Promise<void> {
  const pool = getPool();
  if (typeof params.imapUid === "number" && Number.isFinite(params.imapUid) && params.imapUid > 0) {
    try {
      const previous = await pool.query<{ uid: number; message_id: string | null }>(
        `SELECT uid::bigint AS uid, message_id
         FROM messages
         WHERE id = $1
         LIMIT 1`,
        [params.messageRowId],
      );
      const previousUid = Number(previous.rows[0]?.uid ?? NaN);
      const previousMessageId = previous.rows[0]?.message_id ?? null;
      await pool.query(
        `UPDATE messages
         SET uid = $2,
             flags = array_remove(flags, '__sync_error'),
             updated_at = now()
         WHERE id = $1`,
        [params.messageRowId, params.imapUid],
      );
      if (previousMessageId) {
        await pool.query(
          `UPDATE mail_snoozes
           SET snoozed_uid = $3
           WHERE account_email = $1 AND message_id = $2`,
          [params.accountEmail, previousMessageId, params.imapUid],
        );
      } else if (Number.isFinite(previousUid)) {
        await pool.query(
          `UPDATE mail_snoozes
           SET snoozed_uid = $3
           WHERE account_email = $1 AND message_id IS NULL AND snoozed_uid = $2`,
          [params.accountEmail, previousUid, params.imapUid],
        );
      }
      return;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "23505") {
        const deleted = await pool.query<{ folder_id: string; flags: string[] }>(
          `DELETE FROM messages
           WHERE id = $1
           RETURNING folder_id, flags`,
          [params.messageRowId],
        );
        const row = deleted.rows[0];
        if (row?.folder_id) {
          const unreadDelta = Array.isArray(row.flags) && !row.flags.includes("\\Seen") ? 1 : 0;
          await pool.query(
            `UPDATE folders
             SET total_messages = GREATEST(0, total_messages - 1),
                 unread_count = GREATEST(0, unread_count - $2),
                 updated_at = now()
             WHERE id = $1`,
            [row.folder_id, unreadDelta],
          );
        }
        return;
      }
      throw error;
    }
  }

  await pool.query(
    `UPDATE messages
     SET flags = array_remove(flags, '__sync_error'),
         updated_at = now()
     WHERE id = $1`,
    [params.messageRowId],
  );
}

async function importTakeoutArchive(options: {
  tgzPath: string;
  maxImapAppendConcurrency: number;
  phaseOneBodyParseCount: number;
  labelPreferences: ImportLabelPreferences;
  onProgress: (progress: ImportProgress) => Promise<void>;
  shouldCancel: () => Promise<boolean>;
}): Promise<ImportResult> {
  if (!fs.existsSync(options.tgzPath)) throw new Error(`Takeout file not found: ${options.tgzPath}`);

  const importedMessageIds = loadCheckpoint(options.tgzPath);
  const mailboxConfig = getMailboxConfig();
  const accountId = await ensureImportAccount({
    email: mailboxConfig.accountEmail,
    host: mailboxConfig.host,
    port: mailboxConfig.port,
    tls: mailboxConfig.tls,
    smtpHost: mailboxConfig.smtpHost,
    smtpPort: mailboxConfig.smtpPort,
    username: mailboxConfig.imapUser,
    password: mailboxConfig.pass,
  });
  const folderIdCache = new Map<string, string>();
  const tempUidCache = new Map<string, number>();
  const progress: ImportProgress = {
    processed: 0,
    imported: 0,
    dbImported: 0,
    imapSynced: 0,
    skipped: 0,
    errors: 0,
  };
  let cancelled = false;
  let completedSincePersist = 0;
  let completedSinceCheckpointFlush = 0;
  let processedSinceCancelCheck = 0;
  const pendingCheckpointIds: string[] = [];
  let persistQueue: Promise<void> = Promise.resolve();

  const queueProgressFlush = (force = false): void => {
    const shouldPersist = force || completedSincePersist >= 250;
    const shouldCheckpoint = force || completedSinceCheckpointFlush >= 1000;
    if (!shouldPersist && !shouldCheckpoint) return;

    const progressSnapshot = { ...progress };
    const checkpointIds = shouldCheckpoint
      ? pendingCheckpointIds.splice(0, pendingCheckpointIds.length)
      : [];

    if (shouldPersist) completedSincePersist = 0;
    if (shouldCheckpoint) completedSinceCheckpointFlush = 0;

    persistQueue = persistQueue.then(async () => {
      if (checkpointIds.length > 0) await appendCheckpointIds(options.tgzPath, checkpointIds);
      if (shouldPersist) await options.onProgress(progressSnapshot);
    }).catch(() => undefined);
  };

  const onMessageProcessed = (result: "db_imported" | "skipped" | "error", messageId?: string): void => {
    if (result === "db_imported") {
      progress.imported += 1;
      progress.dbImported += 1;
      if (messageId && !importedMessageIds.has(messageId)) {
        importedMessageIds.add(messageId);
        pendingCheckpointIds.push(messageId);
      }
    } else if (result === "skipped") {
      progress.skipped += 1;
    } else {
      progress.errors += 1;
    }

    progress.processed += 1;
    completedSincePersist += 1;
    completedSinceCheckpointFlush += 1;
    queueProgressFlush(false);
  };

  const onImapSynced = (): void => {
    progress.imapSynced += 1;
    completedSincePersist += 1;
    queueProgressFlush(false);
  };

  // Phase 1: ingest all eligible messages into PostgreSQL first.
  const stagePass = async (): Promise<void> => {
    const mboxStream = await extractMboxFromTgz(options.tgzPath);
    let parseBudgetRemaining = Math.max(0, options.phaseOneBodyParseCount);
    for await (const rawMessage of parseMbox(mboxStream)) {
      processedSinceCancelCheck += 1;
      if (processedSinceCancelCheck >= 100) {
        processedSinceCancelCheck = 0;
        if (await options.shouldCancel()) {
          cancelled = true;
          break;
        }
      }

      const messageId = extractMessageId(rawMessage);
      const takeoutHash = computeTakeoutHash(rawMessage);
      if (messageId && importedMessageIds.has(messageId)) {
        onMessageProcessed("skipped");
      } else {
        const labels = extractGmailLabels(rawMessage);
        const { folder, flags } = resolveLabels(labels, options.labelPreferences);
        if (!folder) {
          onMessageProcessed("skipped");
          continue;
        }

        let folderId = folderIdCache.get(folder);
        if (!folderId) {
          folderId = await ensureImportFolder(accountId, folder);
          folderIdCache.set(folder, folderId);
        }

        let parsedStageContent: ParsedStageContent | null = null;
        if (parseBudgetRemaining > 0) {
          parseBudgetRemaining -= 1;
          parsedStageContent = await parseStageContent(rawMessage);
        }

        const staged = await stageMessageInDb({
          accountId,
          folderId,
          rawMessage,
          messageId,
          flags,
          tempUidCache,
          takeoutHash,
          parsedStageContent,
        });

        if (!staged) {
          onMessageProcessed("skipped");
          continue;
        }

        onMessageProcessed("db_imported", messageId || undefined);
      }
    }
  };

  // Phase 2: sync staged rows to IMAP in background.
  const syncPass = async (): Promise<void> => {
    const maxConcurrency = Math.max(1, options.maxImapAppendConcurrency);
    const inFlight = new Set<Promise<void>>();
    let targetConcurrency = Math.min(4, maxConcurrency);
    let syncAttempts = 0;
    let syncErrors = 0;

    const tuneConcurrency = (): void => {
      if (syncAttempts < 200) return;
      const errorRate = syncErrors / syncAttempts;
      if (errorRate <= 0.01 && targetConcurrency < maxConcurrency) {
        targetConcurrency += 1;
      } else if (errorRate >= 0.05 && targetConcurrency > 1) {
        targetConcurrency -= 1;
      }
      syncAttempts = 0;
      syncErrors = 0;
    };

    const waitForSlot = async (): Promise<void> => {
      if (inFlight.size < targetConcurrency) return;
      await Promise.race(inFlight);
    };

    try {
      const mboxStream = await extractMboxFromTgz(options.tgzPath);
      for await (const rawMessage of parseMbox(mboxStream)) {
        processedSinceCancelCheck += 1;
        if (processedSinceCancelCheck >= 100) {
          processedSinceCancelCheck = 0;
          if (await options.shouldCancel()) {
            cancelled = true;
            break;
          }
        }

        const labels = extractGmailLabels(rawMessage);
        const { folder, flags } = resolveLabels(labels, options.labelPreferences);
        if (!folder) continue;

        let folderId = folderIdCache.get(folder);
        if (!folderId) {
          folderId = await ensureImportFolder(accountId, folder);
          folderIdCache.set(folder, folderId);
        }

        const messageId = extractMessageId(rawMessage);
        const takeoutHash = computeTakeoutHash(rawMessage);
        const pending = await findPendingStagedMessage({
          accountId,
          folderId,
          messageId,
          takeoutHash,
        });
        if (!pending) continue;

        await waitForSlot();
        let task!: Promise<void>;
        task = (async () => {
          try {
            const appendTargetFolder = pending.folderPath || folder;
            const appendFlags = pending.flags.filter((flag) => !flag.startsWith("__"));
            const appendResult = await upstreamAppendMessage(
              appendTargetFolder,
              rawMessage,
              appendFlags.length ? appendFlags : flags,
            );
            await markStagedMessageImapSynced({
              messageRowId: pending.id,
              accountEmail: mailboxConfig.accountEmail,
              imapUid: appendResult?.uid,
            });
            await emitFolderSyncedEvent(appendTargetFolder);
            onImapSynced();
            syncAttempts += 1;
            tuneConcurrency();
          } catch {
            await markStagedMessageSyncError(pending.id).catch(() => undefined);
            progress.errors += 1;
            completedSincePersist += 1;
            queueProgressFlush(false);
            syncAttempts += 1;
            syncErrors += 1;
            tuneConcurrency();
          }
        })().finally(() => {
          inFlight.delete(task);
        });
        inFlight.add(task);
      }

      if (inFlight.size > 0) await Promise.all(inFlight);
    } finally {
      if (inFlight.size > 0) await Promise.allSettled(inFlight);
    }
  };

  try {
    await stagePass();
    queueProgressFlush(true);
    await persistQueue.catch(() => undefined);
    if (!cancelled) {
      await syncPass();
    }
  } finally {
    queueProgressFlush(true);
    await persistQueue.catch(() => undefined);
    saveCheckpointMeta(options.tgzPath, importedMessageIds);
    await options.onProgress({ ...progress }).catch(() => undefined);
  }

  return { ...progress, cancelled };
}

async function safeCleanupFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // Ignore missing temporary files.
  }
}

function readBooleanOption(options: Record<string, unknown> | undefined, key: string, fallback: boolean): boolean {
  const value = options?.[key];
  return typeof value === "boolean" ? value : fallback;
}

function readNumberOption(options: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const value = options?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value;
}

function readImportCustomLabelMappings(options: Record<string, unknown> | undefined): ImportCustomLabelMapping[] {
  const raw = options?.importLabelMappings;
  if (!Array.isArray(raw)) return [];
  const out: ImportCustomLabelMapping[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    if (typeof value.sourceName !== "string" || typeof value.targetName !== "string") continue;
    out.push({
      sourceName: value.sourceName,
      targetName: value.targetName,
      enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    });
  }
  return out;
}

function buildImportLabelPreferences(options: Record<string, unknown> | undefined): ImportLabelPreferences {
  const mappings = readImportCustomLabelMappings(options);
  const customLabelMap = new Map<string, string>();
  const disabledCustomLabels = new Set<string>();
  for (const mapping of mappings) {
    const source = mapping.sourceName.trim().toLowerCase();
    if (!source) continue;
    if (mapping.enabled === false) {
      disabledCustomLabels.add(source);
      continue;
    }
    const target = mapping.targetName.trim();
    if (!target) continue;
    customLabelMap.set(source, target);
  }

  return {
    importCustomLabels: readBooleanOption(options, "importLabelsFromTakeout", true),
    includeSent: readBooleanOption(options, "includeSentMessages", true),
    includeSpam: readBooleanOption(options, "includeSpamMessages", false),
    includeTrash: readBooleanOption(options, "includeTrashMessages", false),
    customLabelMap,
    disabledCustomLabels,
  };
}

type ImportJobCleanupOutcome = "completed" | "failed" | "cancelled";

async function cleanupJobSourceFile(
  job: { tempFilePath: string; options: Record<string, unknown> },
  outcome: ImportJobCleanupOutcome,
): Promise<void> {
  const deleteOnSuccess = readBooleanOption(job.options, "deleteSourceFileOnSuccess", false);
  if (deleteOnSuccess) {
    if (outcome !== "completed") return;
    await safeCleanupFile(job.tempFilePath);
    return;
  }

  // Backward compatibility for older jobs that still use keepSourceFile.
  if (readBooleanOption(job.options, "keepSourceFile", false)) return;
  await safeCleanupFile(job.tempFilePath);
}

async function runSingleJob(): Promise<boolean> {
  const job = await claimNextQueuedTakeoutImportJob();
  if (!job) return false;

  activeJobId = job.id;

  const persist = async (progress: ImportProgress) => {
    await updateTakeoutImportProgress({
      id: job.id,
      processedMessages: progress.processed,
      importedMessages: progress.dbImported,
      dbImportedMessages: progress.dbImported,
      imapSyncedMessages: progress.imapSynced,
      skippedMessages: progress.skipped,
      errorCount: progress.errors,
    });
  };

  try {
    let estimatedTotalMessages = job.estimatedTotalMessages ?? 0;
    const shouldEstimateBeforeImport = !readBooleanOption(job.options, "disableEstimateBeforeImport", false)
      && (!job.estimatedTotalMessages || job.estimatedTotalMessages <= 0);
    const imapAppendConcurrency = Math.max(
      1,
      Math.min(8, Math.floor(readNumberOption(job.options, "imapAppendConcurrency", 4))),
    );
    const labelPreferences = buildImportLabelPreferences(job.options);

    if (shouldEstimateBeforeImport) {
      await beginTakeoutImportEstimation({
        id: job.id,
        estimationTotalBytes: job.fileSizeBytes,
      });

      let lastEstimateWrite = 0;
      const estimate = await estimateTotalMessagesInTakeout(job.tempFilePath, async (bytesRead, totalBytes) => {
        const now = Date.now();
        if (now - lastEstimateWrite < 1000) return;
        lastEstimateWrite = now;
        await updateTakeoutImportEstimationProgress({
          id: job.id,
          estimationScannedBytes: Math.min(bytesRead, totalBytes),
        });
      });

      await setTakeoutImportEstimatedTotalMessages({
        id: job.id,
        estimatedTotalMessages: estimate,
      });
      estimatedTotalMessages = estimate;
    }

    if (estimatedTotalMessages <= 0) {
      const refreshed = await getTakeoutImportJob(job.id);
      estimatedTotalMessages = refreshed?.estimatedTotalMessages ?? 0;
    }

    // Parse/store body content for all messages during phase 1.
    // Using MAX_SAFE_INTEGER avoids dependence on estimate accuracy.
    const phaseOneBodyParseCount = Number.MAX_SAFE_INTEGER;

    const result = await importTakeoutArchive({
      tgzPath: job.tempFilePath,
      maxImapAppendConcurrency: imapAppendConcurrency,
      phaseOneBodyParseCount,
      labelPreferences,
      onProgress: persist,
      shouldCancel: async () => {
        if (cancelRequested.has(job.id)) return true;
        const current = await getTakeoutImportJob(job.id);
        return current?.status === "cancelled";
      },
    });

    const current = await getTakeoutImportJob(job.id);
    const wasCancelled = result.cancelled || current?.status === "cancelled";

    if (wasCancelled) {
      await clearTakeoutImportEstimationState(job.id);
      await cleanupJobSourceFile(job, "cancelled");
      cancelRequested.delete(job.id);
      return true;
    }

    await completeTakeoutImportJob({
      id: job.id,
      processedMessages: result.processed,
      importedMessages: result.dbImported,
      dbImportedMessages: result.dbImported,
      imapSyncedMessages: result.imapSynced,
      skippedMessages: result.skipped,
      errorCount: result.errors,
    });
    await clearTakeoutImportEstimationState(job.id);
    await cleanupJobSourceFile(job, "completed");
    cancelRequested.delete(job.id);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import worker failed.";
    await clearTakeoutImportEstimationState(job.id);
    await failTakeoutImportJob({ id: job.id, message });
    await cleanupJobSourceFile(job, "failed");
    cancelRequested.delete(job.id);
    return true;
  } finally {
    if (activeJobId === job.id) activeJobId = null;
  }
}

export async function kickTakeoutImportWorker(): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;

  try {
    await requeueStaleRunningTakeoutImportJobs(3);
    while (await runSingleJob()) {
      // Drain queue.
    }
  } finally {
    workerRunning = false;
  }
}

export async function requestCancelTakeoutJob(id: string): Promise<boolean> {
  const cancelled = await cancelTakeoutImportJob(id);
  if (!cancelled) return false;
  if (activeJobId === id) cancelRequested.add(id);
  return true;
}
