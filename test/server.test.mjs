import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function imageHarness(overrides = {}) {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const sandbox = {
    Buffer, URL, isIP: net.isIP,
    isAbsolute: (path) => path.startsWith("/"),
    readFile: async () => Buffer.from(onePixelPng, "base64"),
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    ...overrides,
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf("function imageMimeType("), source.indexOf("async function localizeBatchExports(")), sandbox);
  return sandbox;
}

test("image input validates one approved source and preserves local image bytes", async () => {
  const harness = await imageHarness();
  await assert.rejects(harness.localImageInput({}), /exactly one/);
  await assert.rejects(harness.localImageInput({ path: "/image.png", url: "https://example.com/image.png" }), /exactly one/);
  await assert.rejects(harness.localImageInput({ path: "image.png" }), /absolute/);
  await assert.rejects(harness.localImageInput({ url: "http://example.com/image.png" }), /HTTPS/);
  await assert.rejects(harness.localImageInput({ url: "https://user:password@example.com/image.png" }), /embedded credentials/);
  const image = await harness.localImageInput({ path: "/image.png", name: "Approved" });
  assert.equal(image.imageBase64, onePixelPng);
  assert.equal(image.sourcePath, "/image.png");
  assert.equal(image.path, undefined);
});

test("remote image validation rejects mixed public/private DNS and rechecks redirects", async () => {
  let requests = 0;
  const harness = await imageHarness({ lookup: async () => [
    { address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 },
  ] });
  harness.requestRemoteImage = async () => { requests += 1; return { redirect: "https://private.example/image.png" }; };
  await assert.rejects(harness.readRemoteImage("https://example.com/image.png"), /public IP/);
  assert.equal(requests, 0);
  harness.lookup = async (hostname) => [{ address: hostname === "private.example" ? "10.0.0.1" : "93.184.216.34", family: 4 }];
  await assert.rejects(harness.readRemoteImage("https://example.com/image.png"), /public IP/);
  assert.equal(requests, 1);
});

test("remote images redact URL queries, validate image bytes, and bound redirects", async () => {
  const harness = await imageHarness();
  harness.requestRemoteImage = async () => ({ bytes: Buffer.from(onePixelPng, "base64") });
  const image = await harness.localImageInput({ url: "https://example.com/image.png?token=private#fragment" });
  assert.equal(image.sourcePath, "https://example.com/image.png");
  assert.equal(image.imageBase64, onePixelPng);
  assert.equal(image.url, undefined);
  harness.requestRemoteImage = async () => ({ bytes: Buffer.from("not an image") });
  await assert.rejects(harness.localImageInput({ url: "https://example.com/image.png" }), /valid PNG/);
  let requests = 0;
  harness.requestRemoteImage = async () => { requests += 1; return { redirect: "/again" }; };
  await assert.rejects(harness.readRemoteImage("https://example.com/image.png"), /too many/);
  assert.equal(requests, 6);
});

test("HTTPS image transport pins validated DNS in both Node lookup modes and rejects oversized responses", async () => {
  const address = { address: "93.184.216.34", family: 4 };
  let declaredLength = Buffer.from(onePixelPng, "base64").length;
  const harness = await imageHarness({ https: { request(_url, options, respond) {
    options.lookup("example.com", { all: true }, (error, addresses) => {
      assert.equal(error, null);
      assert.equal(addresses.length, 1);
      assert.equal(addresses[0].address, address.address);
    });
    options.lookup("example.com", {}, (error, ip, family) => {
      assert.equal(error, null);
      assert.equal(ip, address.address);
      assert.equal(family, address.family);
    });
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { "content-length": String(declaredLength) };
      response.resume = () => {};
      respond(response);
      response.emit("data", Buffer.from(onePixelPng, "base64"));
      response.emit("end");
    };
    return request;
  } } });
  const result = await harness.requestRemoteImage(new URL("https://example.com/image.png"), address);
  assert.equal(result.bytes.toString("base64"), onePixelPng);
  declaredLength = 26 * 1024 * 1024;
  await assert.rejects(harness.requestRemoteImage(new URL("https://example.com/image.png"), address), /25 MB/);
});

async function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close(() => resolve(address.port));
    });
  });
}

async function waitForBridge(url) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await fetch(url);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

function rpcClient(child) {
  let buffer = "";
  let nextId = 1;
  const pending = new Map();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    }
  });

  return {
    request(method, params = {}) {
      const id = nextId;
      nextId += 1;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
  };
}

async function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function toolJson(result) {
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content[0].text);
}

test("bridge advertises and orchestrates review and copy-sync workflows", async (context) => {
  const port = await freePort();
  const commentsPort = await freePort();
  const exportDirectory = await mkdtemp(join(tmpdir(), "figma-local-bridge-test-"));
  const preferencesDirectory = await mkdtemp(join(tmpdir(), "figma-local-bridge-preferences-test-"));
  const commentRequests = [];
  const commentsApi = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) : null;
    commentRequests.push({ method: request.method, url: request.url, token: request.headers["x-figma-token"], body });
    if (request.method === "GET" && request.url === "/v1/files/test-file/comments?as_md=true") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ comments: [
        { id: "comment-1", message: "Tighten this heading", user: { id: "user-1", handle: "Reviewer" }, created_at: "2026-08-21T00:00:00Z", client_meta: { node_id: "1:1", node_offset: { x: 12, y: 16 } } },
        { id: "comment-2", parent_id: "comment-1", message: "Agreed", user: { id: "user-2", handle: "Editor" }, created_at: "2026-08-21T00:01:00Z" },
        { id: "comment-3", message: "Already fixed", resolved_at: "2026-08-21T00:02:00Z", user: { id: "user-1", handle: "Reviewer" } },
      ] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/files/test-file/comments") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "comment-new", message: body.message, parent_id: body.comment_id, user: { id: "test-user", handle: "Test user" }, client_meta: body.client_meta, created_at: "2026-08-21T00:03:00Z" }));
      return;
    }
    if (request.method === "DELETE" && request.url === "/v1/files/test-file/comments/comment-new") {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ err: "Not found" }));
  });
  await new Promise((resolve, reject) => {
    commentsApi.once("error", reject);
    commentsApi.listen(commentsPort, "127.0.0.1", resolve);
  });
  const child = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], {
    cwd: new URL("../..", import.meta.url).pathname,
    env: {
      ...process.env,
      FIGMA_BRIDGE_PORT: String(port), FIGMA_EXPORT_DIR: exportDirectory, FIGMA_PREFERENCES_DIR: preferencesDirectory,
      FIGMA_ACCESS_TOKEN: "test-token", FIGMA_FILE_KEY: "test-file", FIGMA_API_BASE_URL: `http://127.0.0.1:${commentsPort}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  context.after(async () => {
    if (child.exitCode === null) {
      child.stdin.end();
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    await rm(exportDirectory, { recursive: true, force: true });
    await rm(preferencesDirectory, { recursive: true, force: true });
    await new Promise((resolve) => commentsApi.close(resolve));
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForBridge(`${baseUrl}/health`);
  const dashboard = await fetch(`${baseUrl}/`);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Local Figma MCP Bridge/);
  const initialHttpStatus = await (await fetch(`${baseUrl}/v1/status`)).json();
  assert.equal(initialHttpStatus.connected, false);
  const rpc = rpcClient(child);
  const initialized = await rpc.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "figma-bridge-test", version: "1.0.0" },
  });
  assert.equal(initialized.serverInfo.version, "0.14.2-local.4");
  assert.match(initialized.instructions, /figma_prepare_review/);
  assert.match(initialized.instructions, /figma_apply_copy_updates/);
  rpc.notify("notifications/initialized");

  const listed = await rpc.request("tools/list");
  const toolNames = new Set(listed.tools.map((tool) => tool.name));
  for (const name of [
    "figma_prepare_review", "figma_read_copy", "figma_apply_copy_updates", "figma_set_text_frame", "figma_split_text_block",
    "figma_archive_nodes", "figma_supersede_layout", "figma_compose_frame", "figma_start_composition", "figma_operation_status", "figma_copy_style_from_node", "figma_list_page_tokens", "figma_copy_image_fill", "figma_place_local_image",
    "figma_get_user_preferences", "figma_set_user_preference", "figma_delete_user_preference", "figma_revert_user_preferences", "figma_resolve_design_choice",
    "figma_list_design_system_assets", "figma_create_component_instance", "figma_apply_design_style",
    "figma_comment_status", "figma_list_comments", "figma_post_comment", "figma_delete_comment",
    "figma_set_text_case", "figma_inspect_canvas_layout", "figma_create_section",
  ]) {
    assert.ok(toolNames.has(name), `${name} should be advertised`);
  }
  assert.equal(toolJson(await rpc.request("tools/call", { name: "figma_bridge_status", arguments: {} })).connected, false);

  const commentStatus = toolJson(await rpc.request("tools/call", { name: "figma_comment_status", arguments: {} }));
  assert.equal(commentStatus.available, true);
  assert.equal(commentStatus.fileKeySource, "FIGMA_FILE_KEY");
  const urlCommentStatus = toolJson(await rpc.request("tools/call", {
    name: "figma_comment_status",
    arguments: { fileKey: "https://www.figma.com/design/url-key/Example" },
  }));
  assert.equal(urlCommentStatus.fileKey, "url-key");
  assert.equal(urlCommentStatus.fileKeySource, "tool input");
  const comments = toolJson(await rpc.request("tools/call", { name: "figma_list_comments", arguments: {} }));
  assert.equal(comments.count, 2);
  assert.equal(comments.comments[1].parentId, "comment-1");
  const postedComment = toolJson(await rpc.request("tools/call", {
    name: "figma_post_comment",
    arguments: { message: "Please check this frame", nodeId: "1:1", x: 20, y: 30 },
  }));
  assert.equal(postedComment.comment.id, "comment-new");
  assert.deepEqual(commentRequests.at(-1).body.client_meta, { node_id: "1:1", node_offset: { x: 20, y: 30 } });
  const reply = toolJson(await rpc.request("tools/call", {
    name: "figma_post_comment",
    arguments: { message: "Updated", replyToCommentId: "comment-1" },
  }));
  assert.equal(reply.comment.parentId, "comment-1");
  assert.equal(commentRequests.at(-1).body.comment_id, "comment-1");
  const deletedComment = toolJson(await rpc.request("tools/call", {
    name: "figma_delete_comment",
    arguments: { confirmed: true, commentId: "comment-new" },
  }));
  assert.equal(deletedComment.deletedCommentId, "comment-new");
  assert.ok(commentRequests.every((request) => request.token === "test-token"));

  const initialPreferences = toolJson(await rpc.request("tools/call", { name: "figma_get_user_preferences", arguments: {} }));
  assert.equal(initialPreferences.revision, 0);
  assert.equal(initialPreferences.count, 0);
  const savedPreference = toolJson(await rpc.request("tools/call", {
    name: "figma_set_user_preference",
    arguments: {
      confirmed: true, expectedRevision: 0, designSystem: "SBS", category: "component",
      rule: "Prefer the compact SBS card for brochure summaries.", scope: { documentType: "brochure" },
      asset: { role: "summary card", componentKey: "sbs-compact-card", componentName: "Compact card" },
    },
  }));
  assert.equal(savedPreference.revision, 1);
  const stalePreferenceWrite = await rpc.request("tools/call", {
    name: "figma_set_user_preference",
    arguments: { confirmed: true, expectedRevision: 0, designSystem: "Xero", category: "general", rule: "This stale write must not land." },
  });
  assert.equal(stalePreferenceWrite.isError, true);
  assert.match(stalePreferenceWrite.content[0].text, /revision changed/i);
  const resolvedChoice = toolJson(await rpc.request("tools/call", {
    name: "figma_resolve_design_choice",
    arguments: {
      intent: "summary card", documentType: "brochure",
      candidates: [
        { candidateId: "sbs", designSystem: "SBS", assetType: "component", name: "Compact card", role: "summary card", key: "sbs-compact-card" },
        { candidateId: "xero", designSystem: "Xero", assetType: "component", name: "Summary card", role: "summary card", key: "xero-summary-card" },
      ],
    },
  }));
  assert.equal(resolvedChoice.resolved, true);
  assert.equal(resolvedChoice.selected.candidateId, "sbs");
  const tiedChoice = toolJson(await rpc.request("tools/call", {
    name: "figma_resolve_design_choice",
    arguments: {
      intent: "primary action",
      candidates: [
        { candidateId: "a", designSystem: "Alpha", assetType: "component", name: "Button" },
        { candidateId: "b", designSystem: "Beta", assetType: "component", name: "Button" },
      ],
    },
  }));
  assert.equal(tiedChoice.needsClarification, true);
  assert.equal(tiedChoice.resolved, false);

  const denied = await fetch(`${baseUrl}/v1/connect`, {
    method: "OPTIONS",
    headers: { origin: "https://untrusted.example" },
  });
  assert.equal(denied.status, 403);

  const sessionId = "test-session";
  const connected = await postJson(`${baseUrl}/v1/connect`, {
    sessionId,
    clientId: "test-client",
    info: { pluginVersion: "test", capabilities: ["composition-image-audit-v2"], editorType: "figma", pageId: "0:1", pageName: "Campaign", selectionCount: 0 },
  });
  assert.equal(connected.status, 200);
  const status = toolJson(await rpc.request("tools/call", { name: "figma_bridge_status", arguments: {} }));
  assert.equal(status.connected, true);
  assert.equal(status.plugin.pageName, "Campaign");
  assert.equal(status.mcpProcess.role, "owner");

  const proxyChild = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...process.env, FIGMA_BRIDGE_PORT: String(port), FIGMA_EXPORT_DIR: exportDirectory, FIGMA_PREFERENCES_DIR: preferencesDirectory },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let proxyStderr = "";
  proxyChild.stderr.setEncoding("utf8");
  proxyChild.stderr.on("data", (chunk) => { proxyStderr += chunk; });
  context.after(async () => {
    if (proxyChild.exitCode === null) {
      proxyChild.stdin.end();
      await Promise.race([
        new Promise((resolve) => proxyChild.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (proxyChild.exitCode === null) proxyChild.kill("SIGTERM");
    }
  });
  const proxyRpc = rpcClient(proxyChild);
  const proxyInitialized = await proxyRpc.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "figma-bridge-proxy-test", version: "1.0.0" },
  });
  assert.equal(proxyInitialized.serverInfo.version, "0.14.2-local.4");
  proxyRpc.notify("notifications/initialized");
  const proxyStatus = toolJson(await proxyRpc.request("tools/call", { name: "figma_bridge_status", arguments: {} }));
  assert.equal(proxyStatus.connected, true);
  assert.equal(proxyStatus.mcpProcess.role, "proxy");
  assert.equal(proxyStatus.mcpProcess.ownerProcessId, child.pid);

  async function serveOne(expectedName, createResult) {
    while (true) {
      const response = await fetch(`${baseUrl}/v1/poll?sessionId=${sessionId}&pageId=0%3A1&pageName=Campaign&selectionCount=0`);
      if (response.status === 204) continue;
      assert.equal(response.status, 200);
      const { command } = await response.json();
      assert.equal(command.name, expectedName);
      const result = await createResult(command);
      const posted = await postJson(`${baseUrl}/v1/result`, { sessionId, id: command.id, ok: true, result });
      assert.equal(posted.status, 204);
      return command;
    }
  }

  const textCaseWorker = serveOne("setTextCase", (command) => {
    assert.deepEqual(command.input, { nodeId: "2:1", textCase: "upper", expectedText: "Quarterly outlook" });
    return { mutatedNodeIds: ["2:1"], before: { text: "Quarterly outlook", textCase: "ORIGINAL" }, after: { text: "Quarterly outlook", textCase: "UPPER" } };
  });
  const casedText = toolJson(await rpc.request("tools/call", {
    name: "figma_set_text_case",
    arguments: { nodeId: "2:1", textCase: "upper", expectedText: "Quarterly outlook" },
  }));
  await textCaseWorker;
  assert.equal(casedText.after.text, "Quarterly outlook");
  assert.equal(casedText.after.textCase, "UPPER");

  const attributedSvg = '<svg width="10" height="10"><rect width="10" height="10" /></svg>';
  const svgWorker = serveOne("importSvg", (command) => {
    assert.equal(command.input.svg, attributedSvg);
    return { createdNodeIds: ["9:1"], node: { id: "9:1", name: "Attributed SVG", type: "FRAME" } };
  });
  const importedSvg = toolJson(await rpc.request("tools/call", {
    name: "figma_import_svg",
    arguments: { name: "Attributed SVG", svg: attributedSvg, x: 0, y: 0 },
  }));
  await svgWorker;
  assert.equal(importedSvg.node.id, "9:1");

  const scriptedSvg = await rpc.request("tools/call", {
    name: "figma_import_svg",
    arguments: { name: "Unsafe script", svg: "<svg><script>alert(1)</script></svg>", x: 0, y: 0 },
  });
  assert.equal(scriptedSvg.isError, true);
  assert.match(scriptedSvg.content[0].text, /scripts, iframes, or foreignObject/);

  const eventHandlerSvg = await rpc.request("tools/call", {
    name: "figma_import_svg",
    arguments: { name: "Unsafe event", svg: '<svg><rect onclick="alert(1)" /></svg>', x: 0, y: 0 },
  });
  assert.equal(eventHandlerSvg.isError, true);
  assert.match(eventHandlerSvg.content[0].text, /event handlers/);

  const layoutWorker = serveOne("inspectCanvasLayout", (command) => {
    assert.deepEqual(command.input, {
      proposed: { x: 900, y: 0, width: 600, height: 500 },
      ignoreNodeIds: [],
      includeHidden: false,
      limit: 250,
    });
    return {
      page: { id: "0:1", name: "Campaign" },
      contentBounds: { x: 0, y: 0, width: 800, height: 600 },
      sections: [],
      topLevelNodes: [],
      collision: { clear: true, overlapCount: 0, overlaps: [] },
    };
  });
  const inspectedLayout = toolJson(await rpc.request("tools/call", {
    name: "figma_inspect_canvas_layout",
    arguments: { proposed: { x: 900, y: 0, width: 600, height: 500 } },
  }));
  await layoutWorker;
  assert.equal(inspectedLayout.collision.clear, true);

  const sectionWorker = serveOne("createSection", (command) => {
    assert.deepEqual(command.input, {
      name: "Reference board",
      width: 600,
      height: 500,
      x: 900,
      y: 0,
      collisionPolicy: "reject",
    });
    return {
      createdNodeIds: ["10:1"],
      section: { id: "10:1", name: "Reference board", type: "SECTION" },
      placement: { clear: true, overlapCount: 0, overlaps: [] },
    };
  });
  const createdSection = toolJson(await rpc.request("tools/call", {
    name: "figma_create_section",
    arguments: { name: "Reference board", width: 600, height: 500, x: 900, y: 0 },
  }));
  await sectionWorker;
  assert.equal(createdSection.section.type, "SECTION");

  const commandNames = [];
  const fakePlugin = (async () => {
    for (let handled = 0; handled < 3;) {
      const response = await fetch(`${baseUrl}/v1/poll?sessionId=${sessionId}&pageId=0%3A1&pageName=Campaign&selectionCount=0`);
      if (response.status === 204) continue;
      assert.equal(response.status, 200);
      const { command } = await response.json();
      commandNames.push(command.name);
      let result;
      if (command.name === "prepareReviewData") {
        assert.deepEqual(command.input, { nodeIds: ["1:1", "1:2"], detail: "summary", auditOverflow: true, auditLayout: false, auditPaints: false });
        result = {
          content: { page: { id: "0:1", name: "Campaign" }, frameCount: 2, frames: [], copy: "Left\n\nRight" },
          overflowAudits: ["1:1", "1:2"].map((id) => ({ frame: { id }, textCount: 0, warningCount: 0, text: [] })),
        };
      } else if (command.name === "exportFramePng") {
        result = { imageBase64: onePixelPng, mimeType: "image/png", nodeId: command.input.nodeId, nodeName: `Frame ${command.input.nodeId}`, width: 1, height: 1 };
      } else {
        throw new Error(`Unexpected command ${command.name}`);
      }
      const posted = await postJson(`${baseUrl}/v1/result`, { sessionId, id: command.id, ok: true, result });
      assert.equal(posted.status, 204);
      handled += 1;
    }
  })();

  const prepared = toolJson(await rpc.request("tools/call", {
    name: "figma_prepare_review",
    arguments: { nodeIds: ["1:1", "1:2"], auditOverflow: true, maxDimension: 1_024, scale: 1 },
  }));
  await fakePlugin;
  assert.deepEqual(commandNames, ["prepareReviewData", "exportFramePng", "exportFramePng"]);
  assert.equal(prepared.content.copy, "Left\n\nRight");
  assert.equal(prepared.exports.length, 2);
  assert.equal(prepared.overflowAudits.length, 2);
  for (const exported of prepared.exports) {
    const bytes = await readFile(exported.path);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }

  const summaryWorker = serveOne("readFrameContent", (command) => {
    assert.deepEqual(command.input, { nodeId: "1:1", detail: "summary", includeHidden: false, auditLayout: false, auditPaints: false });
    return { frame: { id: "1:1", name: "Left" }, textCount: 1, excludedHiddenTextCount: 0, text: [{ id: "2:1", copy: "Visible", bounds: { x: 1, y: 1, width: 50, height: 10 }, fontSizes: [16], effectiveVisible: true }], copy: "Visible" };
  });
  const summary = toolJson(await rpc.request("tools/call", {
    name: "figma_read_frame_content",
    arguments: { nodeId: "1:1" },
  }));
  await summaryWorker;
  assert.equal(summary.copy, "Visible");
  assert.equal(summary.text[0].hierarchy, undefined);

  const composeWorker = serveOne("composeFrame", (command) => {
    assert.equal(command.input.elements[1].spans[0].fontStyle, "Bold");
    assert.equal(command.input.elements[1].spans[0].textCase, "upper");
    assert.equal(command.input.audit, true);
    assert.equal(command.input.export, true);
    return {
      createdNodeIds: ["7:1", "7:2", "7:3"],
      frame: { id: "7:1", name: "Replacement" },
      imageAudit: { requiredCount: 0, filledCount: 0, warningCount: 0, warnings: [] },
      elements: [{ key: "panel", id: "7:2" }, { key: "copy", id: "7:3" }],
      audits: [{ frameId: "7:1", result: { frame: { id: "7:1" }, warningCount: 0, text: [] } }],
      exports: [{ frameId: "7:1", result: { imageBase64: onePixelPng, mimeType: "image/png", nodeId: "7:1", nodeName: "Replacement", width: 1, height: 1 } }],
      verificationComplete: true,
    };
  });
  const composed = toolJson(await rpc.request("tools/call", {
    name: "figma_compose_frame",
    arguments: {
      frame: { name: "Replacement", width: 300, height: 400, x: 0, y: 0, fillColor: "#FFFFFF" },
      elements: [
        { type: "frame", key: "panel", name: "Panel", width: 260, height: 100, x: 20, y: 20, fillColor: "#EEEEEE" },
        { type: "text", key: "copy", parentKey: "panel", text: "Heading\nBody", x: 12, y: 12, width: 236, spans: [{ start: 0, end: 7, fontStyle: "Bold", textCase: "upper" }] },
      ],
    },
  }));
  await composeWorker;
  assert.match(composed.operationId, /^[0-9a-f-]{36}$/);
  assert.equal(composed.verificationComplete, true);
  assert.equal(composed.exports[0].result.imageBase64, undefined);
  const composePng = await readFile(composed.exports[0].result.path);
  assert.deepEqual([...composePng.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const emptyComposeWorker = serveOne("composeFrame", () => ({}));
  const emptyCompose = await rpc.request("tools/call", {
    name: "figma_compose_frame",
    arguments: {
      frame: { name: "Empty response test", width: 300, height: 200, x: 800, y: 0 },
      elements: [{ type: "rectangle", key: "panel", name: "Panel", width: 280, height: 180, x: 10, y: 10 }],
      audit: false,
      export: false,
    },
  });
  await emptyComposeWorker;
  assert.equal(emptyCompose.isError, true);
  const emptyComposeError = JSON.parse(emptyCompose.content[0].text);
  assert.equal(emptyComposeError.ok, false);
  assert.equal(emptyComposeError.error.code, "COMPOSITION_EMPTY_OR_INCOMPLETE");

  const trackedArguments = {
    frame: { name: "Tracked board", width: 320, height: 220, x: 1_200, y: 0 },
    elements: [{ type: "rectangle", key: "photo", name: "Required photo", width: 280, height: 160, x: 20, y: 20, imageRequired: true }],
    audit: false,
    export: false,
  };
  const startedComposition = toolJson(await rpc.request("tools/call", { name: "figma_start_composition", arguments: trackedArguments }));
  assert.equal(startedComposition.state, "queued");
  assert.match(startedComposition.operationId, /^[0-9a-f-]{36}$/);
  const trackedPoll = await fetch(`${baseUrl}/v1/poll?sessionId=${sessionId}&pageId=0%3A1&pageName=Campaign&selectionCount=0`);
  assert.equal(trackedPoll.status, 200);
  const trackedCommand = (await trackedPoll.json()).command;
  assert.equal(trackedCommand.name, "composeFrame");
  assert.equal(trackedCommand.id, startedComposition.operationId);
  const progressResponse = await postJson(`${baseUrl}/v1/progress`, {
    sessionId,
    id: trackedCommand.id,
    progress: { phase: "elements", message: "Creating Required photo.", current: 55, total: 100, percent: 55 },
  });
  assert.equal(progressResponse.status, 204);
  const runningComposition = toolJson(await rpc.request("tools/call", {
    name: "figma_operation_status",
    arguments: { operationId: startedComposition.operationId },
  }));
  assert.equal(runningComposition.state, "running");
  assert.equal(runningComposition.progress.percent, 55);
  const trackedResult = {
    ok: true,
    createdNodeIds: ["11:1", "11:2"],
    frame: { id: "11:1", name: "Tracked board" },
    elements: [{ key: "photo", id: "11:2", name: "Required photo", type: "RECTANGLE" }],
    audits: [],
    imageAudit: { requiredCount: 1, filledCount: 0, warningCount: 1, warnings: [{ key: "photo", nodeId: "11:2", warning: "Required image area has no image fill." }] },
    exports: [],
    verificationComplete: false,
  };
  const trackedResultResponse = await postJson(`${baseUrl}/v1/result`, { sessionId, id: trackedCommand.id, ok: true, result: trackedResult });
  assert.equal(trackedResultResponse.status, 204);
  const completedComposition = toolJson(await rpc.request("tools/call", {
    name: "figma_operation_status",
    arguments: { operationId: startedComposition.operationId },
  }));
  assert.equal(completedComposition.state, "succeeded");
  assert.equal(completedComposition.result.verificationComplete, false);
  assert.equal(completedComposition.result.imageAudit.warningCount, 1);
  const resumedComposition = toolJson(await rpc.request("tools/call", {
    name: "figma_start_composition",
    arguments: { operationId: startedComposition.operationId, ...trackedArguments },
  }));
  assert.equal(resumedComposition.state, "succeeded");

  const approvedImagePath = join(exportDirectory, "approved.png");
  await writeFile(approvedImagePath, Buffer.from(onePixelPng, "base64"));
  const imageWorker = serveOne("placeLocalImage", (command) => {
    assert.equal(command.input.sourcePath, approvedImagePath);
    assert.equal(command.input.mimeType, "image/png");
    assert.equal(command.input.imageBase64, onePixelPng);
    return { createdNodeIds: ["8:1"], node: { id: "8:1", name: "Approved photo", type: "RECTANGLE" }, source: { path: approvedImagePath, mimeType: "image/png" }, image: { scaleMode: "FILL" } };
  });
  const placedImage = toolJson(await rpc.request("tools/call", {
    name: "figma_place_local_image",
    arguments: { path: approvedImagePath, name: "Approved photo", width: 300, height: 200, x: 0, y: 0 },
  }));
  await imageWorker;
  assert.equal(placedImage.node.id, "8:1");

  const compactWorker = serveOne("readCopy", (command) => {
    assert.deepEqual(command.input, { nodeIds: ["1:1"], includeHidden: false });
    return {
      page: { id: "0:1", name: "Campaign" },
      includeHidden: false,
      frameCount: 1,
      excludedHiddenTextCount: 1,
      frames: [{ frame: { id: "1:1", name: "Left", bounds: { x: 0, y: 0, width: 100, height: 100 } }, textCount: 1, excludedHiddenTextCount: 1, text: [{ id: "2:1", copy: "Visible", bounds: { x: 1, y: 1, width: 50, height: 10 }, visible: true, opacity: 1, effectiveOpacity: 1, effectiveVisible: true }], copy: "Visible" }],
      copy: "Visible",
    };
  });
  const compact = toolJson(await proxyRpc.request("tools/call", {
    name: "figma_read_copy",
    arguments: { nodeIds: ["1:1"] },
  }));
  await compactWorker;
  assert.equal(compact.copy, "Visible");
  assert.equal(compact.excludedHiddenTextCount, 1);

  const batchWorker = serveOne("applyCopyUpdates", (command) => {
    assert.equal(command.input.includeHidden, false);
    assert.equal(command.input.updates[0].expectedText, "Visible");
    return {
      mutatedNodeIds: ["2:1"],
      updates: [{ nodeId: "2:1", before: "Visible", after: "Updated", changed: true, styleStrategy: "minimal-range" }],
      audits: [{ frameId: "1:1", result: { frame: { id: "1:1" }, includeHidden: false, textCount: 1, skippedHiddenTextCount: 1, warningCount: 0, text: [] } }],
      exports: [{ frameId: "1:1", result: { imageBase64: onePixelPng, mimeType: "image/png", nodeId: "1:1", nodeName: "Left", width: 1, height: 1 } }],
      verificationComplete: true,
    };
  });
  const applied = toolJson(await rpc.request("tools/call", {
    name: "figma_apply_copy_updates",
    arguments: {
      updates: [{ nodeId: "2:1", text: "Updated", expectedText: "Visible" }],
      auditFrames: ["1:1"],
      exportFrames: ["1:1"],
    },
  }));
  await batchWorker;
  assert.equal(applied.verificationComplete, true);
  assert.equal(applied.audits[0].result.skippedHiddenTextCount, 1);
  assert.equal(applied.exports[0].result.imageBase64, undefined);
  const batchPng = await readFile(applied.exports[0].result.path);
  assert.deepEqual([...batchPng.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const displacedPoll = fetch(`${baseUrl}/v1/poll?sessionId=${sessionId}&pageId=0%3A1&pageName=Campaign&selectionCount=0`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const takeover = await postJson(`${baseUrl}/v1/connect`, {
    sessionId: "replacement-session",
    clientId: "test-client",
    info: { pluginVersion: "test", editorType: "figma", pageId: "0:2", pageName: "Review", selectionCount: 1 },
  });
  assert.equal(takeover.status, 200);
  assert.equal((await displacedPoll).status, 409);
  const replacementStatus = toolJson(await rpc.request("tools/call", { name: "figma_bridge_status", arguments: {} }));
  assert.equal(replacementStatus.plugin.pageName, "Review");
  assert.equal(replacementStatus.plugin.selectionCount, 1);

  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
  let failoverHttpStatus;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/v1/status`);
      if (response.ok) {
        const candidate = await response.json();
        if (candidate.bridge.processId === proxyChild.pid) {
          failoverHttpStatus = candidate;
          break;
        }
      }
    } catch {
      // The port is briefly unavailable while the proxy is taking ownership.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(failoverHttpStatus?.bridge.role, "owner");
  const failoverMcpStatus = toolJson(await proxyRpc.request("tools/call", { name: "figma_bridge_status", arguments: {} }));
  assert.equal(failoverMcpStatus.connected, false);
  assert.equal(failoverMcpStatus.mcpProcess.role, "owner");
  assert.equal(stderr, "");
  assert.equal(proxyStderr, "");
});

// Execute the actual transport handlers with controlled timers and no listening socket.
async function commandHarness() {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const session = { clientId: "target-test", sessionId: "test", info: { capabilities: ["composition-image-audit-v2"] }, queue: [], pending: new Map(), poll: null, lease: null, leaseWaiters: [] };
  const timers = new Map();
  let nextId = 0;
  let handler;
  const sandbox = {
    URL, apiDisabled: false, bridgeBaseUrl: "http://127.0.0.1",
    connectedSession: () => session, checkTargetLease() {}, pumpTargetLease() {},
    isLoopbackHost: () => true, isJsonRequest: () => true,
    http: { createServer(callback) { handler = callback; } },
    host: "127.0.0.1", port: 0,
    operations: new Map(), targetFences: new Map(), leaseDurationMs: 15_000,
    sessions: new Map([["test", session]]),
    replacedSessions: new Map(),
    compositionImageCapability: "composition-image-audit-v2",
    operationRetentionMs: 60 * 60_000,
    operationHardTimeoutMs: 30 * 60_000,
    activeSessions: () => [session],
    getSession: () => session,
    updateSession() {},
    cleanString: (value, maxLength = 200) => typeof value === "string" ? value.trim().slice(0, maxLength) : undefined,
    requireCompositionResult: (data) => data,
    localizeBatchExports: async (data) => data,
    isAllowedBrowserOrigin: () => true,
    readJson: async (request) => request.body,
    randomUUID: () => `command-${++nextId}`,
    setTimeout(callback) { const token = ++nextId; timers.set(token, callback); return token; },
    clearTimeout: (token) => timers.delete(token),
    json(response, status, body) { response.status = status; response.body = body; },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    source.slice(source.indexOf("function fenceTarget("), source.indexOf("const statusPage =")) +
    source.slice(source.indexOf("function rejectSession("), source.indexOf("function activeSessions(")) +
    source.slice(source.indexOf("function cleanOperations("), source.indexOf("function addSession(")) +
    source.slice(source.indexOf("const bridge = http.createServer("), source.indexOf("async function ownerRequest(")), sandbox,
  );
  return {
    session, fence: () => sandbox.targetFences.get(session.clientId),
    acquire: () => sandbox.acquireTargetLease(session.clientId, session.sessionId),
    send: () => sandbox.sendLocalCommand("mutate", {}, 1_000),
    sendTracked: (options = {}) => sandbox.sendTrackedLocalCommand("composeFrame", { elements: [{}] }, { timeoutMs: 1_000, ...options }),
    operationStatus: (operationId) => sandbox.operationSnapshot(sandbox.getOperation(operationId), true),
    replaceSession: () => sandbox.rejectSession(session, "Session replaced.", 409, true),
    expire() {
      const [token, callback] = timers.entries().next().value;
      timers.delete(token);
      callback();
    },
    expireLatest() {
      const [token, callback] = [...timers.entries()].at(-1);
      timers.delete(token);
      callback();
    },
    completePoll: () => sandbox.completePoll(session),
    async request(method, url, body) {
      const response = { once() {} };
      await handler({ method, url, body, headers: {}, once() {} }, response);
      return response;
    },
  };
}

test("queued timeout removes the command before polling resumes", async () => {
  const harness = await commandHarness();
  const result = harness.send();
  const rejected = assert.rejects(result, /Figma did not respond/i);
  harness.expire();
  await rejected;
  assert.equal(harness.session.queue.length, 0);
  const poll = await harness.request("GET", "/v1/poll?sessionId=test");
  assert.equal(poll.body, undefined);
  assert.ok(harness.session.poll);
});

for (const delivery of ["immediate", "waiting"]) {
  test(`${delivery} poll skips stale entries and delivers live commands once in order`, async () => {
    const harness = await commandHarness();
    harness.session.queue.push({ id: "stale", name: "mutate", input: {} });
    const first = harness.send();
    const second = harness.send();
    let poll;
    if (delivery === "immediate") {
      poll = await harness.request("GET", "/v1/poll?sessionId=test");
    } else {
      poll = {};
      harness.session.poll = { response: poll, timeout: null };
      harness.completePoll();
    }
    assert.equal(poll.body.command.id, "command-1");
    const secondPoll = await harness.request("GET", "/v1/poll?sessionId=test");
    assert.equal(secondPoll.body.command.id, "command-3");
    for (const command of [poll.body.command, secondPoll.body.command]) {
      const response = await harness.request("POST", "/v1/result", { sessionId: "test", id: command.id, ok: true, result: command.id });
      assert.equal(response.status, 204);
    }
    assert.deepEqual(await Promise.all([first, second]), ["command-1", "command-3"]);
    const emptyPoll = await harness.request("GET", "/v1/poll?sessionId=test");
    assert.equal(emptyPoll.body, undefined);
  });
}

test("waiting poll preserves ordinary success and clears its command timeout", async () => {
  const harness = await commandHarness();
  const poll = await harness.request("GET", "/v1/poll?sessionId=test");
  const result = harness.send();
  assert.equal(poll.status, 200);
  const response = await harness.request("POST", "/v1/result", { id: poll.body.command.id, ok: true, result: { changed: true } });
  assert.equal(response.status, 204);
  assert.deepEqual(await result, { changed: true });
  assert.equal(harness.session.pending.size, 0);
  assert.equal(harness.session.queue.length, 0);
});

test("dispatched timeout reports an unknown outcome and ignores a late result", async () => {
  const harness = await commandHarness();
  const result = harness.send();
  const poll = await harness.request("GET", "/v1/poll?sessionId=test");
  const rejected = assert.rejects(result, /outcome is unknown.*re-read.*before retrying/i);
  harness.expire();
  await rejected;
  const late = await harness.request("POST", "/v1/result", { id: poll.body.command.id, ok: true, result: { changed: true } });
  assert.equal(late.status, 204);
  assert.equal(harness.fence(), undefined);
  assert.equal(harness.session.pending.size, 0);
  assert.equal(harness.session.queue.length, 0);
});

test("tracked composition wait timeout preserves progress and accepts a late result", async () => {
  const harness = await commandHarness();
  const result = harness.sendTracked();
  const poll = await harness.request("GET", "/v1/poll?sessionId=test");
  const operationId = poll.body.command.id;
  const rejected = assert.rejects(result, new RegExp(`operation ${operationId} is still running.*figma_operation_status`, "i"));
  harness.expireLatest();
  await rejected;
  assert.equal(harness.operationStatus(operationId).state, "running");
  const progress = await harness.request("POST", "/v1/progress", { sessionId: "test", id: operationId, progress: { phase: "export", message: "Exporting preview.", percent: 88 } });
  assert.equal(progress.status, 204);
  assert.equal(harness.operationStatus(operationId).progress.percent, 88);
  const late = await harness.request("POST", "/v1/result", { sessionId: "test", id: operationId, ok: true, result: { frame: { id: "1:1" } } });
  assert.equal(late.status, 204);
  assert.equal(harness.operationStatus(operationId).state, "succeeded");
  assert.equal(harness.operationStatus(operationId).result.frame.id, "1:1");
  assert.equal(harness.session.pending.size, 0);
});

test("tracked compositions reject an old plugin before queueing any mutation", async () => {
  const harness = await commandHarness();
  harness.session.info = { pluginVersion: "0.13.4" };
  await assert.rejects(harness.sendTracked({ waitForCompletion: false }), /reload.*updated.*plugin/i);
  assert.equal(harness.session.pending.size, 0);
  assert.equal(harness.session.queue.length, 0);
});

for (const dispatched of [false, true]) {
  test(`session replacement marks ${dispatched ? "dispatched" : "queued"} tracked work ${dispatched ? "unknown" : "failed"}`, async () => {
    const harness = await commandHarness();
    const started = await harness.sendTracked({ waitForCompletion: false });
    if (dispatched) await harness.request("GET", "/v1/poll?sessionId=test");
    harness.replaceSession();
    const status = harness.operationStatus(started.operationId);
    assert.equal(status.state, dispatched ? "unknown" : "failed");
    assert.match(status.error, dispatched ? /inspect.*document before retrying/i : /not dispatched/i);
    assert.equal(harness.session.pending.size, 0);
    assert.equal(harness.session.queue.length, 0);
  });
}

test("a proxy refuses an old owner before sending a tracked command", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  for (const compatible of [false, true]) {
    const requests = [];
    const sandbox = {
      targetContext: { getStore: () => undefined }, commandRouting: () => ({}),
      initialBridgeRole: Promise.resolve(), bridgeRole: "proxy",
      trackedCompositionCapability: "tracked-composition-v1",
      async ownerRequest(path, options) {
        requests.push({ path, options });
        if (path === "/v1/status") return { bridge: { version: compatible ? "0.14.0" : "0.13.4", capabilities: compatible ? ["tracked-composition-v1"] : undefined } };
        return { result: { operationId: "same-id", state: "queued" }, operation: { state: "running" } };
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(source.slice(source.indexOf("async function sendTrackedCommand("), source.indexOf("function output(")), sandbox);
    if (!compatible) {
      await assert.rejects(sandbox.sendTrackedCommand("composeFrame", {}, { operationId: "same-id", waitForCompletion: false }), /restart.*updated build.*no command was sent/i);
      await assert.rejects(sandbox.operationStatusForMcp("same-id", true), /restart/i);
      assert.ok(requests.every((request) => request.path === "/v1/status"));
    } else {
      for (let retry = 0; retry < 2; retry++) await sandbox.sendTrackedCommand("composeFrame", {}, { operationId: "same-id", waitForCompletion: false });
      const commands = requests.filter((request) => request.path === "/v1/mcp-command");
      assert.equal(commands.length, 2);
      assert.ok(commands.every((request) => JSON.parse(request.options.body).operationId === "same-id"));
      assert.equal((await sandbox.operationStatusForMcp("same-id", true)).state, "running");
    }
  }
});

test("a lost owner reply retains the recovery ID and retry does not enqueue a duplicate", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  for (const waitForCompletion of [false, true]) {
    const owner = await commandHarness();
    let loseReply = true;
    let generatedIds = 0;
    const sandbox = {
      targetContext: { getStore: () => undefined }, commandRouting: () => ({}),
      initialBridgeRole: Promise.resolve(), bridgeRole: "proxy", trackedCompositionCapability: "tracked-composition-v1",
      randomUUID: () => `recovery-${++generatedIds}`,
      async ownerRequest(path, options) {
        if (path === "/v1/status") return { bridge: { capabilities: ["tracked-composition-v1"] } };
        const body = JSON.parse(options.body);
        if (path === "/v1/mcp-operation-status") return { operation: owner.operationStatus(body.operationId) };
        const result = await owner.sendTracked({ operationId: body.operationId, waitForCompletion: false });
        if (loseReply) { loseReply = false; throw new Error("Owner response lost"); }
        return { result };
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(source.slice(source.indexOf("async function sendTrackedCommand("), source.indexOf("function output(")), sandbox);
    let recoveryId;
    await assert.rejects(sandbox.sendTrackedCommand("composeFrame", { elements: [{}] }, { waitForCompletion }), (error) => {
      assert.equal(error.message, "Owner response lost");
      recoveryId = error.operationId;
      assert.equal(recoveryId, "recovery-1");
      return true;
    });
    const retry = await sandbox.sendTrackedCommand("composeFrame", { elements: [{}] }, { waitForCompletion, operationId: recoveryId });
    assert.equal(retry.operationId, recoveryId);
    assert.equal(owner.session.queue.length, 1);
    assert.equal((await sandbox.operationStatusForMcp(recoveryId, true)).state, "queued");
    owner.replaceSession();
  }
});

test("both composition tools include recovery IDs in their error output", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const callbacks = new Map();
  const sandbox = {
    server: { registerTool(name, _schema, callback) { callbacks.set(name, callback); } },
    compositionInputSchema: {},
    requireCompositionResult: (value) => value,
    output: (value) => value,
    compositionCommandInput: (input) => ({ operationId: input.operationId, commandInput: input }),
    async sendTrackedCommand() { const error = new Error("Reply lost"); error.operationId = "known-operation"; throw error; },
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf("function structuredFailure("), source.indexOf("function requireCompositionResult("))
    + source.slice(source.indexOf('server.registerTool("figma_compose_frame"'), source.indexOf('server.registerTool("figma_copy_style_from_node"')), sandbox);
  for (const callback of callbacks.values()) {
    const result = await callback({ elements: [{}] });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error.operationId, "known-operation");
  }
  assert.equal(callbacks.size, 2);
});

test("composition completion requires consistent image audit evidence", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf("function requireCompositionResult("), source.indexOf("const nodeId =")), sandbox);
  const base = { frame: { id: "root" }, createdNodeIds: ["root", "photo"], elements: [{ key: "photo", id: "photo" }], verificationComplete: true };
  assert.throws(() => sandbox.requireCompositionResult(base, 1, 1), /image audit evidence/);
  assert.throws(() => sandbox.requireCompositionResult({ ...base, imageAudit: { requiredCount: 0, filledCount: 0, warningCount: 0, warnings: [] } }, 1, 1), /image audit evidence/);
  const imageAudit = { requiredCount: 1, filledCount: 0, warningCount: 1, warnings: [{}] };
  assert.throws(() => sandbox.requireCompositionResult({ ...base, imageAudit }, 1, 1), /image audit evidence/);
  assert.throws(() => sandbox.requireCompositionResult({ ...base, verificationComplete: false, imageAudit, archived: {} }, 1, 1), /image audit evidence/);
  assert.equal(sandbox.requireCompositionResult({ ...base, verificationComplete: false, imageAudit }, 1, 1).verificationComplete, false);
});

async function isolatedBridge(context, mode = "--http-owner", overrides = {}) {
  const port = await freePort();
  const directory = await mkdtemp(join(tmpdir(), "figma-multi-target-"));
  const children = [];
  const env = { ...process.env, FIGMA_BRIDGE_HOST: "127.0.0.1", FIGMA_BRIDGE_PORT: String(port), FIGMA_BRIDGE_API_DISABLED: "1", FIGMA_CREDENTIAL_BACKEND: "memory", FIGMA_PREFERENCES_DIR: directory, FIGMA_EXPORT_DIR: directory, ...overrides };
  const launch = (args = [mode], childEnv = {}) => {
    const child = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname, ...args], { env: { ...env, ...childEnv }, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", () => {});
    children.push(child);
    return child;
  };
  context.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.all(children.map((child) => child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve))));
    await rm(directory, { recursive: true, force: true });
  });
  const owner = launch();
  const base = `http://127.0.0.1:${port}`;
  await waitForBridge(`${base}/v1/status`);
  async function proxy(pin) {
    const child = launch(["--proxy-only"], { FIGMA_BRIDGE_TARGET: pin || "" });
    const rpc = rpcClient(child);
    await rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "multi-target-test", version: "1" } });
    rpc.notify("notifications/initialized");
    return { child, rpc, call: (name, args) => rpc.request("tools/call", { name, arguments: args }) };
  }
  const connect = async (clientId, sessionId, label) => {
    const response = await postJson(`${base}/v1/connect`, { clientId, sessionId, info: { label, documentName: label, pageId: "0:1", pageName: "Identical page", capabilities: ["composition-image-audit-v2"] } });
    assert.equal(response.status, 200);
  };
  async function receive(sessionId, expectedTarget) {
    const response = await fetch(`${base}/v1/poll?sessionId=${sessionId}`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200);
    const { command } = await response.json();
    assert.equal(command.targetId, expectedTarget);
    return command;
  }
  async function reply(sessionId, command, result) {
    const response = await postJson(`${base}/v1/result`, { sessionId, id: command.id, ok: true, result });
    assert.equal(response.status, 204);
  }
  return { owner, base, env, proxy, launch, connect, receive, reply };
}

test("HTTP owner survives client EOF and proxies route two identical-node files without takeover", { timeout: 20_000 }, async (context) => {
  const h = await isolatedBridge(context);
  h.owner.stdin.end();
  await h.connect("alpha", "alpha-1", "Alpha document");
  await h.connect("beta", "beta-1", "Beta document");
  const a = await h.proxy();
  const b = await h.proxy("beta");
  const targets = toolJson(await a.call("figma_list_connections", {})).targets;
  assert.deepEqual(targets.map((target) => target.targetId), ["alpha", "beta"]);
  assert.equal(targets[0].label, "Alpha document");
  const ambiguous = await a.call("figma_read_text", { nodeId: "1:1" });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.content[0].text, /targetId/);
  const callA = a.call("figma_read_text", { targetId: "alpha", nodeId: "1:1", operationId: "read-alpha" });
  const callB = b.call("figma_read_text", { nodeId: "1:1", operationId: "read-beta" });
  const [commandA, commandB] = await Promise.all([h.receive("alpha-1", "alpha"), h.receive("beta-1", "beta")]);
  assert.equal(commandA.input.nodeId, commandB.input.nodeId);
  await h.reply("alpha-1", commandA, { text: "Alpha" });
  await h.reply("beta-1", commandB, { text: "Beta" });
  assert.equal(toolJson(await callA).text, "Alpha");
  assert.equal(toolJson(await callB).text, "Beta");
  a.child.stdin.end();
  await new Promise((resolve) => a.child.once("exit", resolve));
  const status = await (await fetch(`${h.base}/v1/status`)).json();
  assert.equal(status.bridge.processId, h.owner.pid);
  assert.equal(status.activePluginCount, 2);
  assert.equal(status.targets.length, 2);
});

test("operation IDs are target-bound and retries recover one mutation; old sessions cannot deliver results", { timeout: 20_000 }, async (context) => {
  const h = await isolatedBridge(context);
  await h.connect("alpha", "alpha-1", "Alpha");
  await h.connect("beta", "beta-1", "Beta");
  const a = await h.proxy();
  const args = { targetId: "alpha", nodeId: "1:1", text: "Changed", operationId: "one-edit" };
  const call = a.call("figma_update_text", args);
  const command = await h.receive("alpha-1", "alpha");
  await h.reply("alpha-1", command, { mutatedNodeIds: ["1:1"], text: "Changed" });
  const first = toolJson(await call);
  const retried = toolJson(await a.call("figma_update_text", args));
  assert.deepEqual(retried, first);
  const wrongTarget = await a.call("figma_update_text", { ...args, targetId: "beta" });
  assert.equal(wrongTarget.isError, true);
  assert.match(wrongTarget.content[0].text, /different request/);
  const wrongInput = await a.call("figma_update_text", { ...args, text: "Different" });
  assert.equal(wrongInput.isError, true);
  const pending = await (await fetch(`${h.base}/v1/targets`)).json();
  assert.ok(pending.targets.every((target) => target.pendingCommandCount === 0));
  await h.connect("alpha", "alpha-2", "Alpha reconnected");
  assert.equal((await fetch(`${h.base}/v1/poll?sessionId=alpha-1`)).status, 409);
  assert.equal((await postJson(`${h.base}/v1/result`, { sessionId: "alpha-1", id: command.id, ok: true, result: {} })).status, 409);
  assert.equal((await postJson(`${h.base}/v1/lease/acquire`, { targetId: "alpha", sessionId: "alpha-1" })).status, 400);
  assert.equal((await postJson(`${h.base}/v1/heartbeat`, { sessionId: "beta-1", info: {} })).status, 204);
});

test("a target lease spans a logical call and blocks competing agents while another target remains usable", { timeout: 20_000 }, async (context) => {
  const h = await isolatedBridge(context);
  await h.connect("alpha", "alpha-1", "Alpha"); await h.connect("beta", "beta-1", "Beta");
  const a = await h.proxy(); const b = await h.proxy();
  const lease = await (await postJson(`${h.base}/v1/lease/acquire`, { targetId: "alpha", sessionId: "alpha-1" })).json();
  assert.ok(lease.leaseId);
  const waiting = a.call("figma_read_text", { targetId: "alpha", nodeId: "1:1" });
  const unrelated = b.call("figma_read_text", { targetId: "beta", nodeId: "1:1" });
  const betaCommand = await h.receive("beta-1", "beta");
  await h.reply("beta-1", betaCommand, { text: "Beta" });
  assert.equal(toolJson(await unrelated).text, "Beta");
  const blocked = await postJson(`${h.base}/v1/mcp-command`, { name: "updateText", input: {}, targetId: "alpha", sessionId: "alpha-1" });
  assert.equal(blocked.status, 400);
  assert.match((await blocked.json()).error, /reserved/);
  const targetState = (await (await fetch(`${h.base}/v1/targets`)).json()).targets.find((target) => target.targetId === "alpha");
  assert.equal(targetState.pendingCommandCount, 0);
  await postJson(`${h.base}/v1/lease/release`, lease);
  const alphaCommand = await h.receive("alpha-1", "alpha");
  await h.reply("alpha-1", alphaCommand, { text: "Alpha" });
  assert.equal(toolJson(await waiting).text, "Alpha");
});

test("owner rejects nonloopback configuration and proxy-only never elects itself", { timeout: 10_000 }, async (context) => {
  const port = await freePort();
  const script = new URL("../server.mjs", import.meta.url).pathname;
  const invalid = spawn(process.execPath, [script, "--http-owner"], { env: { ...process.env, FIGMA_BRIDGE_HOST: "0.0.0.0", FIGMA_BRIDGE_PORT: String(port) }, stdio: ["ignore", "ignore", "pipe"] });
  let error = ""; invalid.stderr.on("data", (chunk) => { error += chunk; });
  assert.equal(await new Promise((resolve) => invalid.once("exit", resolve)), 1);
  assert.match(error, /loopback/);
  const proxy = spawn(process.execPath, [script, "--proxy-only"], { env: { ...process.env, FIGMA_BRIDGE_HOST: "127.0.0.1", FIGMA_BRIDGE_PORT: String(port), FIGMA_BRIDGE_API_DISABLED: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  context.after(() => { if (proxy.exitCode === null) proxy.kill("SIGTERM"); });
  proxy.stderr.on("data", () => {});
  const rpc = rpcClient(proxy);
  await rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "proxy-no-owner-test", version: "1" } });
  rpc.notify("notifications/initialized");
  const result = await rpc.request("tools/call", { name: "figma_bridge_status", arguments: {} });
  assert.equal(result.isError, true);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/status`));
  proxy.stdin.end();
  await new Promise((resolve) => proxy.once("exit", resolve));
});

test("a review composite pins its target and holds its lease through every export", { timeout: 15_000 }, async (context) => {
  const h = await isolatedBridge(context);
  await h.connect("alpha", "alpha-1", "Alpha");
  await h.connect("beta", "beta-1", "Beta");
  const a = await h.proxy(); const b = await h.proxy();
  const review = a.call("figma_prepare_review", { targetId: "alpha", nodeIds: ["1:1", "1:2"], operationId: "review-one" });
  const prepare = await h.receive("alpha-1", "alpha");
  assert.equal(prepare.name, "prepareReviewData");
  const competing = b.call("figma_read_text", { targetId: "alpha", nodeId: "1:1", operationId: "competing-read" });
  await h.reply("alpha-1", prepare, { content: { frames: [], copy: "Alpha" }, overflowAudits: [] });
  for (const nodeId of ["1:1", "1:2"]) {
    const command = await h.receive("alpha-1", "alpha");
    assert.equal(command.name, "exportFramePng");
    assert.equal(command.input.nodeId, nodeId);
    await h.reply("alpha-1", command, { imageBase64: onePixelPng, mimeType: "image/png", nodeId, nodeName: "Alpha export", width: 1, height: 1 });
  }
  assert.equal(toolJson(await review).exports.length, 2);
  const after = await h.receive("alpha-1", "alpha");
  assert.equal(after.name, "readText");
  await h.reply("alpha-1", after, { text: "After review" });
  assert.equal(toolJson(await competing).text, "After review");
  const targets = (await (await fetch(`${h.base}/v1/targets`)).json()).targets;
  assert.equal(targets.find((target) => target.targetId === "beta").pendingCommandCount, 0);
});

test("stable file pins use only explicit validated URLs and reject duplicate advertisements", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const sandbox = { URL };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf("function cleanFigmaFileUrl("), source.indexOf("function cleanSessionInfo(")), sandbox);
  const oldRuntime = { targetId: "old-runtime", fileUrl: "https://www.figma.com/design/AlphaKey/Alpha?node-id=1:1" };
  const restartedRuntime = { targetId: "new-runtime", fileUrl: "https://www.figma.com/file/AlphaKey/Renamed" };
  const other = { targetId: "other", fileUrl: "https://www.figma.com/design/BetaKey/Alpha" };
  assert.equal(sandbox.resolveConnection([oldRuntime, other], "file:AlphaKey", true).targetId, "old-runtime");
  assert.equal(sandbox.resolveConnection([restartedRuntime, other], "file:AlphaKey", true).targetId, "new-runtime");
  assert.throws(() => sandbox.resolveConnection([oldRuntime, restartedRuntime], "file:AlphaKey", true), /more than one/i);
  assert.equal(sandbox.resolveConnection([oldRuntime, other], "file:AlphaKey").targetId, "old-runtime");
  assert.equal(sandbox.resolveConnection([{ targetId: "missing", label: "AlphaKey" }], "file:AlphaKey", true), null);
  assert.equal(sandbox.figmaFileKeyFromUrl("https://evil.example/design/AlphaKey/Alpha"), null);
});

test("a per-proxy stable file pin resolves metadata while per-call target IDs override it", { timeout: 15_000 }, async (context) => {
  const h = await isolatedBridge(context);
  await h.connect("alpha", "alpha-1", "Alpha"); await h.connect("beta", "beta-1", "Beta");
  await postJson(`${h.base}/v1/heartbeat`, { sessionId: "alpha-1", info: { fileUrl: "https://www.figma.com/design/AlphaKey/Alpha?node-id=1:1" } });
  await postJson(`${h.base}/v1/heartbeat`, { sessionId: "beta-1", info: { fileUrl: "https://www.figma.com/design/BetaKey/Beta" } });
  const proxy = await h.proxy("file:AlphaKey");
  const call = proxy.call("figma_read_text", { nodeId: "1:1" });
  const alpha = await h.receive("alpha-1", "alpha");
  await h.reply("alpha-1", alpha, { text: "Pinned Alpha" });
  assert.equal(toolJson(await call).text, "Pinned Alpha");
  const explicit = proxy.call("figma_read_text", { targetId: "beta", nodeId: "1:1" });
  const beta = await h.receive("beta-1", "beta");
  await h.reply("beta-1", beta, { text: "Explicit Beta" });
  assert.equal(toolJson(await explicit).text, "Explicit Beta");
  await h.connect("duplicate", "duplicate-1", "Duplicate Alpha");
  await postJson(`${h.base}/v1/heartbeat`, { sessionId: "duplicate-1", info: { fileUrl: "https://www.figma.com/file/AlphaKey/Alpha" } });
  const denied = await proxy.call("figma_read_text", { nodeId: "1:1" });
  assert.equal(denied.isError, true); assert.match(denied.content[0].text, /more than one/i);
});

test("hard expiry of dispatched work keeps its target fenced until late completion", async () => {
  const harness = await commandHarness();
  const operation = await harness.sendTracked({ waitForCompletion: false });
  const poll = await harness.request("GET", "/v1/poll?sessionId=test");
  assert.equal(poll.body.command.id, operation.operationId);
  harness.expire();
  assert.equal(harness.operationStatus(operation.operationId).state, "unknown");
  assert.equal(harness.fence().operationId, operation.operationId);
  assert.throws(() => harness.acquire(), /uncertain/);
  assert.throws(() => harness.send(), /uncertain/);
  const late = await harness.request("POST", "/v1/result", { sessionId: "test", id: operation.operationId, ok: true, result: {} });
  assert.equal(late.status, 204);
  assert.equal(harness.fence(), undefined);
  assert.equal(harness.operationStatus(operation.operationId).state, "unknown");
  assert.ok(harness.operationStatus(operation.operationId).lateCompletionReceivedAt);
});

test("connection discovery excludes expired idle registrations and retains busy or fenced targets", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const now = 400_000;
  const makeSession = (clientId, lastSeenAt, pending = 0, lease = null) => ({
    clientId, sessionId: `${clientId}-session`, info: {}, connectedAt: 1, lastSeenAt,
    pending: new Map(Array.from({ length: pending }, (_, i) => [String(i), {}])), lease,
  });
  const sessions = new Map([
    ["idle-session", makeSession("idle", now - 40_000)],
    ["long-dead-session", makeSession("long-dead", 1)],
    ["fresh-session", makeSession("fresh", now)],
    ["busy-session", makeSession("busy", 1, 1)],
    ["leased-session", makeSession("leased", 1, 0, { id: "lease" })],
    ["uncertain-session", makeSession("uncertain", 1)],
  ]);
  for (const key of ["idle-session", "long-dead-session", "fresh-session", "busy-session"]) sessions.get(key).info.fileUrl = "https://www.figma.com/design/same-file/Example";
  const sandbox = {
    Date: class extends Date { static now() { return now; } },
    sessions, targetFences: new Map([["uncertain", { operationId: "unknown" }]]),
    sessionFreshnessMs: 35_000, host: "127.0.0.1", port: 1234, bridgeVersion: "test", httpOwnerOnly: true,
    process: { pid: 1 }, trackedCompositionCapability: "tracked-composition-v1",
    savedTargetNames: (target) => [target.info?.label, target.info?.documentName].filter(Boolean),
    figmaFileKeyFromUrl: (value) => value ? "same-file" : null, operationSnapshot: (value) => value,
    activeSessions: () => [...sessions.values()].filter((session) => now - session.lastSeenAt < 35_000 || session.pending.size > 0),
    rejectSession: (session) => sessions.delete(session.sessionId),
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf("function targetSnapshot("), source.indexOf("function connectedSession(")), sandbox);
  const found = sandbox.discoverableTargets().map((target) => target.targetId);
  assert.deepEqual(Array.from(found), ["fresh", "busy", "leased", "uncertain"]);
  const fresh = sandbox.discoverableTargets().find((target) => target.targetId === "fresh");
  assert.deepEqual(Array.from(fresh.possibleDuplicateTargetIds), ["busy"]);
  assert.ok(sandbox.bridgeStatusSnapshot().targets.some((target) => target.targetId === "idle"));
  assert.equal(sessions.has("long-dead-session"), false);
  assert.equal(sessions.has("idle-session"), true);
  for (const key of ["busy-session", "leased-session", "uncertain-session"]) assert.equal(sessions.has(key), true);
  assert.match(source, /pathname === "\/v1\/targets"\) return json\(response, 200, \{ targets: discoverableTargets\(\)/);
});

test("MCP connection listing shares operational filtering while status retains idle history", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const targets = [
    { targetId: "stale-idle", connected: false, busy: false, pendingCommandCount: 0 },
    { targetId: "healthy", connected: true, busy: false, pendingCommandCount: 0 },
    { targetId: "pending", connected: false, busy: true, pendingCommandCount: 1 },
    { targetId: "fenced", connected: false, busy: true, pendingCommandCount: 0, uncertainOperation: { operationId: "unknown" } },
  ];
  let callback;
  const sandbox = {
    registerTool(_name, _config, run) { callback = run; },
    bridgeStatusForMcp: async () => ({ targets }),
    output: (value) => value,
    failure: (error) => { throw error; },
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf("function isOperationalTarget("), source.indexOf("function pruneInactiveSessions("))
    + source.slice(source.indexOf('registerTool("figma_list_connections"'), source.indexOf('registerTool("figma_acknowledge_uncertain_operation"')), sandbox);
  const result = await callback();
  assert.deepEqual(Array.from(result.targets, (target) => target.targetId), ["healthy", "pending", "fenced"]);
  assert.equal(targets.length, 4);
});

test("explicit empty metadata clears a file pin without disrupting an already dispatched read", { timeout: 15_000 }, async (context) => {
  const h = await isolatedBridge(context);
  const connect = await postJson(`${h.base}/v1/connect`, {
    clientId: "hims", sessionId: "hims-1",
    info: { label: "Hims Design", documentName: "Hims Design", fileUrl: "https://www.figma.com/design/HimsTestKey/Hims-Design", pageId: "0:1", pageName: "Current page" },
  });
  assert.equal(connect.status, 200);
  const proxy = await h.proxy("file:HimsTestKey");
  const read = proxy.call("figma_read_text", { nodeId: "1:1", operationId: "read-before-clear" });
  const command = await h.receive("hims-1", "hims");
  await postJson(`${h.base}/v1/heartbeat`, { sessionId: "hims-1", info: { label: 17, documentName: null, fileUrl: "https://untrusted.example/design/HimsTestKey/Other" } });
  let target = (await (await fetch(`${h.base}/v1/targets`)).json()).targets[0];
  assert.equal(target.label, "Hims Design");
  assert.equal(target.stableTargetRef, "file:HimsTestKey");
  await postJson(`${h.base}/v1/heartbeat`, { sessionId: "hims-1", info: { label: "", documentName: "", fileUrl: "" } });
  target = (await (await fetch(`${h.base}/v1/targets`)).json()).targets[0];
  assert.equal(target.label, "Current page");
  assert.equal(target.documentName, "");
  assert.equal(target.fileUrl, "");
  assert.equal(target.stableTargetRef, null);
  assert.equal(target.pendingCommandCount, 1);
  await h.reply("hims-1", command, { text: "Read completed on its original target" });
  assert.equal(toolJson(await read).text, "Read completed on its original target");
  const missingPin = await proxy.call("figma_read_text", { nodeId: "1:1" });
  assert.equal(missingPin.isError, true);
  assert.match(missingPin.content[0].text, /unavailable/);
  const finalTarget = (await (await fetch(`${h.base}/v1/targets`)).json()).targets[0];
  assert.equal(finalTarget.pendingCommandCount, 0);
  assert.equal(finalTarget.stableTargetRef, null);
});

test("named target refs use exact saved metadata and exclude stale aliases", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const sandbox = { URL };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf("function cleanFigmaFileUrl("), source.indexOf("function cleanSessionInfo(")), sandbox);
  const hims = { targetId: "hims-runtime", savedLabel: "Hims Design", documentName: "Hims Brand System", fileUrl: "https://www.figma.com/design/HimsKey/Hims-Design", connected: true };
  const website = { targetId: "website-runtime", savedLabel: "SBS Website", documentName: "Website", connected: true };
  const stale = { targetId: "closed-hims", savedLabel: "Hims Design", documentName: "Hims Brand System", connected: false, pendingCommandCount: 0 };
  const targets = [hims, website, stale];
  for (const ref of ["hims-runtime", "file:HimsKey", "name:Hims Design", "name:Hims Brand System", "Hims Design"]) assert.equal(sandbox.resolveConnection(targets, ref).targetId, "hims-runtime");
  for (const missing of ["name:Hims", "name:hims design", "Hims", "name:Missing", "file:Missing"]) assert.equal(sandbox.resolveConnection(targets, missing), null);
  assert.equal(sandbox.resolveConnection([{ targetId: "page-only", label: "Hims Design", pageName: "Hims Design", connected: true }], "name:Hims Design"), null);
  const duplicate = { targetId: "another-hims", savedLabel: "Hims Design", connected: true };
  assert.throws(() => sandbox.resolveConnection([...targets, duplicate], "name:Hims Design"), /more than one active/i);
  assert.throws(() => sandbox.resolveConnection([...targets, duplicate], "Hims Design"), /more than one active/i);
  assert.equal(sandbox.resolveConnection([...targets, duplicate], "hims-runtime").targetId, "hims-runtime");
  const restarted = { ...hims, targetId: "hims-restarted" };
  for (const ref of ["file:HimsKey", "name:Hims Design"]) assert.equal(sandbox.resolveConnection([{ ...hims, connected: false }, restarted], ref).targetId, "hims-restarted");
  assert.equal(sandbox.resolveConnection([{ targetId: "a", savedLabel: "file:Special", connected: true }], "name:file:Special").targetId, "a");
});

test("agents switch named files per call without changing either proxy default or crossing identical nodes", { timeout: 20_000 }, async (context) => {
  const h = await isolatedBridge(context);
  await h.connect("hims", "hims-1", "Hims Design");
  await h.connect("website", "website-1", "SBS Website");
  await postJson(`${h.base}/v1/heartbeat`, { sessionId: "hims-1", info: { documentName: "Hims Brand System", fileUrl: "https://www.figma.com/design/HimsKey/Hims-Design" } });
  const a = await h.proxy("name:Hims Design"); const b = await h.proxy("name:SBS Website");
  const listed = toolJson(await a.call("figma_list_connections", {})).targets;
  const named = listed.find((target) => target.targetId === "hims");
  assert.deepEqual(named.namedTargetRefs, ["name:Hims Design", "name:Hims Brand System"]);
  assert.equal(named.savedLabel, "Hims Design"); assert.equal(named.stableTargetRef, "file:HimsKey");
  const tools = await a.rpc.request("tools/list");
  assert.match(tools.tools.find((tool) => tool.name === "figma_read_text").inputSchema.properties.targetId.description, /name:/);

  async function completeRead(proxy, targetId, sessionId, expectedTarget, text) {
    const args = { nodeId: "1:1", ...(targetId === undefined ? {} : { targetId }) };
    const result = proxy.call("figma_read_text", args);
    const command = await h.receive(sessionId, expectedTarget);
    assert.equal(command.input.nodeId, "1:1");
    await h.reply(sessionId, command, { text });
    assert.equal(toolJson(await result).text, text);
  }
  await Promise.all([
    completeRead(a, "name:SBS Website", "website-1", "website", "A temporarily reads Website"),
    completeRead(b, "name:Hims Brand System", "hims-1", "hims", "B temporarily reads Hims"),
  ]);
  await Promise.all([
    completeRead(a, undefined, "hims-1", "hims", "A still defaults to Hims"),
    completeRead(b, undefined, "website-1", "website", "B still defaults to Website"),
  ]);
  await completeRead(a, "SBS Website", "website-1", "website", "Unique plain saved name");
  await completeRead(b, "file:HimsKey", "hims-1", "hims", "Explicit stable file reference");
  for (const targetId of ["name:Missing", "name:hims design", "name:Hims"]) {
    const result = await a.call("figma_update_text", { targetId, nodeId: "1:1", text: "Must not be sent" });
    assert.equal(result.isError, true); assert.match(result.content[0].text, /unavailable/);
  }
  await h.connect("duplicate-hims", "duplicate-hims-1", "Hims Design");
  const ambiguous = await a.call("figma_update_text", { targetId: "name:Hims Design", nodeId: "1:1", text: "Must not be sent" });
  assert.equal(ambiguous.isError, true); assert.match(ambiguous.content[0].text, /more than one active/i);
  const status = await (await fetch(`${h.base}/v1/status`)).json();
  assert.ok(status.targets.every((target) => target.pendingCommandCount === 0));
  await completeRead(a, "hims", "hims-1", "hims", "Runtime ID disambiguates Hims");

  // A rotated transport session retains saved names and stable file references, but never old generation credentials.
  await h.connect("hims", "hims-2", "Hims Design");
  await postJson(`${h.base}/v1/heartbeat`, { sessionId: "hims-2", info: { documentName: "Hims Brand System", fileUrl: "https://www.figma.com/design/HimsKey/Hims-Design" } });
  await completeRead(b, "file:HimsKey", "hims-2", "hims", "Stable ref reaches new session");
  await completeRead(b, "name:Hims Brand System", "hims-2", "hims", "Saved document name reaches new session");
  assert.equal((await fetch(`${h.base}/v1/poll?sessionId=hims-1`)).status, 409);
});

test("audit batch bounds and cursor forward once; partial review stays explicitly unverified", { timeout: 20_000 }, async (context) => {
  const h = await isolatedBridge(context);
  await h.connect("audit", "audit-1", "Audit fixture");
  const proxy = await h.proxy();
  for (const invalid of [
    { maxTextNodes: 0 }, { maxTextNodes: 201 }, { maxTextNodes: 1.5 },
    { maxTraversalNodes: 0 }, { maxTraversalNodes: 4_001 },
    { timeBudgetMs: 0 }, { timeBudgetMs: 3_001 },
    { cursor: "" }, { cursor: "x".repeat(201) },
  ]) {
    const denied = await proxy.call("figma_audit_text_overflow", { targetId: "audit", nodeId: "1:1", ...invalid });
    assert.equal(denied.isError, true, `Expected validation failure for ${JSON.stringify(invalid)}`);
  }
  const clean = (await (await fetch(`${h.base}/v1/targets`)).json()).targets[0];
  assert.equal(clean.pendingCommandCount, 0);
  assert.equal(clean.busy, false);
  const batch = proxy.call("figma_audit_text_overflow", {
    targetId: "audit", nodeId: "1:1", includeHidden: true, detail: "full",
    maxTextNodes: 7, maxTraversalNodes: 91, timeBudgetMs: 250, cursor: "opaque-cursor-from-prior-batch",
  });
  const audit = await h.receive("audit-1", "audit");
  assert.equal(audit.name, "auditTextOverflow");
  assert.deepEqual(audit.input, {
    nodeId: "1:1", includeHidden: true, detail: "full", maxTextNodes: 7, maxTraversalNodes: 91, timeBudgetMs: 250, cursor: "opaque-cursor-from-prior-batch",
  });
  const partialAudit = { frame: { id: "1:1" }, complete: false, nextCursor: "next-batch", incompleteReason: "text_limit", textCount: 7, warningCount: 0, batchOnly: true, totals: { textCount: 14, warningCount: 1 } };
  await h.reply("audit-1", audit, partialAudit);
  const batchResult = toolJson(await batch);
  assert.equal(batchResult.complete, false); assert.equal(batchResult.nextCursor, "next-batch");
  const review = proxy.call("figma_prepare_review", { targetId: "audit", nodeIds: ["1:1"], auditOverflow: true, scale: 1, maxDimension: 512 });
  const prepare = await h.receive("audit-1", "audit");
  assert.equal(prepare.name, "prepareReviewData");
  assert.equal(prepare.input.auditOverflow, true);
  await h.reply("audit-1", prepare, { content: { copy: "Fixture", frames: [] }, overflowAudits: [partialAudit], verificationComplete: false });
  const screenshot = await h.receive("audit-1", "audit");
  assert.equal(screenshot.name, "exportFramePng");
  await h.reply("audit-1", screenshot, { imageBase64: onePixelPng, mimeType: "image/png", nodeId: "1:1", nodeName: "Audit fixture", width: 1, height: 1 });
  const prepared = toolJson(await review);
  assert.equal(prepared.verificationComplete, false);
  assert.equal(prepared.overflowAudits[0].nextCursor, "next-batch");
  assert.match(prepared.nextStep, /continue.*nextCursor/i);
  assert.match(prepared.nextStep, /same target and frame/i);
  assert.match(prepared.nextStep, /do not repeat edits|partial scan/i);
});

test("server export localization cannot label an explicitly partial audit verified", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const sandbox = { writePngExport: async (value) => value };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf("async function localizeBatchExports("), source.indexOf("function failure(")), sandbox);
  const partial = await sandbox.localizeBatchExports({ verificationComplete: true, audits: [{ frameId: "1:1", result: { complete: false, nextCursor: "resume-audit" } }], exports: [] });
  assert.equal(partial.verificationComplete, false);
  assert.equal(partial.audits[0].result.nextCursor, "resume-audit");
  assert.equal((await sandbox.localizeBatchExports({ verificationComplete: true, audits: [{ result: { complete: true } }], exports: [] })).verificationComplete, true);
  assert.equal((await sandbox.localizeBatchExports({ verificationComplete: false, audits: [{ result: { complete: true } }], exports: [] })).verificationComplete, false);
});
