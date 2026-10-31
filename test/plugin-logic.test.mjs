import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadPluginHelpers({ fetchImpl = fetch, postMessageImpl = () => {}, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, documentData = new Map(), DateImpl = Date } = {}) {
  const pluginPath = new URL("../plugin/code.js", import.meta.url);
  const source = await readFile(pluginPath, "utf8");
  const figma = {
    editorType: "figma",
    currentPage: { id: "0:1", name: "Test", selection: [] },
    root: {
      getPluginData(key) { return documentData.get(key) ?? ""; },
      setPluginData(key, value) { if (value) documentData.set(key, value); else documentData.delete(key); },
    },
    mixed: Symbol("mixed"),
    showUI() {},
    ui: { postMessage: postMessageImpl, onmessage: null },
    viewport: { scrollAndZoomIntoView() {} },
    async loadFontAsync() {},
    async getNodeByIdAsync(id) { return this.currentPage.id === id ? this.currentPage : this.currentPage.findOne?.((node) => node.id === id) || null; },
  };
  const context = vm.createContext({
    __html__: "",
    btoa,
    clearInterval,
    clearTimeout: clearTimeoutImpl,
    AbortController,
    fetch: fetchImpl,
    figma,
    Date: DateImpl,
    setInterval,
    setTimeout: setTimeoutImpl,
  });
  vm.runInContext(`${source}\nglobalThis.__pluginTests = { pollQuery, isRuntimeCallbackError, reconnectDelay, activityForCommand, replaceTextPreservingStyles, visibilityInfo, auditTextOverflow, auditSummary, archiveNodes, createStyledText, composeFrame, canvasLayout, setTextFrame, setTextCase, splitTextBlock, createComponentInstance, applyDesignStyle, copyStyleFromNode, listDesignSystemAssets, executeWithHeartbeat, postHeartbeat, bridgeRequest, finishTransportRequest, bridgeContext, setBridgeMetadata, loadBridgeMetadata, saveBridgeMetadata, metadataPersistenceInfo, connectionMetadataKey, validFigmaFileUrl, startBridge, stopBridge, textContent, useUiTransport() { bridgeTransport = "ui-http-v1"; }, setSession(value) { bridgeSessionId = value; }, state() { return { phase: bridgePhase, pendingRequests: transportRequests.size, generation: bridgeGeneration }; }, execute, figma };`, context);
  return context.__pluginTests;
}

function cropResizeFixture(figma, { width = 200, height = 100, pattern = false, failResize = false, failRestore = false } = {}) {
  let fills = [{ type: "IMAGE", imageHash: "approved-image", scaleMode: "CROP", opacity: 0.8, imageTransform: [[1, 0, 0.2], [0, 1, 0.1]] }];
  if (pattern) fills.push({ type: "PATTERN", sourceNodeId: "source" });
  const originalFills = JSON.parse(JSON.stringify(fills));
  const writes = [];
  const node = {
    id: "photo", name: "Photo", type: "RECTANGLE", x: 0, y: 0, width, height, visible: true,
    get fills() { return fills; },
    set fills(_) { throw new Error("Use the async setter for this fill stack"); },
    async setFillsAsync(value) {
      await Promise.resolve();
      if (failRestore && writes.length > 0) throw new Error("Restore rejected");
      fills = JSON.parse(JSON.stringify(value));
      writes.push(fills);
    },
    resize(nextWidth, nextHeight) {
      if (failResize) throw new Error("Resize rejected");
      this.width = nextWidth; this.height = nextHeight;
    },
  };
  configurePage(figma, [node]);
  return { node, writes, originalFills };
}

for (const dimensions of [
  { name: "ordinary image", width: 200, height: 100, nextWidth: 100, nextHeight: 100 },
  { name: "very narrow image", width: 1, height: 100000, nextWidth: 1, nextHeight: 95000 },
  { name: "very tall-aspect change", width: 100000, height: 1, nextWidth: 95000, nextHeight: 1 },
]) {
  test(`aspect-changing resize corrects crop for ${dimensions.name} and preserves pattern fills`, async () => {
    const { execute, figma } = await loadPluginHelpers();
    const { node, writes, originalFills } = cropResizeFixture(figma, { ...dimensions, pattern: true });
    const result = await execute("moveResizeReparent", { nodeId: node.id, width: dimensions.nextWidth, height: dimensions.nextHeight });
    assert.equal(node.width, dimensions.nextWidth);
    assert.equal(node.height, dimensions.nextHeight);
    assert.equal(node.fills[0].scaleMode, "FILL");
    assert.equal(node.fills[0].imageTransform, undefined);
    assert.equal(node.fills[0].imageHash, "approved-image");
    assert.equal(node.fills[0].opacity, 0.8);
    assert.deepEqual(node.fills[1], originalFills[1]);
    assert.equal(writes.length, 1);
    assert.equal(result.imageResizeAdjustments[0].reason, "aspect-ratio-changed");
  });
}

for (const input of [{ width: 400, height: 200 }, { x: 50, y: 60 }]) {
  test(`proportional resize or movement keeps custom crop: ${JSON.stringify(input)}`, async () => {
    const { execute, figma } = await loadPluginHelpers();
    const { node, writes, originalFills } = cropResizeFixture(figma);
    const result = await execute("moveResizeReparent", { nodeId: node.id, ...input });
    assert.deepEqual(node.fills, originalFills);
    assert.equal(writes.length, 0);
    assert.equal(result.imageResizeAdjustments.length, 0);
  });
}

test("resize failure restores custom crop and mixed pattern fills asynchronously", async () => {
  const { execute, figma } = await loadPluginHelpers();
  const { node, writes, originalFills } = cropResizeFixture(figma, { pattern: true, failResize: true });
  await assert.rejects(execute("moveResizeReparent", { nodeId: node.id, width: 100 }), /Resize rejected/);
  assert.deepEqual(node.fills, originalFills);
  assert.equal(writes.length, 2);
  assert.equal(node.width, 200);
});

test("failed crop restoration explicitly requires inspecting the node", async () => {
  const { execute, figma } = await loadPluginHelpers();
  const { node } = cropResizeFixture(figma, { failResize: true, failRestore: true });
  await assert.rejects(execute("moveResizeReparent", { nodeId: node.id, width: 100 }), /original crop fill.*could not be restored.*Inspect/);
});

test("poll query is encoded without browser-only URLSearchParams", async () => {
  const helpers = await loadPluginHelpers();
  helpers.figma.currentPage.name = "Brochure frames & copy / Māori";
  helpers.figma.currentPage.selection = [{ id: "1:2" }];
  assert.equal(
    helpers.pollQuery("figma session+1"),
    "?sessionId=figma%20session%2B1&pageId=0%3A1&pageName=Brochure%20frames%20%26%20copy%20%2F%20M%C4%81ori&selectionCount=1",
  );
});

test("a lost Figma runtime callback stops reconnecting instead of looping", async () => {
  const { isRuntimeCallbackError } = await loadPluginHelpers();
  assert.equal(isRuntimeCallbackError(new Error("in <unknown>: Attempted to invoke callback with invalid id -1345")), true);
  assert.equal(isRuntimeCallbackError(new Error("Failed to fetch")), false);
  assert.equal(isRuntimeCallbackError({ status: 409, message: "This plugin session was replaced by a newer Figma connection." }), false);
});

test("reconnect waits grow from 2 to at most 30 seconds", async () => {
  const { reconnectDelay } = await loadPluginHelpers();
  assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map(reconnectDelay), [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test("plugin activity distinguishes document writes from reads", async () => {
  const { activityForCommand } = await loadPluginHelpers();
  const write = activityForCommand("applyCopyUpdates");
  assert.equal(write.mutating, true);
  assert.equal(write.label, "Apply copy updates");
  const read = activityForCommand("readFrameContent");
  assert.equal(read.mutating, false);
  assert.equal(read.label, "Read frame content");
  assert.equal(activityForCommand("prepareReviewData").mutating, false);
});

for (const replaced of [false, true]) {
  test(`initial heartbeat ${replaced ? "replacement prevents" : "success permits"} a document mutation`, async () => {
    let heartbeats = 0;
    const { executeWithHeartbeat, figma } = await loadPluginHelpers({ fetchImpl: async () => {
      heartbeats++;
      return { status: replaced ? 409 : 204, ok: !replaced, json: async () => ({ error: "This plugin session was replaced by a newer Figma connection." }) };
    } });
    const node = styledText("target", "Keep this copy");
    configurePage(figma, [node]);
    const result = executeWithHeartbeat("session", { name: "moveResizeReparent", input: { nodeId: node.id, x: 500 } });
    if (replaced) {
      await assert.rejects(result, /replaced/);
      assert.equal(node.x, 10);
    } else {
      await result;
      assert.equal(node.x, 500);
    }
    assert.equal(heartbeats, 1);
  });
}

test("packaged review read preserves frame order and audit shape", async () => {
  const { execute, figma } = await loadPluginHelpers();
  const frames = ["Left", "Right"].map((name, index) => ({
    id: `1:${index + 1}`,
    name,
    type: "FRAME",
    children: [],
    absoluteBoundingBox: { x: index * 200, y: 0, width: 180, height: 100 },
    findAllWithCriteria() { return []; },
  }));
  configurePage(figma, frames);
  const input = { nodeIds: frames.map((frame) => frame.id), detail: "summary", auditOverflow: true };
  const result = await execute("prepareReviewData", input);
  assert.deepEqual(Array.from(result.content.frames, (frame) => frame.frame.id), input.nodeIds);
  assert.deepEqual(Array.from(result.overflowAudits, (audit) => audit.frame.id), input.nodeIds);
  assert.equal(result.content.frameCount, 2);
  assert.equal(result.overflowAudits.every((audit) => audit.warningCount === 0), true);

  const single = await execute("prepareReviewData", { nodeIds: [frames[0].id], detail: "full", auditOverflow: false });
  assert.equal(single.content.frame.id, frames[0].id);
  assert.equal(single.content.frames, undefined);
  assert.equal(single.overflowAudits.length, 0);
});

function styledText(id, characters, parent) {
  const node = {
    id,
    name: "Combined copy",
    type: "TEXT",
    parent,
    characters,
    visible: true,
    opacity: 1,
    removed: false,
    x: 10,
    y: 20,
    width: 180,
    height: 60,
    textAutoResize: "NONE",
    textTruncation: "DISABLED",
    maxLines: null,
    textCase: "ORIGINAL",
    fontName: { family: "Inter", style: "Regular" },
    absoluteBoundingBox: { x: 10, y: 20, width: 180, height: 60 },
    getStyledTextSegments() {
      return this.characters ? [{ start: 0, end: this.characters.length, characters: this.characters, fontName: this.fontName, fontSize: 16, textCase: this.textCase, fills: [] }] : [];
    },
    insertCharacters(start, value) {
      this.characters = this.characters.slice(0, start) + value + this.characters.slice(start);
    },
    deleteCharacters(start, end) {
      this.characters = this.characters.slice(0, start) + this.characters.slice(end);
    },
    resize(width, height) {
      this.width = width;
      this.height = height;
    },
    clone() {
      const copy = styledText(`${this.id}-clone`, this.characters, this.parent);
      copy.name = this.name;
      copy.x = this.x;
      copy.y = this.y;
      copy.width = this.width;
      copy.height = this.height;
      return copy;
    },
    remove() {
      this.removed = true;
      const index = this.parent?.children?.indexOf(this) ?? -1;
      if (index >= 0) this.parent.children.splice(index, 1);
    },
  };
  return node;
}

function configurePage(figma, children) {
  const page = {
    id: "0:1",
    name: "Test",
    type: "PAGE",
    children,
    selection: [],
    appendChild(node) {
      const previousIndex = node.parent?.children?.indexOf(node) ?? -1;
      if (previousIndex >= 0) node.parent.children.splice(previousIndex, 1);
      node.parent = this;
      this.children.push(node);
    },
    findOne(predicate) {
      const visit = (nodes) => {
        for (const node of nodes) {
          if (predicate(node)) return node;
          const found = node.children ? visit(node.children) : null;
          if (found) return found;
        }
        return null;
      };
      return visit(this.children);
    },
    findAll(predicate) {
      const found = [];
      const visit = (nodes) => {
        for (const node of nodes) {
          if (predicate(node)) found.push(node);
          if (node.children) visit(node.children);
        }
      };
      visit(this.children);
      return found;
    },
  };
  for (const child of children) child.parent = page;
  figma.currentPage = page;
  return page;
}

function mockText(characters) {
  return {
    characters,
    calls: [],
    insertCharacters(start, value, style) {
      this.calls.push({ action: "insert", start, value, style });
      this.characters = this.characters.slice(0, start) + value + this.characters.slice(start);
    },
    deleteCharacters(start, end) {
      this.calls.push({ action: "delete", start, end });
      this.characters = this.characters.slice(0, start) + this.characters.slice(end);
    },
  };
}

test("minimal text replacement preserves unchanged styled ranges", async () => {
  const { replaceTextPreservingStyles } = await loadPluginHelpers();
  const node = mockText("Heading\nOld body copy");
  const result = replaceTextPreservingStyles(node, "Heading\nNew body copy");
  assert.equal(node.characters, "Heading\nNew body copy");
  assert.equal(result.styleStrategy, "minimal-range");
  assert.deepEqual(node.calls.map((call) => call.action), ["delete", "insert"]);
  assert.equal(node.calls[1].style, "BEFORE");
});

test("full replacement seeds new copy from the existing first-character style", async () => {
  const { replaceTextPreservingStyles } = await loadPluginHelpers();
  const node = mockText("Old");
  const result = replaceTextPreservingStyles(node, "Entirely new");
  assert.equal(node.characters, "Entirely new");
  assert.equal(result.styleStrategy, "first-existing-character");
  assert.deepEqual(node.calls.map((call) => call.action), ["insert", "delete"]);
  assert.equal(node.calls[0].style, "AFTER");
});

function overflowAuditFixture(figma, textCount = 0, id = "audit:root") {
  const root = { id, name: "Audit frame", type: "FRAME", visible: true, opacity: 1, children: [], absoluteBoundingBox: { x: 0, y: 0, width: 1000, height: 1000 },
    findAll() { throw new Error("An audit must not scan the full subtree up front."); },
    findAllWithCriteria() { throw new Error("An audit must not scan the full subtree up front."); } };
  root.children = Array.from({ length: textCount }, (_, index) => styledText(`${id}:text:${index}`, `Copy ${index}`, root));
  const page = configurePage(figma, [root]);
  return { root, page, texts: root.children };
}

test("overflow audits resume bounded text batches without remeasuring or losing cumulative warnings", async () => {
  const { auditTextOverflow, auditSummary, figma } = await loadPluginHelpers();
  const { root, texts, page } = overflowAuditFixture(figma, 5);
  texts[0].maxLines = 1;
  let result = await auditTextOverflow(root, { maxTextNodes: 2 });
  assert.equal(result.complete, false);
  assert.equal(result.incompleteReason, "text_limit");
  assert.equal(result.text.length, 2);
  assert.equal(result.warningCount, 1);
  const batches = [result];
  while (!result.complete) {
    result = await auditTextOverflow(root, { maxTextNodes: 2, cursor: result.nextCursor });
    batches.push(result);
  }
  assert.equal(batches.length, 3);
  assert.equal(result.nextCursor, null);
  assert.equal(result.text.length, 1);
  assert.equal(result.textCount, 5);
  assert.equal(result.warningCount, 1, "an empty-warning final batch must not erase an earlier warning");
  assert.equal(result.batch.warningCount, 0);
  assert.deepEqual(batches.flatMap(batch => Array.from(batch.text, node => node.id)), texts.map(node => node.id));
  assert.deepEqual(page.children, [root], "temporary probes must not remain in the document");
  const summary = auditSummary(batches[0]);
  assert.equal(summary.complete, false);
  assert.equal(summary.nextCursor, batches[0].nextCursor);
  assert.equal(summary.batchOnly, true);
  assert.equal(summary.totals.textCount, 2);
});

test("non-text traversal is budgeted and can resume without a hidden full scan", async () => {
  const { auditTextOverflow, figma } = await loadPluginHelpers();
  const { root } = overflowAuditFixture(figma);
  root.children = Array.from({ length: 14 }, (_, index) => ({ id: `shape:${index}`, type: "RECTANGLE", name: "Shape", parent: root }));
  let childrenReads = 0;
  const children = root.children;
  Object.defineProperty(root, "children", { get() { childrenReads++; return [...children]; } });
  let result = await auditTextOverflow(root, { maxTraversalNodes: 4 });
  assert.equal(result.complete, false);
  assert.equal(result.incompleteReason, "traversal_limit");
  assert.ok(childrenReads <= 3, "a wide parent's native child array should be read a bounded number of times per batch, not once per sibling");
  let batches = 1;
  while (!result.complete) {
    assert.equal(result.batch.visitedNodeCount, 4);
    result = await auditTextOverflow(root, { maxTraversalNodes: 4, cursor: result.nextCursor });
    batches++;
  }
  assert.equal(batches, 4);
  assert.equal(result.totals.visitedNodeCount, 15);
  assert.equal(result.textCount, 0);
  assert.ok(childrenReads <= 12, "resumption validates pending ancestry without repeatedly allocating child arrays");
});

test("audit batches yield between measurements, report progress, and remove failed probes", async () => {
  let yields = 0;
  const { auditTextOverflow, figma } = await loadPluginHelpers({ setTimeoutImpl(callback) { yields++; queueMicrotask(callback); return yields; } });
  const { root, texts, page } = overflowAuditFixture(figma, 11);
  let removedProbe = false;
  const clone = texts[0].clone;
  texts[0].clone = function() {
    const probe = clone.call(this);
    probe.resize = () => { throw new Error("Measurement rejected"); };
    const remove = probe.remove;
    probe.remove = function() { removedProbe = true; remove.call(this); };
    return probe;
  };
  const progress = [];
  const result = await auditTextOverflow(root, {}, update => { progress.push(update); });
  assert.equal(result.complete, true);
  assert.ok(yields >= 2);
  assert.ok(progress.some(update => update.current === 5 && /in this batch/.test(update.message)));
  assert.equal(progress.at(-1).percent, 100);
  assert.equal(removedProbe, true);
  assert.equal(result.text[0].warnings[0].code, "MEASUREMENT_FAILED");
  assert.deepEqual(page.children, [root]);
});

test("cooperative audit deadlines stop before the next measurement and expired cursors are discarded", async () => {
  let now = 1000;
  class AuditClock extends Date { static now() { return now; } }
  const { auditTextOverflow, figma } = await loadPluginHelpers({ DateImpl: AuditClock });
  const { root, texts, page } = overflowAuditFixture(figma, 3);
  for (const node of texts) {
    const clone = node.clone;
    node.clone = function() { now += 12; return clone.call(this); };
  }
  const result = await auditTextOverflow(root, { timeBudgetMs: 5 });
  assert.equal(result.complete, false);
  assert.equal(result.incompleteReason, "time_limit");
  assert.equal(result.batch.textCount, 1);
  assert.equal(result.batch.elapsedMs, 12, "one Figma API call cannot be interrupted midway");
  assert.deepEqual(page.children, [root]);
  now += 5 * 60_000 + 1;
  await assert.rejects(auditTextOverflow(root, { cursor: result.nextCursor }), /unavailable or expired/);
});

test("audit cursors are single-use and scoped to frame, page, options and plugin runtime", async () => {
  const { auditTextOverflow, figma } = await loadPluginHelpers();
  const { root } = overflowAuditFixture(figma, 3);
  const first = await auditTextOverflow(root, { maxTextNodes: 1 });
  await assert.rejects(auditTextOverflow({ ...root, id: "other" }, { cursor: first.nextCursor }), /does not match/);
  await assert.rejects(auditTextOverflow(root, { includeHidden: true, cursor: first.nextCursor }), /does not match/);
  figma.currentPage.id = "other-page";
  await assert.rejects(auditTextOverflow(root, { cursor: first.nextCursor }), /does not match/);
  figma.currentPage.id = "0:1";
  const resumed = await auditTextOverflow(root, { maxTextNodes: 1, cursor: first.nextCursor });
  assert.equal(resumed.text[0].id, root.children[1].id);
  await assert.rejects(auditTextOverflow(root, { cursor: first.nextCursor }), /unavailable or expired/);
  const freshRuntime = await loadPluginHelpers();
  await assert.rejects(freshRuntime.auditTextOverflow(root, { cursor: resumed.nextCursor }), /unavailable or expired/);
  root.children.push(styledText("new-text", "New", root));
  await assert.rejects(auditTextOverflow(root, { cursor: resumed.nextCursor }), /frame changed/);
});

test("abandoned audit continuations have a bounded cache", async () => {
  const { auditTextOverflow, figma } = await loadPluginHelpers();
  const audits = [];
  for (let index = 0; index < 9; index++) {
    const { root } = overflowAuditFixture(figma, 2, `audit:${index}`);
    audits.push({ root, result: await auditTextOverflow(root, { maxTextNodes: 1 }) });
  }
  await assert.rejects(auditTextOverflow(audits[0].root, { cursor: audits[0].result.nextCursor }), /unavailable or expired/);
  const last = audits.at(-1);
  assert.equal((await auditTextOverflow(last.root, { cursor: last.result.nextCursor })).complete, true);
});

test("partial audits keep packaged review and copy-update verification incomplete", async () => {
  const { execute, figma } = await loadPluginHelpers();
  const { root } = overflowAuditFixture(figma, 41);
  const review = await execute("prepareReviewData", { nodeIds: [root.id], detail: "summary", auditOverflow: true });
  assert.equal(review.verificationComplete, false);
  assert.equal(review.overflowAudits[0].complete, false);
  assert.ok(review.overflowAudits[0].nextCursor);
  const updated = await execute("applyCopyUpdates", { updates: [], auditFrames: [root.id], exportFrames: [], includeHidden: false });
  assert.equal(updated.verificationComplete, false);
  assert.equal(updated.audits[0].result.complete, false);
  assert.ok(updated.audits[0].result.nextCursor);
});

test("known bridge edits invalidate outstanding audit cursors before resumption", async () => {
  const { auditTextOverflow, execute, figma } = await loadPluginHelpers();
  const { root, texts } = overflowAuditFixture(figma, 3);
  const partial = await auditTextOverflow(root, { maxTextNodes: 1 });
  await execute("moveResizeReparent", { nodeId: texts[0].id, x: 200 });
  await assert.rejects(auditTextOverflow(root, { cursor: partial.nextCursor }), /unavailable or expired/);
});

test("visibility and overflow audit exclude opacity-zero descendants by default", async () => {
  const { visibilityInfo, auditTextOverflow } = await loadPluginHelpers();
  const root = {
    id: "1:1",
    name: "Frame",
    type: "FRAME",
    children: [],
    findAllWithCriteria() {},
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
    parent: { id: "0:1", name: "Page", type: "PAGE" },
  };
  const hiddenParent = { id: "1:2", name: "Hidden", type: "FRAME", visible: true, opacity: 0, children: [], parent: root };
  const hiddenText = { id: "1:3", name: "Old copy", type: "TEXT", visible: true, opacity: 1, characters: "Superseded", parent: hiddenParent };
  root.children.push(hiddenParent);
  hiddenParent.children.push(hiddenText);

  const visibility = visibilityInfo(root, hiddenText);
  assert.equal(visibility.effectiveVisible, false);
  assert.equal(visibility.effectiveOpacity, 0);

  const audit = await auditTextOverflow(root, { includeHidden: false });
  assert.equal(audit.textCount, 0);
  assert.equal(audit.skippedHiddenTextCount, 1);
  assert.equal(audit.warningCount, 0);
});

test("summary audit keeps IDs, copy, bounds, font sizes, and warnings only", async () => {
  const { auditSummary } = await loadPluginHelpers();
  const summary = auditSummary({
    frame: { id: "1:1", name: "Frame", bounds: { x: 0, y: 0, width: 100, height: 100 }, style: { fills: [] } },
    includeHidden: false, textCount: 1, skippedHiddenTextCount: 0, warningCount: 1, visibleWarningCount: 1,
    text: [{ id: "2:1", name: "Body", characters: "Copy", bounds: { x: 10, y: 10, width: 80, height: 20 }, fontSizes: [14], effectiveVisible: true, hierarchy: [{ id: "1:1" }, { id: "2:1" }], requiredSize: { wrappedHeight: 40 }, warnings: [{ code: "VERTICAL_OVERFLOW", message: "Too tall" }] }],
  });
  assert.equal(summary.text[0].copy, "Copy");
  assert.equal(summary.text[0].hierarchy, undefined);
  assert.equal(summary.text[0].requiredSize, undefined);
  assert.equal(summary.text[0].warnings[0].code, "VERTICAL_OVERFLOW");
});

test("archive groups sibling nodes, hides them, and records their replacement", async () => {
  const { archiveNodes, figma } = await loadPluginHelpers();
  const first = { id: "1:1", name: "Old panel", type: "FRAME", visible: true };
  const second = { id: "1:2", name: "Old copy", type: "TEXT", visible: true };
  const replacement = { id: "1:3", name: "Replacement", type: "FRAME", visible: true };
  const page = configurePage(figma, [first, second, replacement]);
  figma.group = (nodes, parent) => {
    const data = new Map();
    const group = { id: "9:1", name: "Group", type: "GROUP", visible: true, parent, children: [...nodes], setPluginData(key, value) { data.set(key, value); }, getPluginData(key) { return data.get(key) ?? ""; } };
    parent.children = parent.children.filter((node) => !nodes.includes(node));
    parent.children.push(group);
    for (const node of nodes) node.parent = group;
    return group;
  };
  const result = archiveNodes({ nodeIds: [first.id, second.id], replacementNodeId: replacement.id, archiveName: "Previous layout — brochure", reason: "Relayout" });
  const group = page.children.find((node) => node.id === "9:1");
  assert.equal(group.visible, false);
  assert.equal(group.name, "Previous layout — brochure");
  assert.equal(group.getPluginData("figma_local_bridge.replacementNodeId"), replacement.id);
  assert.deepEqual(Array.from(result.mutatedNodeIds), [first.id, second.id]);
});

test("styled text loads span fonts and applies range typography in one layer", async () => {
  const { createStyledText, figma } = await loadPluginHelpers();
  const loadedFonts = [];
  figma.loadFontAsync = async (font) => { loadedFonts.push(`${font.family} ${font.style}`); };
  figma.createText = () => ({
    id: "4:1", type: "TEXT", name: "", removed: false, height: 20, calls: [],
    resize(width, height) { this.width = width; this.height = height; },
    setRangeFontName(start, end, value) { this.calls.push({ method: "font", start, end, value }); },
    setRangeFontSize(start, end, value) { this.calls.push({ method: "size", start, end, value }); },
    setRangeTextCase(start, end, value) { this.calls.push({ method: "case", start, end, value }); },
    setRangeLineHeight() {}, setRangeLetterSpacing() {}, setRangeFills() {},
    remove() { this.removed = true; },
  });
  const parent = { appendChild(node) { node.parent = this; } };
  const node = await createStyledText({
    text: "Heading\nBody", name: "Card copy", x: 10, y: 20, width: 180,
    fontFamily: "Inter", fontStyle: "Regular", fontSize: 14, textCase: "original",
    spans: [{ start: 0, end: 7, fontStyle: "Bold", fontSize: 20, textCase: "upper" }],
  }, parent);
  assert.deepEqual(loadedFonts, ["Inter Regular", "Inter Bold"]);
  assert.equal(node.characters, "Heading\nBody");
  assert.equal(node.textCase, "ORIGINAL");
  assert.equal(node.textAutoResize, "HEIGHT");
  assert.deepEqual(node.calls.map((call) => call.method), ["font", "size", "case"]);
  assert.equal(node.calls[2].value, "UPPER");
});

test("component instances are created from verified library keys with requested properties", async () => {
  const { createComponentInstance, figma } = await loadPluginHelpers();
  configurePage(figma, []);
  const component = {
    id: "4:1", key: "library-card", name: "Card", type: "COMPONENT", description: "", remote: true,
    parent: { type: "PAGE" }, componentPropertyDefinitions: { Density: { type: "VARIANT", defaultValue: "Comfortable" } },
    createInstance() {
      return {
        id: "4:2", name: "Card", type: "INSTANCE", x: 0, y: 0, width: 200, height: 100, visible: true, opacity: 1,
        componentProperties: {}, setProperties(values) { this.componentProperties = values; },
      };
    },
  };
  figma.importComponentByKeyAsync = async (key) => {
    assert.equal(key, "library-card");
    return component;
  };
  const result = await createComponentInstance({ componentKey: "library-card", componentProperties: { Density: "Compact" }, name: "Summary", x: 20, y: 30 });
  assert.equal(result.instance.id, "4:2");
  assert.equal(result.instance.name, "Summary");
  assert.equal(result.componentProperties.Density, "Compact");
});

test("named text styles load their font and apply by style ID", async () => {
  const { applyDesignStyle, figma } = await loadPluginHelpers();
  const text = {
    id: "5:1", name: "Heading", type: "TEXT", characters: "Natural case", width: 120, height: 24, visible: true, opacity: 1,
    fontName: { family: "Inter", style: "Regular" }, fontSize: 16, textAutoResize: "WIDTH_AND_HEIGHT",
    getStyledTextSegments() { return [{ fontName: this.fontName }]; },
    async setTextStyleIdAsync(id) { this.appliedStyleId = id; },
  };
  configurePage(figma, [text]);
  const style = { id: "S:1", key: "heading-style", name: "Heading/Large", type: "TEXT", description: "", remote: true, fontName: { family: "SBS Sans", style: "Bold" } };
  figma.getStyleByIdAsync = async () => style;
  let loadedFont;
  figma.loadFontAsync = async (font) => { loadedFont = font; };
  const result = await applyDesignStyle({ targetNodeIds: [text.id], styleId: style.id, aspect: "text" });
  assert.equal(text.appliedStyleId, style.id);
  assert.equal(loadedFont.family, "SBS Sans");
  assert.deepEqual(Array.from(result.mutatedNodeIds), [text.id]);
});

test("compose frame removes the entire new subtree when a later element fails", async () => {
  const { composeFrame, figma } = await loadPluginHelpers();
  const page = configurePage(figma, []);
  let nextId = 1;
  const makeFrame = () => {
    const node = {
      id: `8:${nextId++}`, name: "", type: "FRAME", removed: false, children: [], x: 0, y: 0, width: 100, height: 100, fills: [], strokes: [], opacity: 1, layoutMode: "NONE",
      resize(width, height) { this.width = width; this.height = height; },
      appendChild(child) {
        const prior = child.parent?.children?.indexOf(child) ?? -1;
        if (prior >= 0) child.parent.children.splice(prior, 1);
        child.parent = this;
        this.children.push(child);
      },
      remove() {
        this.removed = true;
        for (const child of [...this.children]) child.remove?.();
        const index = this.parent?.children?.indexOf(this) ?? -1;
        if (index >= 0) this.parent.children.splice(index, 1);
      },
    };
    page.appendChild(node);
    return node;
  };
  figma.createFrame = makeFrame;
  await assert.rejects(() => composeFrame({
    frame: { name: "Replacement", width: 300, height: 400, x: 0, y: 0 },
    elements: [
      { type: "frame", key: "panel", name: "Panel", width: 260, height: 100, x: 20, y: 20, layout: "none", itemSpacing: 0, padding: 0 },
      { type: "text", key: "copy", parentKey: "panel", text: "Short", x: 10, y: 10, fontFamily: "Inter", fontStyle: "Regular", fontSize: 14, spans: [{ start: 0, end: 99 }] },
    ],
    archiveNodeIds: [], audit: false, export: false,
  }), /exceeds text length/);
  assert.equal(page.children.length, 0);
});

test("compose frame builds native panels with direct image fills and audits required image areas", async () => {
  const { composeFrame, figma } = await loadPluginHelpers();
  const section = {
    id: "7:1", name: "Reference board", type: "SECTION", x: 100, y: 100, width: 800, height: 600, visible: true, opacity: 1, children: [],
    appendChild(child) {
      const previousIndex = child.parent?.children?.indexOf(child) ?? -1;
      if (previousIndex >= 0) child.parent.children.splice(previousIndex, 1);
      child.parent = this;
      this.children.push(child);
    },
  };
  const sourceImage = { id: "7:image", name: "Approved image", type: "RECTANGLE", x: 1_000, y: 0, width: 100, height: 100, visible: true, opacity: 1, fills: [{ type: "IMAGE", imageHash: "hash-1", scaleMode: "FILL" }], strokes: [], children: [] };
  const page = configurePage(figma, [section, sourceImage]);
  let nextId = 2;
  figma.createFrame = () => {
    const node = {
      id: `7:${nextId++}`, name: "", type: "FRAME", x: 0, y: 0, width: 100, height: 100, visible: true, opacity: 1, fills: [], strokes: [], children: [], removed: false, layoutMode: "NONE",
      resize(width, height) { this.width = width; this.height = height; },
      appendChild(child) {
        const previousIndex = child.parent?.children?.indexOf(child) ?? -1;
        if (previousIndex >= 0) child.parent.children.splice(previousIndex, 1);
        child.parent = this;
        this.children.push(child);
      },
      remove() { this.removed = true; const index = this.parent?.children?.indexOf(this) ?? -1; if (index >= 0) this.parent.children.splice(index, 1); },
    };
    page.appendChild(node);
    return node;
  };
  figma.createRectangle = () => {
    const node = {
      id: `7:${nextId++}`, name: "", type: "RECTANGLE", x: 0, y: 0, width: 100, height: 100, visible: true, opacity: 1, fills: [], strokes: [], children: [], removed: false,
      resize(width, height) { this.width = width; this.height = height; },
      remove() { this.removed = true; const index = this.parent?.children?.indexOf(this) ?? -1; if (index >= 0) this.parent.children.splice(index, 1); },
    };
    page.appendChild(node);
    return node;
  };
  const progress = [];
  const result = await composeFrame({
    frame: { name: "Native board", parentId: section.id, width: 500, height: 400, x: 20, y: 30, layout: "vertical", itemSpacing: 16, padding: 24 },
    elements: [
      { type: "frame", key: "panel", name: "Panel", width: 452, height: 100, x: 0, y: 0, layout: "none", itemSpacing: 0, padding: 0 },
      { type: "rectangle", key: "photo", parentKey: "panel", name: "Photo", width: 200, height: 80, x: 0, y: 0, imageSourceNodeId: sourceImage.id, imageScaleMode: "FIT", imageRequired: true },
      { type: "rectangle", key: "missing-photo", parentKey: "panel", name: "Missing photo", width: 200, height: 80, x: 220, y: 0, imageRequired: true },
    ],
    archiveNodeIds: [], collisionPolicy: "reject", audit: false, export: false,
  }, async (update) => { progress.push(update); });
  assert.equal(result.ok, true);
  assert.equal(result.frame.parent.id, section.id);
  assert.equal(section.children[0].layoutMode, "VERTICAL");
  assert.equal(section.children[0].itemSpacing, 16);
  assert.equal(section.children[0].paddingTop, 24);
  assert.equal(result.elements[0].type, "FRAME");
  assert.equal(result.placement.clear, true);
  const photo = section.children[0].children[0].children[0];
  assert.equal(photo.fills[0].imageHash, "hash-1");
  assert.equal(photo.fills[0].scaleMode, "FIT");
  assert.equal(result.imageAudit.requiredCount, 2);
  assert.equal(result.imageAudit.filledCount, 1);
  assert.equal(result.imageAudit.warningCount, 1);
  assert.equal(result.verificationComplete, false);
  assert.deepEqual(progress.map((update) => update.phase), ["preflight", "root", "elements", "elements", "elements", "image-audit", "complete"]);
});

test("canvas layout reports sections, occupied bounds, and proposed sibling collisions", async () => {
  const { canvasLayout, figma } = await loadPluginHelpers();
  const sectionChild = { id: "3:1", name: "Reference panel", type: "FRAME", x: 20, y: 30, width: 200, height: 120, visible: true, opacity: 1, children: [] };
  const section = { id: "2:1", name: "References", type: "SECTION", x: 0, y: 0, width: 400, height: 300, visible: true, opacity: 1, children: [sectionChild] };
  const frame = { id: "2:2", name: "Existing board", type: "FRAME", x: 500, y: 0, width: 100, height: 100, visible: true, opacity: 1, children: [] };
  const page = configurePage(figma, [section, frame]);
  sectionChild.parent = section;
  const result = canvasLayout({ proposed: { x: 350, y: 0, width: 200, height: 100 }, ignoreNodeIds: [], includeHidden: false, limit: 250 });
  assert.equal(result.contentBounds.x, 0);
  assert.equal(result.contentBounds.y, 0);
  assert.equal(result.contentBounds.width, 600);
  assert.equal(result.contentBounds.height, 300);
  assert.equal(result.sections[0].id, section.id);
  assert.equal(result.sections[0].artboards[0].id, sectionChild.id);
  assert.equal(result.parent.id, page.id);
  assert.equal(result.collision.clear, false);
  assert.equal(result.collision.overlapCount, 2);
});

test("native section creation rejects accidental overlap", async () => {
  const { execute, figma } = await loadPluginHelpers();
  const occupied = { id: "2:1", name: "Occupied", type: "FRAME", x: 0, y: 0, width: 200, height: 200, visible: true, opacity: 1, children: [] };
  const page = configurePage(figma, [occupied]);
  let nextId = 2;
  figma.createSection = () => {
    const section = {
      id: `2:${nextId++}`, name: "", type: "SECTION", x: 0, y: 0, width: 100, height: 100, visible: true, opacity: 1, fills: [], children: [], removed: false,
      resize(width, height) { this.width = width; this.height = height; },
      remove() { this.removed = true; const index = page.children.indexOf(this); if (index >= 0) page.children.splice(index, 1); },
    };
    page.appendChild(section);
    return section;
  };
  const created = await execute("createSection", { name: "References", x: 300, y: 0, width: 400, height: 300, collisionPolicy: "reject" });
  assert.equal(created.section.type, "SECTION");
  await assert.rejects(() => execute("createSection", { name: "Overlapping", x: 100, y: 50, width: 300, height: 200, collisionPolicy: "reject" }), /would overlap/);
  assert.equal(page.children.filter((node) => node.type === "SECTION").length, 1);
});

test("text-frame utility changes sizing without replacing copy", async () => {
  const { setTextFrame, figma } = await loadPluginHelpers();
  const node = styledText("2:1", "Copy stays intact", null);
  configurePage(figma, [node]);
  const result = await setTextFrame({ nodeId: node.id, width: 240, autoResize: "height", truncate: false, maxLines: null });
  assert.equal(node.characters, "Copy stays intact");
  assert.equal(result.after.width, 240);
  assert.equal(result.after.textAutoResize, "HEIGHT");
  assert.equal(result.after.textTruncation, "DISABLED");
});

test("typographic case changes presentation without rewriting stored copy", async () => {
  const { setTextCase, figma } = await loadPluginHelpers();
  const node = styledText("2:2", "Quarterly outlook", null);
  configurePage(figma, [node]);
  const result = await setTextCase({ nodeId: node.id, textCase: "upper", expectedText: "Quarterly outlook" });
  assert.equal(node.characters, "Quarterly outlook");
  assert.equal(node.textCase, "UPPER");
  assert.equal(result.before.textCase, "ORIGINAL");
  assert.equal(result.after.textCase, "UPPER");
});

test("split utility preserves copy in separate heading and body layers", async () => {
  const { splitTextBlock, figma } = await loadPluginHelpers();
  const parent = {
    id: "1:1",
    name: "Container",
    type: "FRAME",
    layoutMode: "NONE",
    children: [],
    insertChild(index, child) {
      const previousIndex = child.parent?.children?.indexOf(child) ?? -1;
      if (previousIndex >= 0) child.parent.children.splice(previousIndex, 1);
      child.parent = this;
      this.children.splice(index, 0, child);
    },
  };
  const source = styledText("2:1", "Heading\nBody copy", parent);
  parent.children.push(source);
  configurePage(figma, [parent]);
  const result = await splitTextBlock({ nodeId: source.id, splitAt: 8, trimBoundary: true, gap: 12, autoResize: "height" });
  assert.equal(source.characters, "Heading");
  assert.equal(parent.children[1].characters, "Body copy");
  assert.deepEqual(Array.from(result.mutatedNodeIds), [source.id]);
  assert.deepEqual(Array.from(result.createdNodeIds), [`${source.id}-clone`]);
  assert.equal(parent.children[1].y, source.y + source.height + 12);
});


test("asset discovery loads document components using supported APIs and preserves page usage", async () => {
  const { listDesignSystemAssets, figma } = await loadPluginHelpers();
  const local = { id: "c", type: "COMPONENT", name: "Local", remote: false };
  const remote = { id: "r", type: "COMPONENT", name: "Remote", remote: true };
  const set = { id: "s", type: "COMPONENT_SET", name: "Set", remote: false };
  const style = { id: "style", type: "PAINT", name: "Paint" };
  configurePage(figma, [{ type: "INSTANCE", getMainComponentAsync: async () => remote, fillStyleId: style.id }, { type: "INSTANCE", getMainComponentAsync: async () => remote }]);
  const currentPage = figma.currentPage;
  const otherPage = configurePage(figma, [local, remote, set]);
  figma.currentPage = currentPage;
  let loaded = false;
  figma.loadAllPagesAsync = async () => { loaded = true; };
  figma.root = { findAllWithCriteria({ types }) { assert.equal(loaded, true); return [currentPage, otherPage].flatMap((page) => page.findAll((node) => types.includes(node.type))); } };
  for (const kind of ["Paint", "Text", "Effect", "Grid"]) figma[`getLocal${kind}StylesAsync`] = async () => kind === "Paint" ? [style] : [];
  figma.variables = { getLocalVariablesAsync: async () => [{ id: "v", name: "Token" }], getLocalVariableCollectionsAsync: async () => [{ id: "vc", variableIds: ["v"] }] };
  figma.getNodeByIdAsync = async () => remote;
  figma.getStyleByIdAsync = async () => style;
  figma.teamLibrary = { getAvailableLibraryVariableCollectionsAsync: async () => { throw new Error("unavailable"); } };
  const result = await listDesignSystemAssets({ scanLimit: 10, limit: 10, includeLinkedLibraries: true });
  assert.deepEqual(Array.from(result.components.local, (node) => node.id), ["c"]);
  assert.deepEqual(Array.from(result.components.localSets, (node) => node.id), ["s"]);
  assert.equal(result.components.used[0].usageCount, 2);
  assert.equal(result.styles.used[0].usageCount, 1);
  assert.equal(result.variables.local[0].id, "v");
  assert.match(result.warning, /unavailable/);
  const limited = await listDesignSystemAssets({ scanLimit: 1, limit: 1 });
  assert.equal(limited.components.used[0].usageCount, 1);
  assert.equal(limited.scan.truncated, true);
  configurePage(figma, []);
  figma.root.findAllWithCriteria = () => [];
  const empty = await listDesignSystemAssets({ scanLimit: 10, limit: 10 });
  assert.equal(empty.components.local.length, 0);
  assert.equal(empty.components.used.length, 0);
});

for (const failure of ["parent", "properties", "result"]) {
  test(`failed component instance ${failure} removes only the new instance`, async () => {
    const { createComponentInstance, figma } = await loadPluginHelpers();
    const source = { id: "source", name: "Source", type: "COMPONENT" };
    const unrelated = { id: "other", type: "FRAME" };
    const page = configurePage(figma, [source, unrelated]);
    let instance;
    source.createInstance = () => {
      instance = { id: "new", type: "INSTANCE", name: "New", remove() { this.removed = true; this.parent.children.splice(this.parent.children.indexOf(this), 1); }, setProperties() { if (failure === "properties") throw new Error("properties failed"); } };
      page.appendChild(instance);
      if (failure === "result") Object.defineProperty(instance, "componentProperties", { get() { throw new Error("result failed"); } });
      return instance;
    };
    figma.getNodeByIdAsync = async () => source;
    await assert.rejects(createComponentInstance({ componentId: source.id, parentId: failure === "parent" ? "missing" : undefined, x: 1, y: 2, componentProperties: { Variant: "invalid" } }));
    assert.equal(instance.removed, true);
    assert.deepEqual(page.children, [source, unrelated]);
  });
}

function compositionFixture(figma, failure) {
  const page = configurePage(figma, []);
  page.insertChild = function(index, child) { this.appendChild(child); this.children.splice(this.children.indexOf(child), 1); this.children.splice(index, 0, child); };
  let next = 0;
  function make(type = "FRAME") {
    const node = { id: `compose:${next++}`, name: type, type, visible: true, removed: false, x: 12, y: 24, width: 100, height: 100, relativeTransform: [[0, -1, 12], [1, 0, 24]], children: [], fills: [], strokes: [], opacity: 1, layoutMode: "NONE",
      resize(width, height) { this.width = width; this.height = height; },
      appendChild: page.appendChild,
      remove() { this.removed = true; for (const child of [...this.children]) child.remove(); const at = this.parent.children.indexOf(this); if (at >= 0) this.parent.children.splice(at, 1); },
      setPluginData(key, value) { if (failure === "metadata") throw new Error("metadata failed"); (this.data ??= {})[key] = value; },
      async exportAsync() { if (failure === "export") throw new Error("export failed"); return new Uint8Array([1]); },
    };
    page.appendChild(node);
    return node;
  }
  const leading = make(), first = make(), sibling = make(), second = make(), trailing = make();
  const originalOrder = [leading, first, sibling, second, trailing];
  second.visible = false;
  figma.createFrame = () => { const root = make(); root.findAllWithCriteria = () => []; if (failure === "audit") { let reads = 0; Object.defineProperty(root, "absoluteBoundingBox", { get() { if (++reads > 1) throw new Error("audit failed"); return null; } }); } return root; };
  figma.group = (nodes, parent) => {
    const index = parent.children.indexOf(nodes[0]);
    const group = make("GROUP");
    parent.insertChild(index, group);
    for (const node of nodes) { group.appendChild(node); node.x = 0; node.y = 0; node.relativeTransform = [[1, 0, 0], [0, 1, 0]]; }
    if (failure === "group") throw new Error("group failed");
    return group;
  };
  return { page, first, second, sibling, originalOrder, input: { frame: { name: "Replacement", x: 300, y: 300, width: 100, height: 100 }, elements: [], archiveNodeIds: [first.id, second.id], archiveName: "Archive", archiveReason: "Test", audit: failure === "audit", export: failure === "export" } };
}

for (const failure of ["export", "audit", "metadata", "group"]) {
  test(`composition restores originals after ${failure} failure`, async () => {
    const { composeFrame, figma } = await loadPluginHelpers();
    const { page, first, second, originalOrder, input } = compositionFixture(figma, failure);
    await assert.rejects(composeFrame(input), new RegExp(`${failure} failed`));
    assert.deepEqual(page.children.map((node) => node.id), originalOrder.map((node) => node.id));
    for (const node of [first, second]) {
      assert.equal(node.parent, page);
      assert.equal(node.removed, false);

      assert.deepEqual(JSON.parse(JSON.stringify(node.relativeTransform)), [[0, -1, 12], [1, 0, 24]]);
    }
    assert.equal(first.visible, true);
    assert.equal(second.visible, false);
  });
}

test("composition archives originals only after verification and preserves replacement metadata", async () => {
  const { composeFrame, figma } = await loadPluginHelpers();
  const { page, first, second, input } = compositionFixture(figma);
  const result = await composeFrame(input);
  const archive = page.children.find((node) => node.type === "GROUP");
  assert.equal(archive.visible, false);
  assert.deepEqual(archive.children, [first, second]);
  assert.equal(result.archived.replacementNodeId, result.frame.id);
  assert.equal(archive.data["figma_local_bridge.replacementNodeId"], result.frame.id);
  assert.equal(page.children.find((node) => node.id === result.frame.id).removed, false);
});

test("an incomplete composition text audit preserves the previous layout", async () => {
  const { composeFrame, figma } = await loadPluginHelpers();
  const { page, first, second, input } = compositionFixture(figma);
  input.audit = true;
  input.elements = Array.from({ length: 401 }, (_, index) => ({ type: "frame", key: `nested-${index}`, name: `Frame ${index}`, width: 5, height: 5, x: 0, y: 0, layout: "none", itemSpacing: 0, padding: 0 }));
  const result = await composeFrame(input);
  assert.equal(result.audits[0].result.complete, false);
  assert.equal(result.audits[0].result.incompleteReason, "traversal_limit");
  assert.ok(result.audits[0].result.nextCursor);
  assert.equal(result.verificationComplete, false);
  assert.equal(result.archived, undefined);
  assert.match(result.archiveSkipped.reason, /incomplete/);
  assert.equal(first.parent, page);
  assert.equal(first.visible, true);
  assert.equal(second.parent, page);
  assert.equal(second.removed, false);
});

test("composition preserves originals when a required image area is empty", async () => {
  const { composeFrame, figma } = await loadPluginHelpers();
  const { page, first, second, input } = compositionFixture(figma);
  input.elements = [{ type: "frame", key: "photo", name: "Required photo", width: 80, height: 80, x: 0, y: 0, layout: "none", itemSpacing: 0, padding: 0, imageRequired: true }];
  const result = await composeFrame(input);
  assert.equal(result.verificationComplete, false);
  assert.equal(result.imageAudit.warningCount, 1);
  assert.deepEqual(Array.from(result.archiveSkipped.nodeIds), [first.id, second.id]);
  assert.equal(page.children.some((node) => node.type === "GROUP"), false);
  assert.equal(first.parent, page);
  assert.equal(second.parent, page);
});

for (const hiddenBy of ["paint-visible", "paint-opacity", "node-opacity", "ancestor-opacity", "root-opacity", "page-visible", "none"]) {
  test(`required image audit handles ${hiddenBy} before archiving`, async () => {
    const { composeFrame, figma } = await loadPluginHelpers();
    const { page, first, second, input } = compositionFixture(figma);
    first.fills = [{ type: "IMAGE", imageHash: "approved", scaleMode: "FILL",
      ...(hiddenBy === "paint-visible" ? { visible: false } : {}),
      ...(hiddenBy === "paint-opacity" ? { opacity: 0 } : {}),
    }];
    if (hiddenBy === "root-opacity") input.frame.opacity = 0;
    if (hiddenBy === "page-visible") page.visible = false;
    input.elements = [
      { type: "frame", key: "panel", name: "Panel", width: 90, height: 90, x: 0, y: 0, layout: "none", opacity: hiddenBy === "ancestor-opacity" ? 0 : 1 },
      { type: "frame", key: "photo", parentKey: "panel", name: "Photo", width: 80, height: 80, x: 0, y: 0, layout: "none", imageSourceNodeId: first.id, imageRequired: true, opacity: hiddenBy === "node-opacity" ? 0 : 1 },
    ];
    const result = await composeFrame(input);
    const visible = hiddenBy === "none";
    assert.equal(result.verificationComplete, visible);
    assert.equal(result.imageAudit.warningCount, visible ? 0 : 1);
    assert.equal(Boolean(result.archived), visible);
    if (!visible) {
      assert.equal(first.parent, page);
      assert.equal(second.parent, page);
      assert.equal(first.visible, true);
      assert.deepEqual(Array.from(result.archiveSkipped.nodeIds), [first.id, second.id]);
    }
  });
}

for (const mode of ["inherited-changed", "inherited-proportional", "explicit-crop", "explicit-transform"]) {
  test(`composition and direct image copy handle ${mode} crop`, async () => {
    const { composeFrame, execute, figma } = await loadPluginHelpers();
    const { first, sibling, input, page } = compositionFixture(figma);
    const crop = [[1, 0, 0.2], [0, 1, 0.1]];
    first.width = 200; first.height = 100;
    first.fills = [{ type: "IMAGE", imageHash: "approved", scaleMode: "CROP", imageTransform: crop }];
    const width = mode === "inherited-proportional" ? 100 : 80;
    const height = mode === "inherited-proportional" ? 50 : 80;
    sibling.width = width; sibling.height = height;
    const scaleMode = mode === "explicit-crop" ? "CROP" : undefined;
    const imageTransform = mode === "explicit-transform" ? [[0.8, 0, 0], [0, 0.8, 0]] : undefined;
    const copied = await execute("copyImageFill", { sourceNodeId: first.id, targetNodeId: sibling.id, scaleMode, imageTransform });
    const adjusted = mode === "inherited-changed";
    assert.equal(copied.image.scaleMode, adjusted ? "FILL" : "CROP");
    assert.equal(Boolean(copied.image.adjustment), adjusted);
    assert.equal(JSON.stringify(sibling.fills[0].imageTransform), JSON.stringify(adjusted ? undefined : imageTransform ?? crop));
    input.elements = [{ type: "frame", key: "photo", name: "Photo", width, height, x: 0, y: 0, layout: "none", imageSourceNodeId: first.id, imageScaleMode: scaleMode, imageTransform }];
    const result = await composeFrame(input);
    const root = page.children.find((node) => node.id === result.frame.id);
    assert.equal(root.children[0].fills[0].scaleMode, adjusted ? "FILL" : "CROP");
    assert.equal(JSON.stringify(root.children[0].fills[0].imageTransform), JSON.stringify(adjusted ? undefined : imageTransform ?? crop));
    assert.equal(result.imageFillAdjustments.length, adjusted ? 1 : 0);
    assert.equal(result.verificationComplete, true);
  });
}

test("a final progress connection failure preserves the committed layout and archive", async () => {
  const { composeFrame, figma } = await loadPluginHelpers();
  const { page, first, second, input } = compositionFixture(figma);
  const result = await composeFrame(input, async ({ phase }) => {
    if (phase === "complete") { const error = new Error("Session replaced"); error.status = 409; throw error; }
  });
  const replacement = page.children.find((node) => node.id === result.frame.id);
  const archive = page.children.find((node) => node.type === "GROUP");
  assert.equal(replacement.removed, false);
  assert.equal(archive.visible, false);
  assert.deepEqual(archive.children, [first, second]);
  assert.equal(archive.data["figma_local_bridge.replacementNodeId"], replacement.id);
});


for (const failure of ["target", "style", "font"]) {
  test(`named style preflights ${failure} failures before any mutation`, async () => {
    const { applyDesignStyle, figma } = await loadPluginHelpers();
    let writes = 0;
    const first = styledText("first", "Text");
    const second = failure === "target" ? { id: "second", type: "FRAME" } : styledText("second", "Text");
    first.setTextStyleIdAsync = second.setTextStyleIdAsync = async () => { writes++; };
    configurePage(figma, [first, second]);
    figma.getStyleByIdAsync = async () => ({ id: "style", type: failure === "style" ? "PAINT" : "TEXT", fontName: { family: "Source", style: "Regular" } });
    let loads = 0;
    figma.loadFontAsync = async () => { if (failure === "font" && ++loads > 1) throw new Error("font failed"); };
    await assert.rejects(applyDesignStyle({ targetNodeIds: [first.id, second.id], styleId: "style", aspect: "text" }));
    assert.equal(writes, 0);
  });
}

test("named paint style rejects incompatible style type without writes", async () => {
  const { applyDesignStyle, figma } = await loadPluginHelpers();
  let writes = 0;
  configurePage(figma, [{ id: "target", type: "RECTANGLE", setFillStyleIdAsync: async () => { writes++; } }]);
  figma.getStyleByIdAsync = async () => ({ id: "style", type: "EFFECT" });
  await assert.rejects(applyDesignStyle({ targetNodeIds: ["target"], styleId: "style", aspect: "fill" }));
  assert.equal(writes, 0);
});

for (const operation of ["named", "copy"]) {
  test(`${operation} style setter failure reports exact attempted target status`, async () => {
    const { applyDesignStyle, copyStyleFromNode, figma } = await loadPluginHelpers();
    const writes = [];
    const source = { id: "source", type: "RECTANGLE", fills: [] };
    const targets = ["a", "b", "c"].map((id) => {
      const node = { id, type: "RECTANGLE" };
      const set = () => { writes.push(id); if (id === "b") throw new Error("raw private failure details"); };
      node.setFillStyleIdAsync = async () => set();
      Object.defineProperty(node, "fills", { get: () => [], set });
      return node;
    });
    configurePage(figma, [source, ...targets]);
    figma.getStyleByIdAsync = async () => ({ id: "style", type: "PAINT" });
    const result = operation === "named"
      ? await applyDesignStyle({ targetNodeIds: targets.map((n) => n.id), styleId: "style", aspect: "fill" })
      : await copyStyleFromNode({ sourceNodeId: source.id, targetNodeIds: targets.map((n) => n.id), aspects: ["fills"] });
    assert.equal(result.ok, false);
    assert.equal(result.partial, true);
    assert.deepEqual(Array.from(result.completedNodeIds), operation === "named" ? ["a", "c"] : ["a"]);
    assert.deepEqual(Array.from(result.potentiallyMutatedNodeIds), ["b"]);
    assert.deepEqual(Array.from(result.unattemptedNodeIds), operation === "named" ? [] : ["c"]);
    assert.deepEqual(writes, operation === "named" ? ["a", "b", "c"] : ["a", "b"]);
    assert.doesNotMatch(result.error, /private/);
  });
}

for (const failure of ["target", "font"]) {
  test(`copy style preflights all visual and typography ${failure} requirements`, async () => {
    const { copyStyleFromNode, figma } = await loadPluginHelpers();
    const source = styledText("source", "Source"), first = styledText("first", "Text");
    const second = failure === "target" ? { id: "second", type: "FRAME" } : styledText("second", "Text");
    source.fills = [{ type: "SOLID" }];
    let writes = 0;
    for (const target of [first, second]) Object.defineProperty(target, "fills", { get: () => [], set() { writes++; } });
    second.fontName = { family: "Unavailable", style: "Regular" };
    configurePage(figma, [source, first, second]);
    figma.loadFontAsync = async (font) => { if (failure === "font" && font.family === "Unavailable") throw new Error("font failed"); };
    await assert.rejects(copyStyleFromNode({ sourceNodeId: source.id, targetNodeIds: [first.id, second.id], aspects: ["fills", "typography"], textSource: "first-span" }));
    assert.equal(writes, 0);
  });
}


test("copy style supports first-span mixed typography and visual aspects", async () => {
  const { copyStyleFromNode, figma } = await loadPluginHelpers();
  const source = styledText("source", "Mixed"), target = styledText("target", "Unchanged copy");
  source.fontName = figma.mixed;
  source.fills = figma.mixed;
  source.effects = [{ type: "LAYER_BLUR", radius: 4, visible: true }];
  target.effects = [];
  target.fills = [];
  source.getStyledTextSegments = () => [{ fontName: { family: "Source", style: "Bold" }, fontSize: 20, textCase: "UPPER", lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PIXELS", value: 0 }, fills: [] }];
  const loaded = [];
  figma.loadFontAsync = async (font) => { loaded.push(font.family); };
  configurePage(figma, [source, target]);
  const result = await copyStyleFromNode({ sourceNodeId: source.id, targetNodeIds: [target.id], aspects: ["fills", "effects", "typography", "corners"], textSource: "first-span" });
  assert.deepEqual(Array.from(result.mutatedNodeIds), [target.id]);
  assert.equal(result.partial, undefined);
  assert.equal(target.characters, "Unchanged copy");
  assert.equal(target.fontName.family, "Source");
  assert.equal(target.effects[0].radius, 4);
  assert.deepEqual(loaded, ["Source", "Inter"]);
});

for (const operation of ["named", "copy"]) {
  test(`${operation} style ${operation === "named" ? "avoids unnecessary viewport work" : "reports completed writes when viewport preparation fails"}`, async () => {
    const { applyDesignStyle, copyStyleFromNode, figma } = await loadPluginHelpers();
    const source = { id: "source", type: "RECTANGLE", fills: [] };
    const target = { id: "target", type: "RECTANGLE", fills: [], setFillStyleIdAsync: async () => {} };
    configurePage(figma, [source, target]);
    figma.getStyleByIdAsync = async () => ({ id: "style", type: "PAINT" });
    figma.viewport.scrollAndZoomIntoView = () => { throw new Error("viewport failed"); };
    const result = operation === "named"
      ? await applyDesignStyle({ targetNodeIds: [target.id], styleId: "style", aspect: "fill" })
      : await copyStyleFromNode({ sourceNodeId: source.id, targetNodeIds: [target.id], aspects: ["fills"] });
    if (operation === "named") {
      assert.equal(result.partial, undefined);
      assert.deepEqual(Array.from(result.mutatedNodeIds), [target.id]);
    } else {
      assert.equal(result.partial, true);
      assert.deepEqual(Array.from(result.completedNodeIds), [target.id]);
      assert.equal(result.potentiallyMutatedNodeIds.length, 0);
      assert.equal(result.unattemptedNodeIds.length, 0);
    }
  });
}

test("an unreachable initial heartbeat prevents a document mutation", async () => {
  const { executeWithHeartbeat, figma } = await loadPluginHelpers({ fetchImpl: async () => { throw new Error("bridge unavailable"); } });
  const node = styledText("target", "Keep this copy");
  configurePage(figma, [node]);
  await assert.rejects(executeWithHeartbeat("session", { name: "moveResizeReparent", input: { nodeId: node.id, x: 500 } }), /unavailable/);
  assert.equal(node.x, 10);
});

test("concurrent heartbeat callers share one outstanding request", async () => {
  let release;
  let calls = 0;
  const { postHeartbeat } = await loadPluginHelpers({ fetchImpl: () => { calls++; return new Promise((resolve) => { release = resolve; }); } });
  const first = postHeartbeat("session");
  const second = postHeartbeat("session");
  assert.equal(first, second);
  assert.equal(calls, 1);
  release({ status: 204, ok: true });
  await Promise.all([first, second]);
});

test("repeated start shares one loop and a stopped connection cannot publish stale status", async () => {
  let release;
  const messages = [];
  let connects = 0;
  const helpers = await loadPluginHelpers({ postMessageImpl: (message) => messages.push(message), fetchImpl: () => { connects++; return new Promise((resolve) => { release = resolve; }); } });
  const first = helpers.startBridge();
  assert.equal(first, helpers.startBridge());
  assert.equal(connects, 1);
  helpers.stopBridge();
  release({ status: 204, ok: true });
  await first;
  assert.equal(messages.some((message) => message.type === "bridge-session"), false);
});

test("iframe HTTP completes bridge requests without calling native Figma fetch", async () => {
  const messages = [];
  let nativeCalls = 0;
  const helpers = await loadPluginHelpers({ postMessageImpl: (message) => messages.push(message), fetchImpl: async () => { nativeCalls++; throw new Error("native callback registry is unavailable"); } });
  helpers.useUiTransport();
  const request = helpers.bridgeRequest("/v1/heartbeat", { method: "POST", body: "{}" });
  const sent = messages.find((message) => message.type === "bridge-http-request");
  helpers.finishTransportRequest({ requestId: sent.requestId, ok: true, data: null });
  assert.equal(await request, null);
  assert.equal(nativeCalls, 0);
  assert.equal(helpers.state().pendingRequests, 0);
});

test("a stalled iframe request cancels at its deadline and ignores a late reply", async () => {
  const timers = new Map();
  const messages = [];
  let next = 0;
  const helpers = await loadPluginHelpers({ postMessageImpl: (message) => messages.push(message), setTimeoutImpl: (callback) => { timers.set(++next, callback); return next; }, clearTimeoutImpl: (id) => timers.delete(id) });
  helpers.useUiTransport();
  const request = helpers.bridgeRequest("/v1/poll?sessionId=session");
  const rejected = assert.rejects(request, /timed out/);
  const sent = messages.find((message) => message.type === "bridge-http-request");
  [...timers.values()][0]();
  await rejected;
  assert.ok(messages.some((message) => message.type === "bridge-http-cancel" && message.requestId === sent.requestId));
  helpers.finishTransportRequest({ requestId: sent.requestId, ok: true, data: { command: { id: "late" } } });
  assert.equal(helpers.state().pendingRequests, 0);
});

test("a lost result acknowledgement never replays the same mutation after reconnect", async () => {
  let helpers;
  let polls = 0;
  let acknowledgements = 0;
  let mutations = 0;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const command = { id: "same-command", name: "moveResizeReparent", input: { nodeId: "1:2", x: 500 } };
  helpers = await loadPluginHelpers({ postMessageImpl(message) {
    if (message.type === "bridge-status" && message.phase === "reconnecting") queueMicrotask(() => helpers.startBridge());
    if (message.type !== "bridge-http-request") return;
    queueMicrotask(() => {
      if (message.path.startsWith("/v1/poll")) {
        polls++;
        if (polls > 2) { helpers.stopBridge(); resolveDone(); return; }
        helpers.finishTransportRequest({ requestId: message.requestId, ok: true, data: { command } });
      } else if (message.path === "/v1/result") {
        acknowledgements++;
        helpers.finishTransportRequest({ requestId: message.requestId, ok: acknowledgements > 1, error: "acknowledgement lost", data: null });
      } else helpers.finishTransportRequest({ requestId: message.requestId, ok: true, data: null });
    });
  } });
  const node = styledText("1:2", "Keep this copy");
  let x = node.x;
  Object.defineProperty(node, "x", { get: () => x, set: (value) => { x = value; mutations++; } });
  configurePage(helpers.figma, [node]);
  helpers.figma.commitUndo = () => {};
  helpers.useUiTransport();
  const loop = helpers.startBridge();
  await done;
  await loop;
  assert.equal(mutations, 1);
  assert.equal(acknowledgements, 2);
});

test("connection labels survive transport reconnect without document metadata writes", async () => {
  const helpers = await loadPluginHelpers();
  helpers.setBridgeMetadata({ label: "  Patient portal  ", fileUrl: "https://www.figma.com/design/example/Portal" });
  assert.equal(helpers.bridgeContext().label, "Patient portal");
  helpers.stopBridge();
  assert.equal(helpers.bridgeContext().fileUrl, "https://www.figma.com/design/example/Portal");
  assert.equal(helpers.bridgeContext().fileKey, undefined);
  for (const url of ["javascript:alert(1)", "https://evil.example/design/file", "https://www.figma.com.evil.example/design/file", "figma://file/example"])
    assert.equal(helpers.validFigmaFileUrl(url), false);
});

test("saved connection details restore in fresh plugin runtimes without leaking between files", async () => {
  const files = [
    { data: new Map([["unrelated.setting", "keep"]]), label: "Hims Design", fileUrl: "https://www.figma.com/design/HimsKey/Hims-Design" },
    { data: new Map(), label: "EllaDx · Website", fileUrl: "https://www.figma.com/design/WebsiteKey/EllaDx-Website" },
  ];
  for (const file of files) {
    const first = await loadPluginHelpers({ documentData: file.data });
    await first.figma.ui.onmessage({ type: "set-metadata", label: file.label, fileUrl: file.fileUrl });
    const reopened = await loadPluginHelpers({ documentData: file.data });
    reopened.loadBridgeMetadata();
    assert.equal(reopened.bridgeContext().label, file.label);
    assert.equal(reopened.bridgeContext().fileUrl, file.fileUrl);
    assert.equal(reopened.metadataPersistenceInfo().metadataRestored, true);
  }
  assert.equal(files[0].data.get("unrelated.setting"), "keep");
  const newFile = await loadPluginHelpers();
  newFile.loadBridgeMetadata();
  assert.equal(newFile.bridgeContext().fileUrl, "");
  assert.equal(newFile.metadataPersistenceInfo().metadataRestored, false);
});

test("restored metadata is present in the first connection request and session acknowledgement", async () => {
  let helpers;
  const messages = [], requests = [];
  const data = new Map([["figma_local_bridge.connection.v1", JSON.stringify({ version: 1, label: "Saved file", fileUrl: "https://www.figma.com/design/SavedKey/File" })]]);
  helpers = await loadPluginHelpers({ documentData: data, postMessageImpl: message => messages.push(message), fetchImpl: async (url, options) => {
    if (options?.body) requests.push({ url, body: JSON.parse(options.body) });
    if (url.includes("/v1/poll")) helpers.stopBridge();
    return { status: 204, ok: true };
  } });
  await helpers.startBridge();
  assert.equal(requests[0].body.info.label, "Saved file");
  assert.equal(requests[0].body.info.fileUrl, "https://www.figma.com/design/SavedKey/File");
  const session = messages.find(message => message.type === "bridge-session");
  assert.equal(session.metadataRestored, true);
  assert.equal(session.metadataPersistence, "document");
});

test("invalid saved records are ignored and preserved until an explicit successful save", async () => {
  for (const raw of ["{broken", "null", JSON.stringify({ version: 2, label: "Wrong version", fileUrl: "" }), JSON.stringify({ version: 1, label: 42, fileUrl: "" }), JSON.stringify({ version: 1, label: "Bad URL", fileUrl: "https://evil.example/design/key" }), "x".repeat(16_001)]) {
    const data = new Map([["figma_local_bridge.connection.v1", raw]]);
    const helpers = await loadPluginHelpers({ documentData: data });
    helpers.loadBridgeMetadata();
    assert.equal(helpers.bridgeContext().fileUrl, "");
    assert.equal(helpers.bridgeContext().label, "");
    assert.match(helpers.metadataPersistenceInfo().metadataStorageError, /unreadable/);
    assert.equal(data.get(helpers.connectionMetadataKey), raw);
    await helpers.saveBridgeMetadata({ label: "Corrected", fileUrl: "https://www.figma.com/design/CorrectKey/File" });
    assert.equal(helpers.metadataPersistenceInfo().metadataStorageError, undefined);
  }
});

test("failed document storage writes preserve the active identity and never report saved", async () => {
  const messages = [];
  const data = new Map([["figma_local_bridge.connection.v1", JSON.stringify({ version: 1, label: "Original", fileUrl: "https://www.figma.com/design/OriginalKey/File" })]]);
  const helpers = await loadPluginHelpers({ documentData: data, postMessageImpl: message => messages.push(message) });
  helpers.loadBridgeMetadata();
  helpers.figma.root.setPluginData = () => { throw new Error("This file is read-only"); };
  await helpers.figma.ui.onmessage({ type: "set-metadata", label: "New", fileUrl: "https://www.figma.com/design/NewKey/File" });
  assert.equal(helpers.bridgeContext().label, "Original");
  assert.equal(JSON.parse(data.get(helpers.connectionMetadataKey)).label, "Original");
  assert.equal(messages.filter(message => message.type === "bridge-metadata").length, 0);
  assert.match(messages.at(-1).error, /not saved.*read-only/);
});

test("clearing connection details removes only its saved record and publishes empty identity fields", async () => {
  const data = new Map([["unrelated.setting", "keep"]]);
  const helpers = await loadPluginHelpers({ documentData: data });
  await helpers.saveBridgeMetadata({ label: "File", fileUrl: "https://www.figma.com/design/FileKey/File" });
  await helpers.saveBridgeMetadata({ label: "", fileUrl: "" });
  assert.equal(data.has(helpers.connectionMetadataKey), false);
  assert.equal(data.get("unrelated.setting"), "keep");
  assert.equal(helpers.bridgeContext().fileUrl, "");
  assert.equal(helpers.bridgeContext().documentName, "");
  const reopened = await loadPluginHelpers({ documentData: data });
  reopened.loadBridgeMetadata();
  assert.equal(reopened.bridgeContext().fileUrl, "");
  assert.equal(reopened.metadataPersistenceInfo().metadataRestored, false);
});

test("connection details remain saved when the bridge cannot acknowledge the new identity", async () => {
  const data = new Map(), messages = [];
  const helpers = await loadPluginHelpers({ documentData: data, postMessageImpl: message => messages.push(message), fetchImpl: async () => { throw new Error("offline"); } });
  helpers.setSession("session");
  await helpers.saveBridgeMetadata({ label: "Remembered", fileUrl: "https://www.figma.com/design/RememberedKey/File" });
  const acknowledgement = messages.at(-1);
  assert.equal(acknowledgement.persisted, true);
  assert.equal(acknowledgement.published, false);
  assert.match(acknowledgement.warning, /Waiting/);
  const reopened = await loadPluginHelpers({ documentData: data });
  reopened.loadBridgeMetadata();
  assert.equal(reopened.bridgeContext().label, "Remembered");
});

test("rapid metadata saves publish each saved identity in order instead of sharing an older heartbeat", async () => {
  const published = [], messages = [], data = new Map();
  let releaseFirst, firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  const helpers = await loadPluginHelpers({ documentData: data, postMessageImpl: message => messages.push(message), fetchImpl: async (_url, options) => {
    const info = JSON.parse(options.body).info;
    published.push(info);
    if (published.length === 1) { firstStarted(); await new Promise(resolve => { releaseFirst = resolve; }); }
    return { status: 204, ok: true };
  } });
  helpers.setSession("session");
  const first = helpers.figma.ui.onmessage({ type: "set-metadata", label: "First", fileUrl: "https://www.figma.com/design/FirstKey/File" });
  await started;
  const second = helpers.figma.ui.onmessage({ type: "set-metadata", label: "Second", fileUrl: "https://www.figma.com/design/SecondKey/File" });
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(published.map(info => info.label), ["First", "Second"]);
  assert.equal(JSON.parse(data.get(helpers.connectionMetadataKey)).label, "Second");
  assert.equal(messages.at(-1).label, "Second");
  assert.equal(messages.at(-1).published, true);
});

test("routine full copy reads skip broad layout and paint scans until explicitly requested", async () => {
  const { textContent } = await loadPluginHelpers();
  let broadScans = 0;
  const root = { id: "1:1", name: "Frame", type: "FRAME", children: [], findAllWithCriteria: () => [], findAll: () => { broadScans++; return []; } };
  const ordinary = textContent(root);
  assert.equal(broadScans, 0);
  assert.equal(ordinary.layoutDiagnostics, undefined);
  assert.equal(ordinary.nativePaints, undefined);
  const audited = textContent(root, { auditLayout: true, auditPaints: true });
  assert.equal(broadScans, 2);
  assert.ok(Array.isArray(audited.layoutDiagnostics));
  assert.ok(Array.isArray(audited.nativePaints));
});

test("native runtime callback failure requires a fresh plugin and does not retry forever", async () => {
  let calls = 0;
  const helpers = await loadPluginHelpers({ fetchImpl: async () => { calls++; throw new Error("Attempted to invoke callback with invalid id -1"); } });
  await helpers.startBridge();
  assert.equal(helpers.state().phase, "restart-required");
  await helpers.startBridge();
  assert.equal(calls, 1);
});
