import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { accessToken } from "./auth";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
export const ROOT_FOLDER = "memdrive";

export interface DriveFile {
  id: string;
  name: string;
  size?: string;
  createdTime: string;
  mimeType?: string;
}

// fetch with auth, one token refresh on 401, and backoff on rate limits / server errors.
async function request(url: string, init: RequestInit = {}): Promise<Response> {
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(refreshed);
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && !refreshed && !process.env.MEMDRIVE_ACCESS_TOKEN) {
      refreshed = true;
      continue;
    }
    if (res.ok) return res;
    const text = await res.text();
    // Drive reports rate limits as 429, or as 403 with a rateLimitExceeded reason.
    const rateLimited = res.status === 429 || (res.status === 403 && /rateLimitExceeded|Quota exceeded/i.test(text));
    if ((rateLimited || res.status >= 500) && attempt < 5) {
      await Bun.sleep(2000 * 2 ** attempt);
      continue;
    }
    let message = text.slice(0, 300);
    try {
      message = JSON.parse(text).error?.message ?? message;
    } catch {}
    throw new Error(`Google Drive error ${res.status}: ${message}`);
  }
}

const q = (s: string) => s.replaceAll("\\", "\\\\").replaceAll("'", "\\'");

export async function listFiles(query: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: `${query} and trashed = false`,
      fields: "nextPageToken, files(id, name, size, createdTime, mimeType)",
      orderBy: "createdTime desc",
      pageSize: "1000",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const body = (await (await request(`${API}/files?${params}`)).json()) as {
      files: DriveFile[];
      nextPageToken?: string;
    };
    files.push(...body.files);
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  return files;
}

export async function findFolder(name: string, parent = "root"): Promise<string | null> {
  const found = await listFiles(`name = '${q(name)}' and mimeType = '${FOLDER_MIME}' and '${parent}' in parents`);
  return found[0]?.id ?? null;
}

export async function ensureFolder(name: string, parent = "root"): Promise<string> {
  const existing = await findFolder(name, parent);
  if (existing) return existing;
  const res = await request(`${API}/files?fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
  });
  return ((await res.json()) as { id: string }).id;
}

export async function listFolders(parent: string): Promise<DriveFile[]> {
  return listFiles(`mimeType = '${FOLDER_MIME}' and '${parent}' in parents`);
}

export async function listBackups(folderId: string): Promise<DriveFile[]> {
  return listFiles(`mimeType != '${FOLDER_MIME}' and '${folderId}' in parents`);
}

// Resumable upload: one session, sent in chunks so large archives survive flaky networks.
export async function uploadFile(path: string, name: string, parent: string): Promise<DriveFile> {
  const file = Bun.file(path);
  const size = file.size;
  const start = await request(`${UPLOAD_API}/files?uploadType=resumable&fields=id,name,size,createdTime`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "application/gzip",
      "X-Upload-Content-Length": String(size),
    },
    body: JSON.stringify({ name, parents: [parent] }),
  });
  const session = start.headers.get("Location");
  if (!session) throw new Error("Google Drive did not return an upload session");

  const CHUNK = 8 * 1024 * 1024; // must be a multiple of 256 KiB
  let offset = 0;
  let failures = 0;
  for (;;) {
    const end = Math.min(offset + CHUNK, size);
    let res: Response;
    try {
      res = await fetch(session, {
        method: "PUT",
        headers: {
          "Content-Length": String(end - offset),
          "Content-Range": size === 0 ? "bytes */0" : `bytes ${offset}-${end - 1}/${size}`,
        },
        body: file.slice(offset, end),
      });
    } catch (err) {
      res = new Response(String(err), { status: 599 }); // network drop: treat as retryable
    }
    if (res.status === 200 || res.status === 201) return (await res.json()) as DriveFile;
    if (res.status === 308) {
      failures = 0;
      offset = nextOffset(res);
      continue;
    }
    const text = await res.text();
    const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && /rateLimitExceeded|Quota exceeded/i.test(text));
    if (!retryable || ++failures > 6) throw new Error(`upload failed (${res.status}): ${text.slice(0, 300)}`);
    await Bun.sleep(2000 * 2 ** failures);
    // Ask the session how much it already has, then resume from there.
    const status = await fetch(session, { method: "PUT", headers: { "Content-Range": `bytes */${size}` } }).catch(() => null);
    if (status && (status.status === 200 || status.status === 201)) return (await status.json()) as DriveFile;
    if (status?.status === 308) offset = nextOffset(status);
  }
}

function nextOffset(res: Response): number {
  const range = res.headers.get("Range");
  return range ? Number(range.split("-")[1]) + 1 : 0;
}

export async function downloadFile(id: string, dest: string): Promise<void> {
  const res = await request(`${API}/files/${id}?alt=media`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
}

export async function deleteFile(id: string): Promise<void> {
  await request(`${API}/files/${id}`, { method: "DELETE" });
}
