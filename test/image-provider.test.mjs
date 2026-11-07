import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { generateCampaignImage, getImageProviderStatus } from "../image-provider.mjs";

const env = { FIGMA_IMAGE_PROVIDER: "openai", FIGMA_IMAGE_API_KEY: "sk-private-test-value" };
const input = { requestId: "summer-001", prompt: "A pastel paper-cut summer background", userConfirmed: true };
function png(width = 1024, height = 1024) {
  const chunk = (type, data) => {
    const tag = Buffer.from(type), bytes = Buffer.concat([tag, data]); let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); bytes.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk("IEND", Buffer.alloc(0))]);
}
const image = png();
const response = (bytes = image) => new Response(JSON.stringify({ data: [{ b64_json: bytes.toString("base64") }] }), { headers: { "content-type": "application/json" } });
async function harness(t, fetchImpl = async () => response()) {
  const outputDirectory = await mkdtemp(join(tmpdir(), "figma-image-test-"));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  return { outputDirectory, options: { env, outputDirectory, fetchImpl } };
}

test("image service is disabled by default and reports no credential values", () => {
  assert.equal(getImageProviderStatus({ env: {} }).enabled, false);
  assert.equal(getImageProviderStatus({ env: { FIGMA_IMAGE_PROVIDER: "openai" } }).enabled, false);
  assert.equal(getImageProviderStatus({ env }).enabled, true);
  assert.equal(getImageProviderStatus({ env }).model, "gpt-image-2.5-flare");
  assert.doesNotMatch(JSON.stringify(getImageProviderStatus({ env })), /sk-private/);
  const unsupported = getImageProviderStatus({ env: { ...env, FIGMA_IMAGE_MODEL: "sk-secret-in-model" } });
  assert.equal(unsupported.enabled, false);
  assert.equal(unsupported.model, null);
  assert.doesNotMatch(JSON.stringify(unsupported), /sk-secret/);
  for (const FIGMA_IMAGE_API_KEY of ["${user_config.image_api_key}", "__encrypted__:secret", "key with spaces", "short"]) {
    assert.equal(getImageProviderStatus({ env: { ...env, FIGMA_IMAGE_API_KEY } }).enabled, false);
  }
});

test("disabled, unapproved and invalid requests never contact the provider", async (t) => {
  let calls = 0;
  const { options } = await harness(t, async () => { calls++; return response(); });
  for (const override of [{ userConfirmed: false }, { requestId: "../escape" }, { prompt: "" }, { prompt: "x".repeat(8001) }, { n: 3 }, { size: "9999x9999" }, { quality: "max" }, { transparentBackground: "true" }]) {
    await assert.rejects(generateCampaignImage({ ...input, ...override }, options));
  }
  await assert.rejects(generateCampaignImage(input, { ...options, env: {} }), { code: "PROVIDER_DISABLED" });
  assert.equal(calls, 0);
});

test("generation uses one fixed-host PNG request and saves private output with redacted provenance", async (t) => {
  let request;
  const { options, outputDirectory } = await harness(t, async (url, settings) => { request = { url, ...settings }; return response(); });
  const result = await generateCampaignImage(input, options);
  assert.equal(request.url, "https://api.openai.com/v1/images/generations");
  assert.equal(request.redirect, "error");
  assert.equal(request.headers.authorization, `Bearer ${env.FIGMA_IMAGE_API_KEY}`);
  const body = JSON.parse(request.body);
  assert.deepEqual({ ...body, prompt: undefined }, { model: "gpt-image-2.5-flare", prompt: undefined, n: 1, size: "1024x1024", quality: "medium", output_format: "png", background: "opaque" });
  assert.equal(result.width, 1024); assert.equal(result.height, 1024);
  assert.equal(result.operation, "generate");
  assert.deepEqual(await readFile(result.path), image);
  assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  assert.equal((await stat(outputDirectory)).mode & 0o777, 0o700);
  const metadata = await readFile(`${result.path}.json`, "utf8");
  assert.doesNotMatch(metadata, /sk-private|pastel paper/);
  assert.match(metadata, /promptSha256/);
  assert.match(result.nextStep, /has not been added/);
});

test("same request recovers saved output without incurring another request", async (t) => {
  let calls = 0;
  const { options } = await harness(t, async () => { calls++; return response(); });
  const first = await generateCampaignImage(input, options);
  const second = await generateCampaignImage(input, options);
  assert.equal(calls, 1);
  assert.equal(second.path, first.path);
  assert.equal(second.recovered, true);
  await assert.rejects(generateCampaignImage({ ...input, prompt: "Different prompt" }, options), { code: "REQUEST_CONFLICT" });
  assert.equal(calls, 1);
  await writeFile(first.path, "tampered");
  await assert.rejects(generateCampaignImage(input, options), { code: "OUTPUT_MISSING" });
  assert.equal(calls, 1);
});

test("concurrent and timed-out requests retain recovery fences and redact transport errors", async (t) => {
  let calls = 0, release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { options } = await harness(t, async () => { calls++; await pending; throw new Error(`Bearer ${env.FIGMA_IMAGE_API_KEY}`); });
  const first = generateCampaignImage(input, options);
  while (!calls) await new Promise(setImmediate);
  await assert.rejects(generateCampaignImage(input, options), { code: "REQUEST_UNCERTAIN" });
  release();
  await assert.rejects(first, (error) => error.code === "REQUEST_UNCERTAIN" && !error.message.includes(env.FIGMA_IMAGE_API_KEY));
  await assert.rejects(generateCampaignImage(input, options), { code: "REQUEST_UNCERTAIN" });
  assert.equal(calls, 1);
});

test("image edit uploads only selected bytes and does not include the local path", async (t) => {
  let request;
  const { options, outputDirectory } = await harness(t, async (url, settings) => { request = { url, body: JSON.parse(settings.body) }; return response(); });
  const sourcePath = join(outputDirectory, "approved-product.png");
  await writeFile(sourcePath, png(16, 16));
  const result = await generateCampaignImage({ ...input, sourcePath, transparentBackground: true }, options);
  assert.equal(request.url, "https://api.openai.com/v1/images/edits");
  assert.equal(request.body.background, "transparent");
  assert.equal(request.body.images.length, 1);
  assert.match(request.body.images[0].image_url, /^data:image\/png;base64,/);
  assert.doesNotMatch(JSON.stringify(request.body), /approved-product|figma-image-test/);
  assert.equal(result.operation, "edit");
  assert.match(result.sourceSha256, /^[a-f0-9]{64}$/);
});

test("request timeout aborts transport without creating a paid retry", async (t) => {
  let calls = 0;
  const { options } = await harness(t, async (_url, settings) => {
    calls++;
    return new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("unexpected timeout")), 1000);
      settings.signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(settings.signal.reason); }, { once: true });
    });
  });
  await assert.rejects(generateCampaignImage(input, { ...options, timeoutMs: 5 }), { code: "REQUEST_UNCERTAIN" });
  await assert.rejects(generateCampaignImage(input, options), { code: "REQUEST_UNCERTAIN" });
  assert.equal(calls, 1);
});

test("invalid local source is rejected before upload regardless of extension", async (t) => {
  let calls = 0;
  const { options, outputDirectory } = await harness(t, async () => { calls++; return response(); });
  const path = join(outputDirectory, "private.png");
  await writeFile(path, "not an image, a private text file");
  for (const sourcePath of [path, "relative.png", "https://example.com/image.png", outputDirectory]) {
    await assert.rejects(generateCampaignImage({ ...input, sourcePath }, options));
  }
  const corrupt = Buffer.from(image); corrupt[40] ^= 1;
  await writeFile(path, corrupt);
  await assert.rejects(generateCampaignImage({ ...input, sourcePath: path }, options), { code: "INVALID_IMAGE" });
  assert.equal(calls, 0);
});

test("provider errors never return the provider body or credentials and never automatically retry", async (t) => {
  let calls = 0;
  const { options } = await harness(t, async () => { calls++; return new Response(`secret ${env.FIGMA_IMAGE_API_KEY}`, { status: 401 }); });
  await assert.rejects(generateCampaignImage(input, options), (error) => error.code === "PROVIDER_ERROR" && !error.message.includes("sk-private"));
  await assert.rejects(generateCampaignImage(input, options), { code: "REQUEST_UNCERTAIN" });
  assert.equal(calls, 1);
});

test("bad, oversized, non-PNG and differently sized outputs are not saved", async (t) => {
  const replies = [
    () => new Response("not-json"),
    () => new Response("{}", { headers: { "content-length": String(37 * 1024 * 1024) } }),
    () => new Response(JSON.stringify({ data: [{ url: "https://untrusted.example/image.png" }] })),
    () => response(Buffer.from("not a valid PNG image")),
    () => response(png(16, 16)),
    () => new Response(JSON.stringify({ data: [{ b64_json: image.toString("base64") }, { b64_json: image.toString("base64") }] })),
  ];
  for (let i = 0; i < replies.length; i++) {
    const { options, outputDirectory } = await harness(t, async () => replies[i]());
    await assert.rejects(generateCampaignImage({ ...input, requestId: `invalid-${i}` }, options));
    assert.deepEqual(await readdir(outputDirectory), [".requests"]);
  }
});
