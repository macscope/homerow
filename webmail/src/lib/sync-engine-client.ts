type FlagMode = "add" | "remove";

export interface UpstreamSendAttachment {
  filename: string;
  contentType?: string;
  content: string;
  cid?: string;
  contentDisposition?: "attachment" | "inline";
}

export interface UpstreamSendMessagePayload {
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
  attachments?: UpstreamSendAttachment[];
}

const SYNC_ENGINE_URL = (process.env.SYNC_ENGINE_URL || "http://127.0.0.1:4001").replace(/\/$/, "");
const SYNC_ENGINE_API_TOKEN =
  process.env.SYNC_ENGINE_API_TOKEN ||
  process.env.DB_PASSWORD ||
  "mailsync";

async function postToSyncEngine<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${SYNC_ENGINE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SYNC_ENGINE_API_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `Sync engine request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function upstreamSetFlags(
  folderPath: string,
  uids: number[],
  flags: string[],
  mode: FlagMode,
): Promise<void> {
  await postToSyncEngine<{ ok: true }>("/internal/upstream/flags", {
    folderPath,
    uids,
    flags,
    mode,
  });
}

export async function upstreamMoveMessages(
  folderPath: string,
  targetPath: string,
  uids: number[],
): Promise<void> {
  await postToSyncEngine<{ ok: true }>("/internal/upstream/move", {
    folderPath,
    targetPath,
    uids,
  });
}

export async function upstreamDeleteMessages(
  folderPath: string,
  uids: number[],
): Promise<void> {
  await postToSyncEngine<{ ok: true }>("/internal/upstream/delete", {
    folderPath,
    uids,
  });
}

export async function upstreamAppendMessage(
  folderPath: string,
  rawMessage: string | Buffer,
  flags: string[],
): Promise<{ uid: number | null }> {
  return postToSyncEngine<{ uid: number | null }>("/internal/upstream/append", {
    folderPath,
    rawMessage: (typeof rawMessage === "string"
      ? Buffer.from(rawMessage)
      : rawMessage
    ).toString("base64"),
    flags,
  });
}

export async function upstreamSendMessage(
  payload: UpstreamSendMessagePayload,
): Promise<void> {
  await postToSyncEngine<{ ok: true }>("/internal/upstream/send", payload);
}
