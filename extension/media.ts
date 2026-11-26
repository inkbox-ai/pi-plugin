import * as fsp from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
const MIB = 1024 * 1024;
export const DEFAULT_UPLOAD_MAX_BYTES = 10 * MIB;
export const DEFAULT_ATTACHMENT_MAX_BYTES = 25 * MIB;

const FALLBACK_CONTENT_TYPE = "application/octet-stream";

// Small built-in type map covering the media the channels actually carry;
// anything else falls back to application/octet-stream.
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".heic": "image/heic",
};

export function localMediaPath(p: string, directory: string): string {
  if (!p || /^(?:https?:|data:|file:)/i.test(p) || p.includes("\0")) {
    throw new Error("Provide a local attachment path.");
  }
  return p === "~" || p.startsWith("~/")
    ? path.join(os.homedir(), p.slice(1))
    : path.resolve(directory, p);
}

function contentTypeFor(filename: string): string {
  return (
    CONTENT_TYPE_BY_EXTENSION[path.extname(filename).toLowerCase()] ??
    FALLBACK_CONTENT_TYPE
  );
}

export async function readFileWithCap(
  filePath: string,
  maxBytes: number,
  use: string,
): Promise<Buffer> {
  const file = await fsp.open(
    filePath,
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Attachments must be regular files.");
    if (stat.size > maxBytes)
      throw new Error(
        "Cannot " + use + ": file exceeds the " + maxBytes + "-byte limit.",
      );
    // Read from the checked descriptor. If the file grows while being read,
    // detect it without allocating an unbounded buffer.
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, null);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset !== stat.size)
      throw new Error("The attachment changed while it was being read.");
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}

// The slice of AgentIdentity outbound media needs; keeps this module
// testable with a plain stub.
export interface IMessageMediaUploader {
  uploadIMessageMedia(options: {
    content: Uint8Array;
    filename: string;
    contentType?: string;
  }): Promise<{ mediaUrl: string }>;
}

/**
 * Upload local files for an outbound SMS/iMessage send and return their
 * hosted media URLs, in input order. Oversized files throw with the
 * offending path so the agent can fix that file specifically.
 */
export async function uploadLocalMedia(
  identity: IMessageMediaUploader,
  paths: string[],
  opts: { directory: string; maxBytes?: number; beforeUpload?: () => void },
): Promise<string[]> {
  const maxBytes = opts.maxBytes ?? DEFAULT_UPLOAD_MAX_BYTES;
  const urls: string[] = [];
  for (const p of paths) {
    const resolved = localMediaPath(p, opts.directory);
    const content = await readFileWithCap(resolved, maxBytes, "upload");
    const filename = path.basename(resolved);
    opts.beforeUpload?.();
    const { mediaUrl } = await identity.uploadIMessageMedia({
      content,
      filename,
      contentType: contentTypeFor(filename),
    });
    urls.push(mediaUrl);
  }
  return urls;
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  contentBase64: string;
}

/** Read a local file into the inline-base64 shape email sends expect. */
export async function fileToEmailAttachment(
  filePath: string,
  opts: { directory: string; maxBytes?: number },
): Promise<EmailAttachment> {
  const maxBytes = opts.maxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES;
  const resolved = localMediaPath(filePath, opts.directory);
  const content = await readFileWithCap(resolved, maxBytes, "attach");
  const filename = path.basename(resolved);
  return {
    filename,
    contentType: contentTypeFor(filename),
    contentBase64: content.toString("base64"),
  };
}
