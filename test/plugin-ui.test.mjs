import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const ui = await readFile(new URL("../plugin/ui.html", import.meta.url), "utf8");

test("Figma status panel embeds the exact plugin icon", async () => {
  const icon = await readFile(new URL("../assets/icon.png", import.meta.url));
  const dataUri = ui.match(/<img src="data:image\/png;base64,([A-Za-z0-9+/=]+)" alt="">/);
  assert.ok(dataUri, "status panel should embed a PNG icon");
  assert.deepEqual(Buffer.from(dataUri[1], "base64"), icon);
});

test("plugin API setup uses a transient password field and all credential routes", () => {
  assert.match(ui, /type="password"/);
  assert.match(ui, /api-credentials\/status/);
  assert.match(ui, /api-credentials\/\$\{action\}/);
  assert.match(ui, /perform\("save"\)/);
  assert.match(ui, /perform\("test"\)/);
  assert.match(ui, /perform\("clear"\)/);
  assert.match(ui, /tokenInput\.value = ""/);
});

test("plugin UI never stores the token in browser or Figma client storage", () => {
  assert.doesNotMatch(ui, /localStorage|sessionStorage|clientStorage/);
  assert.match(ui, /file_comments:read/);
  assert.match(ui, /file_comments:write/);
});

function loadUi({ fetchImpl = async () => ({ status: 200, ok: true, json: async () => ({ targets: [] }) }), clipboardImpl } = {}) {
  const nodes = new Map();
  const sent = [];
  const copied = [];
  const timers = new Map();
  const intervals = [];
  let nextTimer = 0;
  function element() {
    return { textContent: "", className: "", value: "", disabled: false, open: false, children: [], attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; if (name === "value") delete this.value; }, replaceChildren() { this.children = []; }, appendChild(node) { this.children.push(node); }, select() { this.selected = true; } };
  }
  const document = { body: element(), getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, createElement: element };
  const parent = { postMessage(message) { sent.push(message.pluginMessage); } };
  const window = {};
  const context = vm.createContext({ document, parent, window, fetch: fetchImpl, AbortController, navigator: { clipboard: { writeText: clipboardImpl || (async (value) => { copied.push(value); }) } }, Date,
    setTimeout(callback, delay) { const token = ++nextTimer; timers.set(token, { callback, delay }); return token; },
    clearTimeout(token) { timers.delete(token); },
    setInterval(callback) { intervals.push(callback); return intervals.length; },
  });
  const script = ui.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(`${script}\nglobalThis.__uiTests = { renderTargets, localRequest, ageRuntime() { lastRuntimeSeen = Date.now() - 60_000; } };`, context);
  return { document, nodes, sent, copied, timers, intervals, helpers: context.__uiTests, message: (message, source = parent) => window.onmessage({ source, data: { pluginMessage: message } }) };
}

test("iframe transport uses cancellable loopback HTTP and reports the response to the native sandbox", async () => {
  let url;
  let signal;
  const harness = loadUi({ fetchImpl: async (requestedUrl, options) => { url = requestedUrl; signal = options.signal; return { status: 200, ok: true, json: async () => ({ command: { id: "cmd" } }) }; } });
  assert.deepEqual(JSON.parse(JSON.stringify(harness.sent[0])), { type: "start", transport: "ui-http-v1" });
  await harness.message({ type: "bridge-http-request", requestId: "request", path: "/v1/poll?sessionId=sample", timeoutMs: 35_000, options: {} });
  await new Promise(setImmediate);
  assert.equal(url, "http://localhost:3846/v1/poll?sessionId=sample");
  assert.ok(signal instanceof AbortSignal);
  assert.ok(harness.sent.some((message) => message.type === "bridge-http-response" && message.requestId === "request" && message.data.command.id === "cmd"));
});

test("iframe transport cancellation aborts a stuck poll instead of starting another request", async () => {
  let calls = 0;
  let signal;
  const harness = loadUi({ fetchImpl: (_, options) => { calls++; signal = options.signal; return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); } });
  await harness.message({ type: "bridge-http-request", requestId: "poll", path: "/v1/poll?sessionId=sample", options: {} });
  await harness.message({ type: "bridge-http-cancel", requestId: "poll" });
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
  assert.ok(harness.sent.some((message) => message.type === "bridge-http-response" && message.ok === false));
  assert.equal(harness.timers.size, 0);
});

test("iframe HTTP messages cannot choose another host or access unrelated routes", async () => {
  let calls = 0;
  const harness = loadUi({ fetchImpl: async () => { calls++; throw new Error("should not fetch"); } });
  for (const path of ["https://evil.example/v1/poll", "//evil.example/v1/poll", "/v1/api-credentials/save", "/v1/mcp-command", "/v1/poll/../../api-credentials/save"])
    await harness.message({ type: "bridge-http-request", requestId: path, path, options: {} });
  assert.equal(calls, 0);
});

test("file picker exposes explicit IDs without changing another assistant’s target", async () => {
  const harness = loadUi();
  harness.helpers.renderTargets({ targets: [
    { targetId: "file-a", label: "Patient portal", pageName: "Desktop", connected: true },
    { targetId: "file-b", label: "Design system", pageName: "Components", connected: true, busy: true, fileUrl: "https://www.figma.com/design/example/System" },
  ] });
  harness.nodes.get("targets").value = "file-b";
  harness.nodes.get("targets").onchange();
  assert.equal(harness.nodes.get("target-id").value, "file-b");
  assert.match(harness.nodes.get("target-detail").textContent, /Busy/);
  assert.equal(harness.sent.length, 1, "selection must not write a global default");
  assert.equal(harness.nodes.get("open-file").disabled, false);
  harness.nodes.get("open-file").onclick();
  assert.equal(harness.sent.at(-1).type, "open-file");
  assert.match(harness.nodes.get("files-message").textContent, /does not start/);
});

test("connection metadata validates saved links before sending any change", () => {
  const harness = loadUi();
  harness.nodes.get("connection-label").value = "Portal";
  harness.nodes.get("connection-url").value = "javascript:alert(1)";
  harness.nodes.get("save-label").onclick();
  assert.equal(harness.sent.length, 1);
  harness.nodes.get("connection-url").value = "https://www.figma.com/design/example/Portal";
  harness.nodes.get("save-label").onclick();
  assert.equal(harness.sent.at(-1).type, "set-metadata");
  assert.equal(harness.sent.at(-1).label, "Portal");
});

test("connection metadata distinguishes restored, new and corrupt file records", async () => {
  const harness = loadUi();
  const base = { type: "bridge-session", sessionId: "session", clientId: "file", metadataPersistence: "document" };
  await harness.message(base);
  assert.equal(harness.nodes.get("connection-label").value, "");
  assert.match(harness.nodes.get("files-message").textContent, /^Save this file's/);
  assert.doesNotMatch(harness.nodes.get("files-message").textContent, /^Saved|^Restored/);
  await harness.message({ ...base, metadataRestored: true, label: "Hims Design", fileUrl: "https://www.figma.com/design/hims/Hims" });
  assert.equal(harness.nodes.get("connection-label").value, "Hims Design");
  assert.equal(harness.nodes.get("connection-url").value, "https://www.figma.com/design/hims/Hims");
  assert.match(harness.nodes.get("files-message").textContent, /^Restored.*saved with this Figma file/);
  await harness.message({ ...base, metadataStorageError: "Unsupported saved-record version." });
  assert.equal(harness.nodes.get("connection-url").value, "");
  assert.match(harness.nodes.get("files-message").textContent, /Could not restore.*Re-enter.*then save/);
  assert.match(harness.nodes.get("files-message").textContent, /Unsupported saved-record version/);
});

test("save acknowledgement reports file persistence separately from bridge publication", async () => {
  const harness = loadUi();
  await harness.message({ type: "bridge-metadata", label: "Portal", fileUrl: "https://www.figma.com/design/portal/Portal", persisted: true, published: true });
  assert.match(harness.nodes.get("files-message").textContent, /^Saved with this Figma file.*reopen/);
  await harness.message({ type: "bridge-metadata", label: "Portal", persisted: true, published: false, warning: "Waiting for the local bridge to reconnect." });
  assert.match(harness.nodes.get("files-message").textContent, /^Saved with this Figma file/);
  assert.match(harness.nodes.get("files-message").textContent, /Waiting for the local bridge to reconnect/);
  await harness.message({ type: "bridge-metadata", label: "Portal", persisted: true, published: false });
  assert.match(harness.nodes.get("files-message").textContent, /Waiting for the local bridge to receive/);
  await harness.message({ type: "bridge-metadata-error", error: "Could not save: this file is read-only." });
  assert.equal(harness.nodes.get("files-message").textContent, "Could not save: this file is read-only.");
  await harness.message({ type: "bridge-metadata", label: "", fileUrl: "", persisted: true, published: true });
  assert.equal(harness.nodes.get("connection-label").value, "");
  assert.equal(harness.nodes.get("connection-url").value, "");
  assert.match(harness.nodes.get("files-message").textContent, /^Saved connection details cleared/);
  await harness.message({ type: "bridge-metadata", label: "Older runtime" });
  assert.match(harness.nodes.get("files-message").textContent, /session only/);
  assert.doesNotMatch(harness.nodes.get("files-message").textContent, /^Saved with/);
});

test("an offline target refresh cannot replace a successful persistence acknowledgement", async () => {
  const harness = loadUi({ fetchImpl: async () => { throw new Error("Local bridge is offline."); } });
  await harness.message({ type: "bridge-metadata", label: "Portal", persisted: true, published: false, warning: "Waiting to publish saved details." });
  assert.match(harness.nodes.get("files-message").textContent, /^Saved with this Figma file/);
  assert.match(harness.nodes.get("files-message").textContent, /Waiting to publish/);
  assert.equal(harness.nodes.get("targets-message").textContent, "Local bridge is offline.");
  harness.nodes.get("files-details").open = true;
  harness.intervals[0]();
  await new Promise(setImmediate);
  assert.match(harness.nodes.get("files-message").textContent, /^Saved with this Figma file/);
});

test("retry cannot overlap an active command or hide a restart-required state", async () => {
  const harness = loadUi();
  await harness.message({ type: "bridge-status", kind: "connected", phase: "connected", message: "Connected to Portal" });
  await harness.message({ type: "bridge-activity", phase: "start", mutating: true, label: "Compose frame" });
  harness.nodes.get("retry").onclick();
  assert.equal(harness.sent.length, 1);
  harness.helpers.ageRuntime();
  harness.intervals[0]();
  assert.match(harness.nodes.get("status").textContent, /busy/);
  assert.equal(harness.sent.length, 1, "watchdog must not replay or reconnect during a mutation");
  await harness.message({ type: "bridge-activity", phase: "finish", mutating: true, ok: true, label: "Compose frame" });
  await harness.message({ type: "bridge-status", kind: "waiting", phase: "restart-required", message: "Figma stopped answering this plugin." });
  for (const timer of [...harness.timers.values()]) timer.callback();
  assert.match(harness.nodes.get("status").textContent, /stopped answering/);
  assert.equal(harness.nodes.get("retry").disabled, true);
});

test("iframe deadlines bound even a fetch implementation that never settles", async () => {
  const harness = loadUi({ fetchImpl: () => new Promise(() => {}) });
  const request = harness.helpers.localRequest("/v1/targets", {}, 3_000);
  const rejected = assert.rejects(request, /timed out/);
  [...harness.timers.values()].find((timer) => timer.delay === 3_000).callback();
  await rejected;
  assert.equal(harness.timers.size, 0);
});


test("Figma ancestor-frame relays deliver native status and HTTP requests", async () => {
  let calls = 0;
  const harness = loadUi({ fetchImpl: async () => { calls++; return { status: 204, ok: true }; } });
  const ancestorRelay = {};
  await harness.message({ type: "bridge-status", kind: "waiting", phase: "connecting", message: "Connecting…" }, ancestorRelay);
  assert.equal(harness.nodes.get("status").textContent, "Connecting…");
  await harness.message({ type: "bridge-http-request", requestId: "relayed-connect", path: "/v1/connect", options: { method: "POST", body: "{}" } }, ancestorRelay);
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  assert.ok(harness.sent.some((message) => message.type === "bridge-http-response" && message.requestId === "relayed-connect" && message.ok));
  await harness.message({ type: "unrecognized-message", path: "/v1/connect" }, ancestorRelay);
  assert.equal(calls, 1);
});


test("background target refresh keeps native option identities and committed selection", () => {
  const harness = loadUi();
  const first = { targetId: "website", label: "Website", pageName: "Home", connected: true };
  const second = { targetId: "hims", label: "Hims Design", pageName: "Portal", connected: true };
  harness.helpers.renderTargets({ targets: [first, second] });
  const picker = harness.nodes.get("targets");
  picker.value = "hims";
  picker.onchange();
  const originalOptions = [...picker.children];
  harness.helpers.renderTargets({ targets: [{ ...first, lastSeenAt: "later" }, { ...second, busy: true, lastSeenAt: "later" }] });
  assert.equal(picker.children[0], originalOptions[0]);
  assert.equal(picker.children[1], originalOptions[1]);
  assert.equal(picker.value, "hims");
  assert.match(harness.nodes.get("target-detail").textContent, /Busy/);
  harness.helpers.renderTargets({ targets: [{ ...second, label: "Hims renamed" }, first, { targetId: "third", label: "Third file" }] });
  assert.equal(picker.value, "hims");
  assert.equal(picker.children[0].textContent, "Hims renamed");
  assert.equal(harness.nodes.get("target-id").value, "hims");
});

test("structural target refresh waits until a focused native picker loses focus", () => {
  const harness = loadUi();
  const targets = [{ targetId: "website", label: "Website" }, { targetId: "hims", label: "Hims Design" }];
  harness.helpers.renderTargets({ targets });
  const picker = harness.nodes.get("targets");
  picker.value = "hims";
  const originalOptions = [...picker.children];
  harness.document.activeElement = picker;
  harness.helpers.renderTargets({ targets: [{ ...targets[0], label: "Website renamed" }, targets[1]] });
  assert.equal(picker.children[0], originalOptions[0]);
  assert.equal(picker.children[0].textContent, "Website");
  harness.document.activeElement = null;
  picker.onblur();
  assert.equal(picker.children[0].textContent, "Website renamed");
  assert.equal(picker.value, "hims");
});

test("staff view starts expanded and toggles without reconnecting the transport", async () => {
  const harness = loadUi();
  const toggle = harness.nodes.get("view-toggle");
  assert.equal(harness.document.body.className, "expanded");
  assert.equal(toggle.textContent, "Compact");
  assert.equal(toggle.attributes["aria-expanded"], "true");
  assert.equal(harness.sent.length, 1);
  toggle.onclick();
  assert.equal(harness.document.body.className, "compact");
  assert.equal(toggle.textContent, "Expand");
  assert.equal(toggle.attributes["aria-expanded"], "false");
  assert.deepEqual(JSON.parse(JSON.stringify(harness.sent.at(-1))), { type: "panel-view", compact: true });
  toggle.onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(harness.sent.at(-1))), { type: "panel-view", compact: false, height: 700 });
  harness.nodes.get("files-details").open = true;
  harness.nodes.get("files-details").ontoggle();
  assert.equal(harness.sent.at(-1).type, "resize");
  assert.equal(harness.sent.at(-1).height, 900);
  toggle.onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(harness.sent.at(-1))), { type: "panel-view", compact: true });
  assert.equal(harness.sent.filter((message) => message.type === "start").length, 1);
  assert.equal(harness.sent.some((message) => message.type === "retry"), false);
});

test("native view preference restores without echoing a new preference or connection", async () => {
  const harness = loadUi();
  await harness.message({ type: "bridge-view", compact: false });
  assert.equal(harness.document.body.className, "expanded");
  assert.equal(harness.nodes.get("view-toggle").textContent, "Compact");
  await harness.message({ type: "bridge-view", compact: true });
  assert.equal(harness.document.body.className, "compact");
  assert.equal(harness.sent.length, 1);
});

test("switching views leaves an outstanding HTTP poll alive", async () => {
  let release;
  let calls = 0;
  let signal;
  const harness = loadUi({ fetchImpl: (_, options) => { calls++; signal = options.signal; return new Promise((resolve) => { release = resolve; }); } });
  await harness.message({ type: "bridge-http-request", requestId: "poll-during-toggle", path: "/v1/poll?sessionId=sample", options: {} });
  harness.nodes.get("view-toggle").onclick();
  harness.nodes.get("view-toggle").onclick();
  assert.equal(signal.aborted, false);
  release({ status: 204, ok: true });
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  assert.ok(harness.sent.some((message) => message.type === "bridge-http-response" && message.requestId === "poll-during-toggle" && message.ok));
  assert.equal(harness.sent.filter((message) => message.type === "start").length, 1);
});

test("compact status keeps the saved file name, audit batch progress and failures visible", async () => {
  const harness = loadUi();
  const longName = "Hims Design — " + "Patient portal and design foundations ".repeat(5);
  await harness.message({ type: "bridge-session", sessionId: "session", clientId: "hims", label: longName });
  await harness.message({ type: "bridge-status", kind: "connected", phase: "connected", message: "Connected to local bridge." });
  assert.equal(harness.nodes.get("connection-name").textContent, longName.trim());
  assert.equal(harness.nodes.get("connection-name").title, longName.trim());
  await harness.message({ type: "bridge-activity", phase: "progress", mutating: false, label: "Audit text", progress: { phase: "text-audit", percent: 35, message: "Auditing Portal: 35 text nodes measured in this batch." } });
  assert.match(harness.nodes.get("status").textContent, /batch 35%/);
  assert.match(harness.nodes.get("detail").textContent, /in this batch/);
  assert.equal(harness.nodes.get("operation-progress").hidden, false);
  assert.equal(harness.nodes.get("operation-progress").value, 35);
  harness.nodes.get("view-toggle").onclick();
  harness.nodes.get("view-toggle").onclick();
  assert.equal(harness.nodes.get("operation-progress").value, 35);
  assert.equal(harness.nodes.get("retry").disabled, true);
  const failure = "The operation outcome is unknown. Inspect the affected layers before retrying. ".repeat(6);
  await harness.message({ type: "bridge-activity", phase: "finish", mutating: true, ok: false, label: "Compose frame", error: failure });
  harness.nodes.get("view-toggle").onclick();
  harness.nodes.get("view-toggle").onclick();
  for (const timer of [...harness.timers.values()]) if (timer.delay === 900 || timer.delay === 2200) timer.callback();
  assert.equal(harness.nodes.get("status").textContent, "Change failed");
  assert.equal(harness.nodes.get("state").className, "state failed");
  assert.match(harness.nodes.get("detail").textContent, /outcome is unknown/);
  assert.equal(harness.nodes.get("detail").title, "Compose frame: " + failure);
  assert.equal(harness.nodes.get("operation-progress").hidden, true);
});

test("reference copying prefers stable then exact saved-name references while retaining runtime IDs", () => {
  const harness = loadUi();
  harness.helpers.renderTargets({ targets: [{ targetId: "runtime-1", label: "Website", stableTargetRef: "file:known-file", namedTargetRefs: ["name:Website"] }] });
  assert.equal(harness.nodes.get("target-ref").value, "file:known-file");
  assert.equal(harness.nodes.get("target-id").value, "runtime-1");
  harness.helpers.renderTargets({ targets: [{ targetId: "runtime-1", label: "Website", namedTargetRefs: ["name:Website"] }] });
  assert.equal(harness.nodes.get("target-ref").value, "name:Website");
  harness.helpers.renderTargets({ targets: [{ targetId: "runtime-1", label: "Website" }] });
  assert.equal(harness.nodes.get("target-ref").value, "runtime-1");
  assert.equal(harness.sent.length, 1);
});


test("an in-flight native preference reply cannot override the user’s newer view choice", async () => {
  const harness = loadUi();
  harness.nodes.get("view-toggle").onclick();
  assert.equal(harness.document.body.className, "compact");
  await harness.message({ type: "bridge-view", compact: false });
  assert.equal(harness.document.body.className, "compact");
  assert.equal(harness.nodes.get("view-toggle").textContent, "Expand");
  assert.deepEqual(JSON.parse(JSON.stringify(harness.sent.at(-1))), { type: "panel-view", compact: true });
  assert.equal(harness.sent.filter((message) => message.type === "start").length, 1);
});

const staffFixture = {
  type: "staff-context", targetId: "own-file", pluginVersion: "0.14.2-local.5", documentName: "Summer Campaign", pageId: "page-social", pageName: "Social Posts",
  selection: [{ id: "artboard-original", name: "Summer square", type: "FRAME" }], workingCopyIds: [],
};
function staffFetch({ version = "0.14.2-local.5", connected = true, busy = false, offline = false } = {}) {
  return async (url) => {
    if (offline) throw new Error("/Users/private-person/confidential-file could not be opened");
    const data = url.endsWith("/v1/status") ? { bridge: { version } } : url.includes("api-credentials") ? { disabled: true } : { targets: [
      { targetId: "own-file", sessionId: "own-session", documentName: "Summer Campaign", pageName: "Social Posts", connected, busy },
      { targetId: "other-file", pageName: "Wrong page", connected: true },
    ] };
    return { status: 200, ok: true, json: async () => data };
  };
}
async function connectStaff(harness, context = staffFixture) {
  await harness.message(context);
  await harness.message({ type: "bridge-session", sessionId: "own-session", clientId: "own-file" });
  await harness.message({ type: "bridge-status", kind: "connected", phase: "connected", message: "Connected" });
  await new Promise(setImmediate);
}

test("staff prompt verifies its own file and page even when the advanced picker points elsewhere", async () => {
  const harness = loadUi({ fetchImpl: staffFetch() });
  assert.equal(harness.nodes.get("staff-copy-prompt").disabled, true);
  await connectStaff(harness);
  assert.equal(harness.nodes.get("staff-copy-prompt").disabled, false);
  assert.equal(harness.nodes.get("staff-location").textContent, "Summer Campaign → Social Posts");
  assert.equal(harness.nodes.get("staff-check").attributes["data-health"], "ready");
  assert.match(harness.nodes.get("staff-check").textContent, /Ready in Figma/);
  assert.equal(harness.nodes.get("api-details").hidden, true);
  harness.nodes.get("targets").value = "other-file";
  harness.nodes.get("targets").onchange();
  await harness.nodes.get("staff-copy-prompt").onclick();
  const prompt = harness.copied.at(-1);
  assert.match(prompt, /First call figma_bridge_status, then figma_list_connections/);
  assert.match(prompt, /targetId "own-file"/);
  assert.match(prompt, /pageId "page-social"/);
  assert.match(prompt, /"artboard-original"/);
  assert.doesNotMatch(prompt, /other-file|Wrong page/);
  assert.match(prompt, /Do not change anything/);
  assert.match(prompt, /Keep Figma API and comment access disabled/);
});

test("staff marketing tasks carry selected scope, supplied copy and copy-before-variation instructions", async () => {
  const harness = loadUi({ fetchImpl: staffFetch() });
  await connectStaff(harness);
  const task = harness.nodes.get("staff-task");
  task.value = "headline"; task.onchange();
  harness.nodes.get("staff-request").value = "Use the headline Summer starts here";
  await harness.nodes.get("staff-copy-prompt").onclick();
  assert.match(harness.copied.at(-1), /Summer starts here/);
  assert.match(harness.copied.at(-1), /check that the new text fits/);
  task.value = "variation"; task.onchange();
  await harness.nodes.get("staff-copy-prompt").onclick();
  assert.match(harness.copied.at(-1), /First duplicate.*figma_duplicate_node/);
  task.value = "export"; task.onchange();
  await harness.nodes.get("staff-copy-prompt").onclick();
  assert.match(harness.copied.at(-1), /Export the selected graphics as PNGs/);
});

test("working copy action validates the requested selection and prompts target only returned copies", async () => {
  const harness = loadUi({ fetchImpl: staffFetch() });
  await connectStaff(harness);
  harness.nodes.get("staff-copy-design").onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(harness.sent.at(-1))), { type: "staff-copy-selection", pageId: "page-social", nodeIds: ["artboard-original"] });
  assert.equal(harness.nodes.get("staff-copy-design").disabled, true);
  assert.equal(harness.nodes.get("staff-copy-prompt").disabled, true);
  await harness.message({ type: "staff-copy-result", pageId: "page-social", createdNodes: [{ id: "artboard-copy", name: "Summer square — working copy", type: "FRAME" }] });
  assert.equal(harness.nodes.get("staff-copy-design").disabled, false);
  harness.nodes.get("staff-task").value = "variation";
  await harness.nodes.get("staff-copy-prompt").onclick();
  assert.match(harness.copied.at(-1), /"artboard-copy"/);
  assert.doesNotMatch(harness.copied.at(-1), /artboard-original|First duplicate/);
  assert.match(harness.copied.at(-1), /Keep the originals unchanged/);
  await harness.message({ ...staffFixture, pageId: "different-page", pageName: "Other", selection: [] });
  assert.equal(harness.nodes.get("staff-copy-prompt").disabled, true);
  assert.equal(harness.nodes.get("staff-prompt").value, "");
  assert.doesNotMatch(harness.nodes.get("staff-selection").textContent, /Working copies/);
});

test("busy operations, failures and disconnects cannot leave working-copy controls enabled", async () => {
  const harness = loadUi({ fetchImpl: staffFetch() });
  await connectStaff(harness);
  await harness.message({ type: "bridge-activity", phase: "start", mutating: true, label: "Editing" });
  assert.equal(harness.nodes.get("staff-copy-design").disabled, true);
  harness.nodes.get("staff-copy-design").onclick();
  assert.equal(harness.sent.some((message) => message.type === "staff-copy-selection"), false);
  await harness.message({ type: "bridge-activity", phase: "finish", mutating: true, ok: true });
  harness.nodes.get("staff-copy-design").onclick();
  await harness.message({ type: "staff-error", error: "Select whole artboards on this page." });
  assert.match(harness.nodes.get("staff-message").textContent, /Select whole artboards/);
  assert.equal(harness.nodes.get("staff-copy-design").disabled, false);
  await harness.message({ type: "bridge-status", kind: "waiting", phase: "reconnecting", message: "Reconnecting" });
  assert.equal(harness.nodes.get("staff-copy-design").disabled, true);
  assert.equal(harness.nodes.get("staff-copy-prompt").disabled, true);
});

test("connection diagnostics give version repair instructions and prevent stale-version prompts", async () => {
  const harness = loadUi({ fetchImpl: staffFetch({ version: "0.14.2-local.3" }) });
  await connectStaff(harness);
  assert.match(harness.nodes.get("staff-check").textContent, /matching versions/);
  assert.match(harness.nodes.get("staff-check").textContent, /Install both parts from the same staff kit/);
  assert.equal(harness.nodes.get("staff-copy-prompt").disabled, true);
  assert.equal(harness.nodes.get("staff-copy-design").disabled, true);
});

test("offline diagnostics and support details exclude filenames, task text and raw errors", async () => {
  const harness = loadUi({ fetchImpl: staffFetch({ offline: true }) });
  await connectStaff(harness);
  assert.match(harness.nodes.get("staff-check").textContent, /Open Claude Desktop/);
  assert.doesNotMatch(harness.nodes.get("staff-check").textContent, /private-person|confidential-file/);
  harness.nodes.get("staff-request").value = "Secret campaign brief";
  await harness.nodes.get("staff-copy-support").onclick();
  const report = JSON.parse(harness.copied.at(-1));
  assert.equal(report.connection, "offline");
  assert.equal(report.pluginVersion, "0.14.2-local.5");
  assert.doesNotMatch(harness.copied.at(-1), /Summer Campaign|Secret campaign|own-file|private-person|\/Users|https:/);
});

test("a failed clipboard write exposes selectable instructions and stale runtime disables actions", async () => {
  const harness = loadUi({ fetchImpl: staffFetch(), clipboardImpl: async () => { throw new Error("Clipboard denied"); } });
  await connectStaff(harness);
  await harness.nodes.get("staff-copy-prompt").onclick();
  assert.equal(harness.nodes.get("staff-prompt").hidden, false);
  assert.equal(harness.nodes.get("staff-prompt").selected, true);
  assert.match(harness.nodes.get("staff-prompt").value, /targetId "own-file"/);
  harness.helpers.ageRuntime();
  harness.intervals[0]();
  assert.equal(harness.nodes.get("staff-copy-prompt").disabled, true);
  assert.equal(harness.nodes.get("staff-copy-design").disabled, true);
});


test("a late connection snapshot cannot restore busy state after native completion", async () => {
  let hold = false;
  const pending = [];
  const readyFetch = staffFetch();
  const harness = loadUi({ fetchImpl: async (url) => {
    if (!hold || !url.endsWith("/v1/targets")) return readyFetch(url);
    return new Promise((resolve) => pending.push(() => resolve({ status: 200, ok: true, json: async () => ({ targets: [{ targetId: "own-file", sessionId: "own-session", connected: true, busy: true }] }) })));
  } });
  await connectStaff(harness);
  await harness.message({ type: "bridge-activity", phase: "start", mutating: true, label: "Editing" });
  hold = true;
  const checking = harness.nodes.get("staff-check-connection").onclick();
  await new Promise(setImmediate);
  assert.equal(pending.length, 1);
  await harness.message({ type: "bridge-activity", phase: "finish", mutating: true, ok: true });
  pending[0]();
  await checking;
  assert.equal(harness.nodes.get("staff-check").attributes["data-health"], "ready");
  assert.equal(harness.nodes.get("staff-copy-design").disabled, false);
  assert.equal(harness.nodes.get("staff-copy-prompt").disabled, false);
});

test("delayed clipboard success cannot announce instructions for an earlier page", async () => {
  let finish;
  const harness = loadUi({ fetchImpl: staffFetch(), clipboardImpl: () => new Promise((resolve) => { finish = resolve; }) });
  await connectStaff(harness);
  const copying = harness.nodes.get("staff-copy-prompt").onclick();
  await harness.message({ ...staffFixture, pageId: "new-page", pageName: "New page" });
  finish();
  await copying;
  assert.doesNotMatch(harness.nodes.get("staff-message").textContent, /Instructions copied/);
  assert.equal(harness.nodes.get("staff-prompt").value, "");
  assert.equal(harness.nodes.get("staff-prompt").hidden, true);
});

test("delayed clipboard failure cannot reveal an old selection or an empty fallback", async () => {
  let fail;
  const harness = loadUi({ fetchImpl: staffFetch(), clipboardImpl: () => new Promise((_, reject) => { fail = reject; }) });
  await connectStaff(harness);
  const copying = harness.nodes.get("staff-copy-prompt").onclick();
  await harness.message({ ...staffFixture, selection: [{ id: "new-artboard", name: "New artboard", type: "FRAME" }] });
  fail(new Error("Clipboard denied"));
  await copying;
  assert.equal(harness.nodes.get("staff-prompt").value, "");
  assert.equal(harness.nodes.get("staff-prompt").hidden, true);
  assert.doesNotMatch(harness.nodes.get("staff-message").textContent, /Copy the selected text below/);
});
