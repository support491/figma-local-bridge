import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { unzipSync } from "fflate";
import { buildDesktopPackages } from "../scripts/build-mcpb.mjs";

const decode = (bytes) => new TextDecoder().decode(bytes);
let directory, distribution, extensionFiles, manifest, extracted;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "figma-desktop-package-"));
  distribution = await buildDesktopPackages(join(directory, "release"));
  extensionFiles = unzipSync(new Uint8Array(await readFile(distribution.extension)));
  manifest = JSON.parse(decode(extensionFiles["manifest.json"]));
  extracted = join(directory, "Installed Extension With Spaces");
  for (const [path, data] of Object.entries(extensionFiles)) {
    const target = join(extracted, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

async function freePort() {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function rpcClient(child) {
  let buffer = "", nextId = 0;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data) => {
    buffer += data;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    }
  });
  child.on("exit", () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Package exited before replying.")); }
    pending.clear();
  });
  return {
    notify(method) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`); },
    request(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP request timed out: ${method}`)); }, 8_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
  };
}

async function waitForStatus(base, predicate = () => true) {
  let error;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${base}/v1/status`, { signal: AbortSignal.timeout(1_000) });
      const status = await response.json();
      if (predicate(status)) return status;
    } catch (caught) { error = caught; }
    await delay(30);
  }
  throw error ?? new Error("Bridge did not reach the expected state.");
}

function launch(context, args, env, cwd = directory) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let errors = "";
  child.stderr.on("data", (data) => { errors += data; });
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  });
  child.packageErrors = () => errors;
  return child;
}

async function startExtension(context, port) {
  // Resolve the same __dirname placeholder as the desktop host; never use a repo cwd.
  const config = manifest.server.mcp_config;
  const args = config.args.map((arg) => arg.replaceAll("${__dirname}", extracted));
  const child = launch(context, args, {
    PATH: process.env.PATH,
    ...config.env,
    FIGMA_BRIDGE_PORT: String(port),
    FIGMA_PREFERENCES_DIR: join(directory, `preferences-${port}`),
    FIGMA_EXPORT_DIR: join(directory, `exports-${port}`),
    // Hostile inherited API settings must not re-enable credentials or comments.
    FIGMA_BRIDGE_API_DISABLED: "0",
    FIGMA_ACCESS_TOKEN: "test-value-that-must-be-cleared",
    FIGMA_API_BASE_URL: "https://must-not-be-contacted.invalid",
  });
  const rpc = rpcClient(child);
  const initialized = await rpc.request("initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "desktop-package-test", version: "1" },
  });
  rpc.notify("notifications/initialized");
  assert.equal(initialized.serverInfo.version, manifest.version);
  return { child, rpc, call: (name, args = {}) => rpc.request("tools/call", { name, arguments: args }) };
}

const toolJson = (result) => { assert.notEqual(result.isError, true, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
const post = (base, route, input) => fetch(`${base}${route}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(5_000),
});

test("staff archives are reproducible, portable, and exclude local settings and build dependencies", async () => {
  const second = await buildDesktopPackages(join(directory, "second"));
  assert.deepEqual(await readFile(distribution.extension), await readFile(second.extension));
  assert.deepEqual(await readFile(distribution.plugin), await readFile(second.plugin));
  assert.deepEqual(await readFile(distribution.kit), await readFile(second.kit));
  assert.deepEqual(Object.keys(extensionFiles).sort(), ["INSTALL.md", "LICENSE", "THIRD_PARTY_NOTICES.txt", "icon.png", "manifest.json", "server/bridge.mjs", "server/launcher.mjs"].sort());
  assert.equal(manifest.server.type, "node");
  assert.equal(manifest.server.mcp_config.command, "node");
  assert.equal(manifest.server.mcp_config.env.FIGMA_BRIDGE_HOST, "127.0.0.1");
  assert.equal(manifest.server.mcp_config.env.FIGMA_BRIDGE_PORT, "3846");
  assert.ok(!manifest.server.mcp_config.args.includes("--proxy-only"));
  assert.equal(manifest.user_config, undefined);
  assert.match(decode(extensionFiles.LICENSE), /2026 Arsenio Aaron/);
  assert.match(decode(extensionFiles.LICENSE), /2026 David Buck/);
  assert.match(decode(extensionFiles["THIRD_PARTY_NOTICES.txt"]), /@modelcontextprotocol\/sdk/);
  assert.match(decode(extensionFiles["THIRD_PARTY_NOTICES.txt"]), /zod/);
  const pluginFiles = unzipSync(new Uint8Array(await readFile(distribution.plugin)));
  const pluginManifest = JSON.parse(decode(pluginFiles["figma-local-bridge/manifest.json"]));
  assert.ok(pluginFiles[`figma-local-bridge/${pluginManifest.main}`]);
  assert.ok(pluginFiles[`figma-local-bridge/${pluginManifest.ui}`]);
  assert.match(decode(pluginFiles["figma-local-bridge/code.js"]), new RegExp(`const pluginVersion = "${manifest.version.replaceAll(".", "\\.")}"`));
  const kitFiles = unzipSync(new Uint8Array(await readFile(distribution.kit)));
  assert.deepEqual(kitFiles[distribution.extension.split(/[\\/]/).pop()], new Uint8Array(await readFile(distribution.extension)));
  assert.deepEqual(kitFiles["figma-local-bridge/code.js"], pluginFiles["figma-local-bridge/code.js"]);
  assert.match(decode(kitFiles["START-HERE.html"]), /Install Extension/);
  assert.match(decode(kitFiles["START-HERE.html"]), /manifest\.json/);
  assert.ok(kitFiles["SHA256SUMS.txt"]);
  const release = JSON.parse(decode(kitFiles["RELEASE.json"]));
  assert.equal(release.version, manifest.version);
  assert.equal(release.signing, "unsigned");
  assert.deepEqual(release.platforms, ["darwin"]);
  assert.ok(kitFiles["TEAM-DEPLOYMENT.md"]);
  assert.ok(kitFiles["STAFF-PILOT.md"]);
  assert.match(decode(kitFiles["START-HERE.html"]), /Work on a copy/);
  assert.match(decode(kitFiles["START-HERE.html"]), /Copy instructions for Claude/);
});

test("extracted package starts its owner, routes a simulated Figma read, blocks API access, and stops at client EOF", { timeout: 20_000 }, async (context) => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const extension = await startExtension(context, port);
  const status = await waitForStatus(base);
  assert.equal(status.bridge.processId, extension.child.pid);
  const tools = await extension.rpc.request("tools/list");
  assert.ok(tools.tools.some((tool) => tool.name === "figma_bridge_status"));
  assert.ok(!tools.tools.some((tool) => /comment/.test(tool.name)));
  const blocked = await post(base, "/v1/api-credentials/save", { token: "fake", fileKey: "fake" });
  assert.equal(blocked.status, 403);
  assert.match(await blocked.text(), /disabled/i);
  assert.equal((await post(base, "/v1/figma-rest/comments", {})).status, 403);
  const connected = await post(base, "/v1/connect", {
    clientId: "staff-file", sessionId: "staff-session", info: { label: "Marketing Campaign", documentName: "Marketing Campaign", pageId: "0:1", pageName: "Ads" },
  });
  assert.equal(connected.status, 200);
  const targets = toolJson(await extension.call("figma_list_connections")).targets;
  assert.equal(targets[0].label, "Marketing Campaign");
  const read = extension.call("figma_read_text", { targetId: "name:Marketing Campaign", nodeId: "1:1" });
  const polled = await fetch(`${base}/v1/poll?sessionId=staff-session`, { signal: AbortSignal.timeout(5_000) });
  const { command } = await polled.json();
  assert.equal(command.name, "readText");
  assert.equal(command.input.nodeId, "1:1");
  await post(base, "/v1/result", { sessionId: "staff-session", id: command.id, ok: true, result: { text: "Summer sale" } });
  assert.equal(toolJson(await read).text, "Summer sale");
  const exited = once(extension.child, "exit");
  extension.child.stdin.end();
  await exited;
  assert.equal(extension.child.exitCode, 0, extension.child.packageErrors());
  await assert.rejects(fetch(`${base}/v1/status`));
});

test("package reuses a separately managed owner and leaves it running when Claude disconnects", { timeout: 20_000 }, async (context) => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const owner = launch(context, [join(extracted, "server/launcher.mjs"), "--http-owner"], {
    PATH: process.env.PATH, ...manifest.server.mcp_config.env, FIGMA_BRIDGE_PORT: String(port), FIGMA_PREFERENCES_DIR: join(directory, `owner-${port}`),
  });
  await waitForStatus(base);
  const extension = await startExtension(context, port);
  const status = toolJson(await extension.call("figma_bridge_status"));
  assert.equal(status.bridge.processId, owner.pid);
  assert.equal(status.mcpProcess.role, "proxy");
  const exited = once(extension.child, "exit");
  extension.child.stdin.end();
  await exited;
  assert.equal((await waitForStatus(base)).bridge.processId, owner.pid);
  assert.equal(owner.exitCode, null);
});
