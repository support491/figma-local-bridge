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

function loadUi({ fetchImpl = async () => ({ status: 200, ok: true, json: async () => ({ targets: [] }) }) } = {}) {
  const nodes = new Map();
  const sent = [];
  const timers = new Map();
  const intervals = [];
  let nextTimer = 0;
  function element() {
    return { textContent: "", className: "", value: "", disabled: false, open: false, children: [], attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; if (name === "value") delete this.value; }, replaceChildren() { this.children = []; }, appendChild(node) { this.children.push(node); }, select() { this.selected = true; } };
  }
  const document = { body: element(), getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, createElement: element };
  const parent = { postMessage(message) { sent.push(message.pluginMessage); } };
  const window = {};
  const context = vm.createContext({ document, parent, window, fetch: fetchImpl, AbortController, navigator: { clipboard: { writeText: async () => {} } }, Date,
    setTimeout(callback, delay) { const token = ++nextTimer; timers.set(token, { callback, delay }); return token; },
    clearTimeout(token) { timers.delete(token); },
    setInterval(callback) { intervals.push(callback); return intervals.length; },
  });
  const script = ui.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(`${script}\nglobalThis.__uiTests = { renderTargets, localRequest, ageRuntime() { lastRuntimeSeen = Date.now() - 60_000; } };`, context);
  return { document, nodes, sent, timers, intervals, helpers: context.__uiTests, message: (message, source = parent) => window.onmessage({ source, data: { pluginMessage: message } }) };
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

test("compact view starts quietly and expands without reconnecting the transport", async () => {
  const harness = loadUi();
  const toggle = harness.nodes.get("view-toggle");
  assert.equal(harness.document.body.className, "compact");
  assert.equal(toggle.textContent, "Expand");
  assert.equal(toggle.attributes["aria-expanded"], "false");
  assert.equal(harness.sent.length, 1);
  toggle.onclick();
  assert.equal(harness.document.body.className, "expanded");
  assert.equal(toggle.textContent, "Compact");
  assert.equal(toggle.attributes["aria-expanded"], "true");
  assert.deepEqual(JSON.parse(JSON.stringify(harness.sent.at(-1))), { type: "panel-view", compact: false, height: 360 });
  harness.nodes.get("files-details").open = true;
  harness.nodes.get("files-details").ontoggle();
  assert.equal(harness.sent.at(-1).type, "resize");
  assert.equal(harness.sent.at(-1).height, 760);
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
  assert.equal(harness.document.body.className, "expanded");
  await harness.message({ type: "bridge-view", compact: true });
  assert.equal(harness.document.body.className, "expanded");
  assert.equal(harness.nodes.get("view-toggle").textContent, "Compact");
  assert.deepEqual(JSON.parse(JSON.stringify(harness.sent.at(-1))), { type: "panel-view", compact: false, height: 360 });
  assert.equal(harness.sent.filter((message) => message.type === "start").length, 1);
});
