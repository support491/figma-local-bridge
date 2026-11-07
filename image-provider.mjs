import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { inflateSync } from "node:zlib";

const DEFAULT_MODEL = "gpt-image-2.5-flare";
const MODELS = new Set(["gpt-image-1-mini", "gpt-image-1.5", "gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"]);
const SIZES = new Set(["1024x1024", "1536x1024", "1024x1536"]);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 36 * 1024 * 1024;
const DEFAULT_DIRECTORY = join(homedir(), "Pictures", "Figma MCP Exports", "Generated Campaign Images");
const hash = (value) => createHash("sha256").update(value).digest("hex");

export class ImageProviderError extends Error {
  constructor(code, message) { super(message); this.name = "ImageProviderError"; this.code = code; }
}
function reject(code, message) { throw new ImageProviderError(code, message); }

export function getImageProviderStatus({ env = process.env } = {}) {
  const provider = env.FIGMA_IMAGE_PROVIDER?.trim() || "disabled";
  const model = env.FIGMA_IMAGE_MODEL?.trim() || DEFAULT_MODEL;
  const supported = provider === "openai";
  const modelSupported = MODELS.has(model);
  const apiKey = env.FIGMA_IMAGE_API_KEY?.trim();
  const configured = typeof apiKey === "string" && /^\S{12,4096}$/.test(apiKey) && !apiKey.includes("${") && !apiKey.startsWith("__encrypted__:");
  return {
    enabled: supported && modelSupported && configured,
    provider: supported ? "openai" : "disabled",
    model: modelSupported ? model : null,
    reason: !supported ? "Image generation is off. Ask your administrator to configure the optional provider." : !modelSupported ? "The configured image model is not supported by this package." : !configured ? "The optional provider needs an API key configured by your administrator." : "Ready. Each requested generation or edit uses the separately billed OpenAI API.",
    sizes: [...SIZES], maxImagesPerRequest: 1, outputFormat: "png",
    requiresUserConfirmation: true,
    dataSent: "Your image prompt, and the selected local image when editing, are sent to OpenAI. No Figma file is sent automatically.",
  };
}

function dimensions(width, height, mimeType) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 16_777_216) reject("INVALID_IMAGE", "The image dimensions are invalid or exceed the supported limit.");
  return { width, height, mimeType };
}
const crcTable = Array.from({ length: 256 }, (_, i) => {
  for (let n = 0; n < 8; n++) i = (i & 1) ? 0xedb88320 ^ (i >>> 1) : i >>> 1;
  return i >>> 0;
});
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }

// Inspect the bytes, never the filename. PNG output is also checked for complete
// chunks, CRCs and a bounded, valid compressed image stream before it is saved.
function rasterInfo(bytes) {
  if (bytes.length < 16 || bytes.length > MAX_IMAGE_BYTES) reject("INVALID_IMAGE", "Use a complete PNG, JPEG, or WebP image no larger than 25 MB.");
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8, info, ended = false, bitDepth, colorType, interlace;
    const compressed = [];
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      if (length > MAX_IMAGE_BYTES || offset + length + 12 > bytes.length) reject("INVALID_IMAGE", "The PNG image is incomplete.");
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) reject("INVALID_IMAGE", "The PNG image failed its integrity check.");
      if (!info && type !== "IHDR") reject("INVALID_IMAGE", "The PNG image has no valid header.");
      if (type === "IHDR") {
        if (info || length !== 13) reject("INVALID_IMAGE", "The PNG image has an invalid header.");
        info = dimensions(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12), "image/png");
        bitDepth = bytes[offset + 16]; colorType = bytes[offset + 17]; interlace = bytes[offset + 20];
        const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
        if (!depths[colorType]?.includes(bitDepth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || ![0, 1].includes(interlace)) reject("INVALID_IMAGE", "The PNG image uses an unsupported encoding.");
      }
      if (type === "IDAT") compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
      if (type === "IEND") { if (length !== 0) reject("INVALID_IMAGE", "The PNG image has an invalid ending."); ended = true; break; }
    }
    if (!ended || offset !== bytes.length || !compressed.length) reject("INVALID_IMAGE", "The PNG image is incomplete.");
    try {
      const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
      const rowBytes = Math.ceil(info.width * channels * bitDepth / 8) + 1;
      const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: Math.min(140 * 1024 * 1024, (rowBytes + 16) * (info.height + 16)) });
      if (!raw.length || (!interlace && raw.length !== rowBytes * info.height)) reject("INVALID_IMAGE", "The PNG pixel data is incomplete.");
    } catch { reject("INVALID_IMAGE", "The PNG pixel data is invalid or too large."); }
    return info;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) return dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3), "image/jpeg");
      offset += length;
    }
  }
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) + 8 === bytes.length) {
    let offset = 12, info, pixels = false;
    while (offset + 8 <= bytes.length) {
      const kind = bytes.toString("ascii", offset, offset + 4), length = bytes.readUInt32LE(offset + 4), data = offset + 8;
      if (data + length > bytes.length) break;
      if (kind === "VP8X" && length === 10) info = dimensions(1 + bytes.readUIntLE(data + 4, 3), 1 + bytes.readUIntLE(data + 7, 3), "image/webp");
      if (kind === "VP8 " && length >= 10 && bytes.subarray(data + 3, data + 6).equals(Buffer.from([0x9d, 1, 0x2a]))) { pixels = true; info ??= dimensions(bytes.readUInt16LE(data + 6) & 0x3fff, bytes.readUInt16LE(data + 8) & 0x3fff, "image/webp"); }
      if (kind === "VP8L" && length >= 5 && bytes[data] === 0x2f) { pixels = true; const bits = bytes.readUInt32LE(data + 1); info ??= dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, "image/webp"); }
      offset = data + length + (length % 2);
    }
    if (info && pixels && offset === bytes.length) return info;
  }
  reject("INVALID_IMAGE", "Use a valid PNG, JPEG, or WebP image. Other file types are not uploaded.");
}

async function sourceImage(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) reject("INVALID_SOURCE", "Select one absolute local image path to edit.");
  let handle;
  try {
    handle = await open(path, "r");
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_IMAGE_BYTES) reject("INVALID_SOURCE", "Select a local image file no larger than 25 MB.");
    // Bounded handle read also covers a file that grows between stat and read.
    const bytes = Buffer.alloc(Math.min(before.size + 1, MAX_IMAGE_BYTES + 1));
    let offset = 0;
    while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
    if (offset !== before.size) reject("INVALID_SOURCE", "The selected image changed while it was being read. Select it again.");
    const data = bytes.subarray(0, offset);
    return { bytes: data, ...rasterInfo(data) };
  } catch (error) {
    if (error instanceof ImageProviderError) throw error;
    reject("INVALID_SOURCE", "The selected local image could not be read. Check its location and access.");
  } finally { await handle?.close(); }
}

async function privateDirectory(directory) {
  if (!isAbsolute(directory)) reject("INVALID_DIRECTORY", "The image output directory must be an absolute path.");
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) reject("INVALID_DIRECTORY", "The image output directory must be a real directory.");
    await chmod(directory, 0o700);
  } catch (error) { if (error instanceof ImageProviderError) throw error; reject("STORAGE_ERROR", "The image output directory is not writable."); }
}
async function writePrivate(path, data) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}
async function replaceRecord(path, record) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writePrivate(temp, JSON.stringify(record)); await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
}
async function readResponse(response) {
  const declared = Number(response.headers?.get("content-length"));
  if (declared > MAX_RESPONSE_BYTES) { await response.body?.cancel(); reject("INVALID_RESPONSE", "The image provider returned a response larger than the supported limit."); }
  if (!response.body?.getReader) reject("INVALID_RESPONSE", "The image provider returned no image data.");
  const reader = response.body.getReader();
  const parts = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); reject("INVALID_RESPONSE", "The image provider returned a response larger than the supported limit."); }
      parts.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch (error) { if (error instanceof ImageProviderError) throw error; reject("INVALID_RESPONSE", "The image provider returned incomplete or invalid image data."); }
  finally { reader.releaseLock(); }
}

/** One expressly requested paid generation/edit. Reusing requestId never re-sends it. */
export async function generateCampaignImage(input, { env = process.env, fetchImpl = globalThis.fetch, outputDirectory = DEFAULT_DIRECTORY, timeoutMs = 180_000 } = {}) {
  const status = getImageProviderStatus({ env });
  if (!status.enabled) reject("PROVIDER_DISABLED", status.reason);
  if (input?.userConfirmed !== true) reject("CONFIRMATION_REQUIRED", "Ask the user to approve this separately billed image request and any selected image upload first.");
  if (typeof input.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.requestId)) reject("INVALID_REQUEST", "Use a requestId of 1–100 letters, numbers, dots, underscores, or hyphens. Reuse it to recover this request.");
  if (typeof input.prompt !== "string" || input.prompt.trim().length < 1 || input.prompt.length > 8000) reject("INVALID_PROMPT", "Describe the image in 1–8,000 characters.");
  const size = input.size ?? "1024x1024", quality = input.quality ?? "medium";
  if (!SIZES.has(size) || !["low", "medium", "high"].includes(quality) || (input.transparentBackground !== undefined && typeof input.transparentBackground !== "boolean")) reject("INVALID_OPTIONS", "Choose a supported image size, quality, and background option.");
  if (input.n !== undefined && input.n !== 1) reject("INVALID_OPTIONS", "Each request creates exactly one image.");
  const source = input.sourcePath === undefined ? null : await sourceImage(input.sourcePath);
  const body = { model: status.model, prompt: input.prompt.trim(), n: 1, size, quality, output_format: "png", background: input.transparentBackground ? "transparent" : "opaque", ...(source ? { images: [{ image_url: `data:${source.mimeType};base64,${source.bytes.toString("base64")}` }] } : {}) };
  const fingerprint = hash(JSON.stringify(body));
  await privateDirectory(outputDirectory);
  const requestsDirectory = join(outputDirectory, ".requests");
  await privateDirectory(requestsDirectory);
  const recordPath = join(requestsDirectory, `${hash(input.requestId)}.json`);
  const record = { schemaVersion: 1, requestId: input.requestId, fingerprint, status: "pending", createdAt: new Date().toISOString() };
  try { await writePrivate(recordPath, JSON.stringify(record)); }
  catch (error) {
    if (error.code !== "EEXIST") reject("STORAGE_ERROR", "Could not record the image request. No request was sent.");
    let existing;
    try { existing = JSON.parse(await readFile(recordPath, "utf8")); } catch { reject("REQUEST_UNCERTAIN", "This request already has a recovery record that cannot be read. It was not sent again."); }
    if (existing.fingerprint !== fingerprint) reject("REQUEST_CONFLICT", "This requestId belongs to different image instructions. No request was sent.");
    if (existing.status === "complete" && existing.result && /^[0-9a-f-]{36}\.png$/.test(basename(existing.result.path)) && existing.result.path === join(outputDirectory, basename(existing.result.path))) {
      try { if (hash(await readFile(existing.result.path)) === existing.result.sha256) return { ...existing.result, recovered: true }; } catch {}
      reject("OUTPUT_MISSING", "The completed image is missing or changed. This paid request was not sent again.");
    }
    reject("REQUEST_UNCERTAIN", "This request is pending, failed, or has an unknown outcome. It was not sent again. Check the generated-image folder and provider activity before approving a new requestId.");
  }
  let savedPath;
  try {
    const signal = AbortSignal.timeout(Math.min(180_000, Math.max(1, timeoutMs)));
    let response;
    try {
      response = await fetchImpl(`https://api.openai.com/v1/images/${source ? "edits" : "generations"}`, {
        method: "POST", redirect: "error", signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${env.FIGMA_IMAGE_API_KEY.trim()}` },
        body: JSON.stringify(body),
      });
    } catch { reject("REQUEST_UNCERTAIN", "The image request timed out or could not complete. Its outcome may be unknown; it will not be retried automatically."); }
    if (!response.ok) {
      await response.body?.cancel();
      const message = response.status === 401 || response.status === 403 ? "The image provider rejected access. Ask your administrator to check API credentials and model access." : response.status === 429 ? "The image provider's usage or rate limit was reached. Ask your administrator to check the account." : "The image provider did not complete the request. Check provider activity before approving another request.";
      reject("PROVIDER_ERROR", message);
    }
    const data = await readResponse(response);
    const encoded = data?.data?.[0]?.b64_json;
    if (!Array.isArray(data?.data) || data.data.length !== 1 || typeof encoded !== "string" || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) reject("INVALID_RESPONSE", "The image provider did not return one supported PNG image.");
    const bytes = Buffer.from(encoded, "base64");
    const info = rasterInfo(bytes);
    if (info.mimeType !== "image/png" || `${info.width}x${info.height}` !== size) reject("INVALID_RESPONSE", "The image provider returned a different format or size than requested.");
    savedPath = join(outputDirectory, `${randomUUID()}.png`);
    await writePrivate(savedPath, bytes);
    const result = { requestId: input.requestId, path: savedPath, ...info, bytes: bytes.length, sha256: hash(bytes), provider: "openai", model: status.model, operation: source ? "edit" : "generate", quality, transparentBackground: Boolean(input.transparentBackground), createdAt: new Date().toISOString(), promptSha256: hash(body.prompt), ...(source ? { sourceSha256: hash(source.bytes) } : {}), nextStep: "Review this image before placing it in the campaign with figma_place_local_image. The image has not been added to Figma." };
    await writePrivate(`${savedPath}.json`, `${JSON.stringify(result, null, 2)}\n`);
    await replaceRecord(recordPath, { ...record, status: "complete", result });
    return result;
  } catch (error) {
    await replaceRecord(recordPath, { ...record, status: "uncertain", ...(savedPath ? { savedFilename: basename(savedPath) } : {}) }).catch(() => {});
    if (error instanceof ImageProviderError) throw error;
    reject("REQUEST_UNCERTAIN", "The image request could not be completed or saved. Check the generated-image folder before approving another request; it was not retried automatically.");
  }
}
