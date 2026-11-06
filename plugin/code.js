figma.showUI(__html__, { width: 420, height: 700, title: "Local MCP Bridge" });

const panelPreferenceKey = "figma_local_bridge.panel_compact.v1";
let panelCompact = false;
let panelViewRevision = 0;
let panelViewLoaded = false;
let panelSaveQueue = Promise.resolve();

function resizeBridgePanel(height) {
  if (panelCompact) figma.ui.resize?.(360, 190);
  else if (Number.isInteger(height) && height >= 360 && height <= 900) figma.ui.resize?.(420, height);
}

async function restorePanelView() {
  if (panelViewLoaded) return;
  panelViewLoaded = true;
  const revision = panelViewRevision;
  let saved;
  try { saved = await figma.clientStorage?.getAsync(panelPreferenceKey); } catch { /* A view preference must not block the connection. */ }
  // A click made while storage was loading is newer than the saved preference.
  if (revision !== panelViewRevision) return;
  if (typeof saved === "boolean") panelCompact = saved;
  resizeBridgePanel(700);
  figma.ui.postMessage({ type: "bridge-view", compact: panelCompact });
}

function setPanelView(message) {
  if (typeof message.compact !== "boolean") return;
  panelViewRevision += 1;
  panelCompact = message.compact;
  resizeBridgePanel(Number.isInteger(message.height) && message.height >= 360 && message.height <= 900 ? message.height : 700);
  const value = panelCompact;
  panelSaveQueue = panelSaveQueue.then(() => figma.clientStorage?.setAsync(panelPreferenceKey, value)).catch(() => {});
}

let bridgeGeneration = 0;
const bridgeUrl = "http://localhost:3846";
const pluginVersion = "0.14.2-local.4";
const bridgeClientId = `figma-client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const mutatingCommands = new Set([
  "moveResizeReparent", "updateText", "setTextCase", "deleteNode", "duplicateNode",
  "createSection", "createFrame", "createText", "createRectangle", "createEllipse",
  "importSvg", "styleNode", "createColorTokens", "setAutoLayout",
  "applyCopyUpdates", "setTextFrame", "splitTextBlock",
  "archiveNodes", "composeFrame", "copyStyleFromNode", "copyImageFill", "placeLocalImage",
  "createComponentInstance", "applyDesignStyle", "createPage", "retypeFont", "resizeFontSizes", "textOverlapCheck", "tightenCards", "dsShiftBelow", "dsSectionSize", "retypeHeadings", "centerSubheadings", "setTextStyleFonts", "setVariableValues",
  "dsRender", "dsTextStyles", "dsEffectStyles", "dsNumberVars", "dsPages", "dsMove", "dsDelete", "dsRenameFile", "dsSetThumbnail",
  "dsColorVars", "dsDeleteStyles", "dsRecolorGlyphs", "dsReplaceFont", "dsFitSection",
  "dsSetProps", "dsSetVisible", "dsRename", "dsAddVariant", "dsMakeSet", "dsSwap", "dsSetFields", "dsModeCollection", "dsSetMode", "dsThemeWalk", "dsSwapVars", "dsRemoveCollection",
  "dsClone", "dsSetReactions", "dsRepointLinks", "dsFlowStarts", "dsAutoBind", "dsAutoTextStyles", "dsSetText", "dsStyleSegments", "dsReplaceInstance", "dsRescale", "dsSetRich", "dsAddProps", "dsRemoveProps",
]);

function bridgeStatus(message, kind = "", phase = kind) {
  bridgePhase = phase;
  figma.ui.postMessage({ type: "bridge-status", message, kind, phase });
}

function commandLabel(name) {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/\bpng\b/g, "PNG")
    .replace(/\bsvg\b/g, "SVG");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function activityForCommand(name) {
  const mutating = mutatingCommands.has(name);
  return { name, label: commandLabel(name), mutating };
}

function bridgeActivity(command, phase, ok, error) {
  figma.ui.postMessage({
    type: "bridge-activity",
    phase,
    ...activityForCommand(command.name),
    ...(ok === undefined ? {} : { ok }),
    ...(error ? { error: errorMessage(error) } : {}),
  });
}

function bridgeProgress(command, progress) {
  figma.ui.postMessage({ type: "bridge-activity", phase: "progress", ...activityForCommand(command.name), progress });
}

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object") {
    if (typeof error.message === "string") return error.message;
    try { return JSON.stringify(error); } catch { return "Unknown local connection error"; }
  }
  return String(error);
}

// The iframe owns HTTP: browser fetch avoids Figma's native fetch callback registry.
// Native document commands stay in this sandbox and execute strictly one at a time.
let bridgeTransport = "native";
let bridgeLoop = null;
let bridgePhase = "starting";
let bridgeSessionId = null;
let bridgeCommandInFlight = false;
let bridgeRetryWake = null;
let requestSequence = 0;
const transportRequests = new Map();
const heartbeatRequests = new Map();
const completedCommands = new Map();
const completedCommandIds = new Set();
let bridgeMetadata = { label: "", documentName: "", fileUrl: "" };
const connectionMetadataKey = "figma_local_bridge.connection.v1";
let bridgeMetadataLoaded = false;
let bridgeMetadataRestored = false;
let bridgeMetadataStorageError = "";
let metadataSaveQueue = Promise.resolve();

function requestTimeout(path) { return path.startsWith("/v1/poll?") ? 35_000 : 10_000; }
function transportError(message, status) {
  const error = new Error(message);
  if (status) error.status = status;
  return error;
}
function finishTransportRequest(message) {
  const pending = transportRequests.get(message.requestId);
  if (!pending) return;
  transportRequests.delete(message.requestId);
  clearTimeout(pending.timer);
  if (message.ok) pending.resolve(message.data ?? null);
  else pending.reject(transportError(message.error || "Local bridge request failed.", message.status));
}
function cancelTransportRequests() {
  for (const [requestId, pending] of transportRequests) {
    clearTimeout(pending.timer);
    figma.ui.postMessage({ type: "bridge-http-cancel", requestId });
    pending.reject(transportError("Bridge connection was stopped."));
  }
  transportRequests.clear();
}
async function bridgeRequest(path, options = {}) {
  const { timeoutMs = requestTimeout(path), ...fetchOptions } = options;
  if (bridgeTransport === "ui-http-v1") {
    const requestId = `http-${++requestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!transportRequests.delete(requestId)) return;
        figma.ui.postMessage({ type: "bridge-http-cancel", requestId });
        reject(transportError(`Local bridge request timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
      }, timeoutMs + 1_000);
      transportRequests.set(requestId, { resolve, reject, timer });
      figma.ui.postMessage({ type: "bridge-http-request", requestId, path, options: fetchOptions, timeoutMs });
    });
  }
  // Compatibility path for older panels/tests; new panels always select iframe HTTP.
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(`${bridgeUrl}${path}`, { ...fetchOptions, ...(controller ? { signal: controller.signal } : {}) });
        if (response.status === 204) return null;
        const data = await response.json();
        if (!response.ok) throw transportError(data.error || `Bridge returned ${response.status}`, response.status);
        return data;
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { controller?.abort(); reject(transportError("Local bridge request timed out.")); }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
function validFigmaFileUrl(value) {
  return typeof value === "string" && value.length <= 2_000 && /^https:\/\/(?:www\.)?figma\.com\/(?:design|file|proto|board|slides)\/[^\s/?#]+(?:[/?#][^\s]*)?$/.test(value);
}
function normalizedBridgeMetadata(value = {}) {
  const label = typeof value.label === "string" ? value.label.trim().slice(0, 120) : bridgeMetadata.label;
  const fileUrl = typeof value.fileUrl === "string" ? value.fileUrl.trim() : bridgeMetadata.fileUrl;
  if (fileUrl && !validFigmaFileUrl(fileUrl)) throw new Error("Use an HTTPS Figma file URL.");
  return { label, documentName: label, fileUrl };
}
function setBridgeMetadata(value = {}) {
  bridgeMetadata = normalizedBridgeMetadata(value);
  return bridgeMetadata;
}
function loadBridgeMetadata() {
  if (bridgeMetadataLoaded) return;
  bridgeMetadataLoaded = true;
  try {
    const raw = figma.root.getPluginData(connectionMetadataKey);
    if (!raw) return;
    if (typeof raw !== "string" || raw.length > 16_000) throw new Error("Invalid saved record.");
    const saved = JSON.parse(raw);
    if (!saved || saved.version !== 1 || typeof saved.label !== "string" || typeof saved.fileUrl !== "string" || saved.label.length > 120)
      throw new Error("Invalid saved record.");
    setBridgeMetadata(saved);
    bridgeMetadataRestored = Boolean(bridgeMetadata.label || bridgeMetadata.fileUrl);
  } catch (error) {
    // Never borrow another file's identity or overwrite an unreadable record automatically.
    bridgeMetadataStorageError = "The stored record is unreadable or unavailable.";
  }
}
function metadataPersistenceInfo() {
  return { metadataPersistence: "document", metadataRestored: bridgeMetadataRestored, ...(bridgeMetadataStorageError ? { metadataStorageError: bridgeMetadataStorageError } : {}) };
}
async function saveBridgeMetadata(value) {
  loadBridgeMetadata();
  const next = normalizedBridgeMetadata(value);
  // Store first: a read-only file or failed write must not change the active identity.
  figma.root.setPluginData(connectionMetadataKey, next.label || next.fileUrl ? JSON.stringify({ version: 1, label: next.label, fileUrl: next.fileUrl }) : "");
  bridgeMetadata = next;
  bridgeMetadataRestored = false;
  bridgeMetadataStorageError = "";
  let published = false;
  let warning;
  if (bridgeSessionId) {
    try {
      // Drain an older in-flight heartbeat before publishing this saved identity.
      if (heartbeatRequests.has(bridgeSessionId)) await heartbeatRequests.get(bridgeSessionId).catch(() => {});
      await postHeartbeat(bridgeSessionId);
      published = true;
    } catch (error) { warning = "Waiting for the local bridge to receive the updated connection details."; }
  } else warning = "The connection will use these details when it reconnects.";
  figma.ui.postMessage({ type: "bridge-metadata", ...next, persisted: true, published, ...(warning ? { warning } : {}) });
}
function bridgeContext() {
  return {
    pluginVersion,
    capabilities: ["composition-image-audit-v1", "composition-image-audit-v2", "ui-http-transport-v1"],
    editorType: figma.editorType,
    pageId: figma.currentPage.id,
    pageName: figma.currentPage.name,
    selectionCount: figma.currentPage.selection.length,
    ...bridgeMetadata,
  };
}
function pollQuery(sessionId) {
  publishStaffContext();
  const context = bridgeContext();
  const params = { sessionId, pageId: context.pageId, pageName: context.pageName, selectionCount: String(context.selectionCount) };
  return `?${Object.entries(params).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&")}`;
}
function isReplacementError(error) { return error?.status === 409 && /replaced|newer figma plugin/i.test(errorMessage(error)); }
function isRuntimeCallbackError(error) { return /invoke callback with invalid id/i.test(errorMessage(error)); }
function reconnectDelay(failures) { return Math.min(2_000 * 2 ** Math.max(0, failures - 1), 30_000); }
function terminalHeartbeatError(error) { return isReplacementError(error) || isRuntimeCallbackError(error) || error?.status === 401; }
function postHeartbeat(sessionId) {
  publishStaffContext();
  if (heartbeatRequests.has(sessionId)) return heartbeatRequests.get(sessionId);
  const request = bridgeRequest("/v1/heartbeat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, info: bridgeContext() }),
  }).finally(() => { if (heartbeatRequests.get(sessionId) === request) heartbeatRequests.delete(sessionId); });
  heartbeatRequests.set(sessionId, request);
  return request;
}
async function postOperationProgress(sessionId, command, progress) {
  return bridgeRequest("/v1/progress", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, id: command.id, progress, info: bridgeContext() }),
  });
}
async function executeWithHeartbeat(sessionId, command) {
  let heartbeatError = null;
  let stopped = false;
  let timer;
  // A failed initial heartbeat means this command has not started; do not mutate.
  await postHeartbeat(sessionId);
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try { await postHeartbeat(sessionId); } catch (error) { heartbeatError = error; }
      schedule();
    }, 10_000);
  };
  schedule();
  try {
    const reportProgress = async (progress) => {
      if (terminalHeartbeatError(heartbeatError)) throw heartbeatError;
      bridgeProgress(command, progress);
      try { await postOperationProgress(sessionId, command, progress); }
      catch (error) { if (terminalHeartbeatError(error)) throw error; }
    };
    const result = await execute(command.name, command.input, reportProgress);
    if (terminalHeartbeatError(heartbeatError)) throw heartbeatError;
    return result;
  } finally { stopped = true; clearTimeout(timer); }
}
function completedResultUnavailable() {
  return { ok: false, error: "This command already completed, but its result is no longer cached. Re-read the affected state; the command was not replayed." };
}
function rememberCommand(id, payload) {
  completedCommandIds.add(id);
  // Large PNGs/read payloads must not accumulate throughout a long plugin session.
  completedCommands.set(id, JSON.stringify(payload).length <= 512_000 ? payload : completedResultUnavailable());
  while (completedCommands.size > 16) completedCommands.delete(completedCommands.keys().next().value);
}
function stopBridge() {
  bridgeGeneration += 1;
  if (bridgeRetryWake) bridgeRetryWake();
  cancelTransportRequests();
}
function startBridge() {
  loadBridgeMetadata();
  if (bridgePhase === "restart-required") {
    bridgeStatus("Figma needs a fresh plugin runtime. Close this panel and run Local MCP Bridge again.", "waiting", "restart-required");
    return Promise.resolve();
  }
  if (bridgeLoop) { if (bridgeRetryWake) bridgeRetryWake(); return bridgeLoop; }
  const generation = ++bridgeGeneration;
  bridgeLoop = runBridge(generation).finally(() => { bridgeLoop = null; });
  return bridgeLoop;
}
async function runBridge(generation) {
  let failures = 0;
  while (generation === bridgeGeneration) {
    try {
      const sessionId = `figma-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      bridgeSessionId = null;
      bridgeStatus("Connecting…", "waiting", "connecting");
      await bridgeRequest("/v1/connect", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, clientId: bridgeClientId, info: bridgeContext() }),
      });
      if (generation !== bridgeGeneration) return;
      bridgeSessionId = sessionId;
      // Publish labels changed while connect was in flight before exposing this session.
      await postHeartbeat(sessionId);
      if (generation !== bridgeGeneration) return;
      failures = 0;
      figma.ui.postMessage({ type: "bridge-session", sessionId, clientId: bridgeClientId, targetId: bridgeClientId, bridgeUrl, ...bridgeMetadata, ...metadataPersistenceInfo() });
      bridgeStatus(`Connected on “${bridgeMetadata.label || figma.currentPage.name}”. Keep this plugin open.`, "connected", "connected");
      while (generation === bridgeGeneration) {
        const message = await bridgeRequest(`/v1/poll${pollQuery(sessionId)}`);
        if (generation !== bridgeGeneration) return;
        if (!message?.command) continue;
        const command = message.command;
        if (command.targetId && command.targetId !== bridgeClientId) throw new Error("Command target does not match this plugin.");
        let payload = completedCommands.get(command.id) || (completedCommandIds.has(command.id) ? completedResultUnavailable() : null);
        if (!payload) {
          bridgeCommandInFlight = true;
          bridgeActivity(command, "start");
          try {
            const result = await executeWithHeartbeat(sessionId, command);
            if (mutatingCommands.has(command.name)) figma.commitUndo();
            payload = { ok: true, result };
          } catch (error) {
            if (isRuntimeCallbackError(error) || isReplacementError(error)) throw error;
            payload = { ok: false, error: errorMessage(error) };
          } finally { bridgeCommandInFlight = false; }
          rememberCommand(command.id, payload);
        }
        if (generation !== bridgeGeneration) return;
        try {
          await bridgeRequest("/v1/result", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId, id: command.id, ...payload, info: bridgeContext() }),
          });
        } catch (error) {
          // Execution is never replayed when its result acknowledgement is lost.
          bridgeActivity(command, "finish", false, "Result acknowledgement was lost. Inspect the operation outcome before retrying.");
          throw error;
        }
        if (generation !== bridgeGeneration) return;
        bridgeActivity(command, "finish", payload.ok, payload.error);
      }
    } catch (error) {
      if (generation !== bridgeGeneration) return;
      bridgeSessionId = null;
      if (isRuntimeCallbackError(error)) {
        bridgeStatus("Figma stopped answering this plugin. Close it and run Local MCP Bridge again; if needed, use Help → Troubleshooting → Reload All Tabs.", "waiting", "restart-required");
        return;
      }
      if (isReplacementError(error)) {
        bridgeStatus("This plugin connection was replaced. Retry here only if this is the connection you want.", "waiting", "replaced");
        return;
      }
      failures += 1;
      bridgeStatus(`Waiting for local bridge… (${errorMessage(error)})`, "waiting", "reconnecting");
      await new Promise((resolve) => {
        const timer = setTimeout(() => { bridgeRetryWake = null; resolve(); }, reconnectDelay(failures));
        bridgeRetryWake = () => { clearTimeout(timer); bridgeRetryWake = null; resolve(); };
      });
    }
  }
}

function serializeNode(node) {
  const bounds = node.absoluteBoundingBox;
  const parent = node.parent && node.parent.type !== "DOCUMENT" ? node.parent : null;
  const style = {};
  if ("visible" in node) style.visible = node.visible;
  if ("locked" in node) style.locked = node.locked;
  if ("opacity" in node) style.opacity = node.opacity;
  if ("fills" in node) style.fills = node.fills === figma.mixed ? "mixed" : node.fills.slice(0, 4).map(summarizePaint);
  if ("strokes" in node) style.strokes = node.strokes === figma.mixed ? "mixed" : node.strokes.slice(0, 4).map(summarizePaint);
  if ("strokeWeight" in node) style.strokeWeight = mixedValue(node.strokeWeight);
  if ("cornerRadius" in node) style.cornerRadius = mixedValue(node.cornerRadius);
  if ("layoutMode" in node) style.layoutMode = node.layoutMode;
  if (node.type === "TEXT") {
    style.fontName = mixedValue(node.fontName);
    style.fontSize = mixedValue(node.fontSize);
    style.textAutoResize = node.textAutoResize;
    style.textAlignHorizontal = node.textAlignHorizontal;
    style.textCase = mixedValue(node.textCase);
  }
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    ...(bounds ? { bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } } : {}),
    ...(typeof node.x === "number" ? { x: node.x, y: node.y, width: node.width, height: node.height } : {}),
    ...(parent ? { parent: { id: parent.id, name: parent.name, type: parent.type } } : {}),
    childCount: "children" in node ? node.children.length : 0,
    style,
  };
}

function mixedValue(value) {
  return value === figma.mixed ? "mixed" : value;
}

function summarizePaint(paint) {
  const result = { type: paint.type, visible: paint.visible !== false, opacity: paint.opacity ?? 1 };
  if (paint.type === "SOLID") result.color = paint.color;
  if (paint.type === "IMAGE") result.scaleMode = paint.scaleMode;
  return result;
}

function nodePath(node) {
  const path = [];
  let current = node;
  while (current && current.type !== "DOCUMENT") {
    path.unshift({ id: current.id, name: current.name, type: current.type });
    current = current.parent;
  }
  return path;
}

function descendantsForQuery(input) {
  let nodes;
  if (input.selector && typeof figma.currentPage.query === "function") {
    nodes = figma.currentPage.query(input.selector).toArray();
  } else {
    nodes = figma.currentPage.findAll(() => true);
    if (input.query) {
      const query = input.query.toLowerCase();
      nodes = nodes.filter((node) => node.name.toLowerCase().includes(query));
    }
    if (input.nodeTypes?.length) nodes = nodes.filter((node) => input.nodeTypes.includes(node.type));
  }
  return nodes.slice(0, input.limit);
}

function hierarchy(node, depth, maxDepth) {
  const result = serializeNode(node);
  if (depth < maxDepth && "children" in node) {
    result.children = node.children.map((child) => hierarchy(child, depth + 1, maxDepth));
  }
  return result;
}

async function loadCurrentTextFonts(node) {
  const fonts = node.characters.length
    ? node.getStyledTextSegments(["fontName"]).map((segment) => segment.fontName)
    : [node.fontName];
  const seen = new Set();
  for (const font of fonts) {
    if (font === figma.mixed) continue;
    const key = `${font.family}\u0000${font.style}`;
    if (!seen.has(key)) {
      seen.add(key);
      await dsFont(font);
    }
  }
}

function textNodeById(nodeId) {
  const node = sceneNode(nodeId);
  if (node.type !== "TEXT") throw new Error(`Node ${nodeId} is not text.`);
  return node;
}

function styleSegmentCount(node) {
  return node.characters.length ? node.getStyledTextSegments(["fontName", "fontSize", "fills"]).length : 0;
}

function splitsSurrogatePair(text, index) {
  if (index <= 0 || index >= text.length) return false;
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function replaceTextPreservingStyles(node, nextText) {
  const previousText = node.characters;
  if (previousText === nextText) return { changed: false, prefixLength: previousText.length, removedLength: 0, insertedLength: 0, styleStrategy: "unchanged" };

  let prefixLength = 0;
  while (prefixLength < previousText.length && prefixLength < nextText.length && previousText[prefixLength] === nextText[prefixLength]) prefixLength += 1;
  let suffixLength = 0;
  while (
    suffixLength < previousText.length - prefixLength
    && suffixLength < nextText.length - prefixLength
    && previousText[previousText.length - 1 - suffixLength] === nextText[nextText.length - 1 - suffixLength]
  ) suffixLength += 1;

  if (splitsSurrogatePair(previousText, prefixLength) || splitsSurrogatePair(nextText, prefixLength)) prefixLength -= 1;
  while (suffixLength > 0 && (
    splitsSurrogatePair(previousText, previousText.length - suffixLength)
    || splitsSurrogatePair(nextText, nextText.length - suffixLength)
  )) suffixLength -= 1;

  const previousEnd = previousText.length - suffixLength;
  const nextEnd = nextText.length - suffixLength;
  const insertion = nextText.slice(prefixLength, nextEnd);
  const removesWholeValue = prefixLength === 0 && previousEnd === previousText.length;

  if (removesWholeValue && previousText.length > 0 && insertion.length > 0) {
    node.insertCharacters(0, insertion, "AFTER");
    node.deleteCharacters(insertion.length, insertion.length + previousText.length);
  } else {
    if (previousEnd > prefixLength) node.deleteCharacters(prefixLength, previousEnd);
    if (insertion.length > 0) node.insertCharacters(prefixLength, insertion, prefixLength > 0 ? "BEFORE" : "AFTER");
  }

  return {
    changed: true,
    prefixLength,
    removedLength: previousEnd - prefixLength,
    insertedLength: insertion.length,
    styleStrategy: removesWholeValue ? "first-existing-character" : "minimal-range",
  };
}

async function applyTextUpdates(updates) {
  const seen = new Set();
  const prepared = [];
  for (const update of updates) {
    if (seen.has(update.nodeId)) throw new Error(`Duplicate text update for ${update.nodeId}. Send each text node once per batch.`);
    seen.add(update.nodeId);
    const node = textNodeById(update.nodeId);
    if (update.expectedText !== undefined && node.characters !== update.expectedText) {
      throw new Error(`Text ${update.nodeId} changed since it was read. Re-read compact copy before applying this batch.`);
    }
    prepared.push({ update, node, before: node.characters, styleSegmentsBefore: styleSegmentCount(node) });
  }
  for (const item of prepared) await loadCurrentTextFonts(item.node);

  const results = [];
  for (const item of prepared) {
    const change = replaceTextPreservingStyles(item.node, item.update.text);
    results.push({
      nodeId: item.node.id,
      before: item.before,
      after: item.node.characters,
      ...change,
      styleSegmentsBefore: item.styleSegmentsBefore,
      styleSegmentsAfter: styleSegmentCount(item.node),
      verification: compactTextNode(figma.currentPage, item.node, 0),
    });
  }
  return {
    mutatedNodeIds: results.filter((item) => item.changed).map((item) => item.nodeId),
    updates: results,
  };
}

async function setTextFrame(input) {
  const node = textNodeById(input.nodeId);
  await loadCurrentTextFonts(node);
  const before = {
    width: node.width,
    height: node.height,
    textAutoResize: node.textAutoResize,
    textTruncation: node.textTruncation,
    maxLines: node.maxLines,
  };
  if (input.width !== undefined || input.height !== undefined) node.resize(input.width ?? node.width, input.height ?? node.height);
  if (input.autoResize !== undefined) {
    node.textAutoResize = input.autoResize === "fixed" ? "NONE" : input.autoResize === "height" ? "HEIGHT" : "WIDTH_AND_HEIGHT";
  }
  if (input.truncate !== undefined) node.textTruncation = input.truncate ? "ENDING" : "DISABLED";
  if (Object.prototype.hasOwnProperty.call(input, "maxLines")) {
    if (input.maxLines !== null) node.textTruncation = "ENDING";
    node.maxLines = input.maxLines;
  }
  focus(node);
  return {
    mutatedNodeIds: [node.id],
    before,
    after: {
      width: node.width,
      height: node.height,
      textAutoResize: node.textAutoResize,
      textTruncation: node.textTruncation,
      maxLines: node.maxLines,
    },
    text: compactTextNode(figma.currentPage, node, 0),
  };
}

async function setTextCase(input) {
  const node = textNodeById(input.nodeId);
  if (input.expectedText !== undefined && node.characters !== input.expectedText) {
    throw new Error(`Text ${node.id} changed since it was read. Re-read it before changing typographic case.`);
  }
  await loadCurrentTextFonts(node);
  const before = { text: node.characters, textCase: mixedValue(node.textCase) };
  node.textCase = figmaTextCase(input.textCase);
  focus(node);
  return {
    mutatedNodeIds: [node.id],
    before,
    after: { text: node.characters, textCase: mixedValue(node.textCase) },
    node: serializeNode(node),
  };
}

function hasInstanceAncestor(node) {
  let current = node.parent;
  while (current && current.type !== "DOCUMENT") {
    if (current.type === "INSTANCE") return true;
    current = current.parent;
  }
  return false;
}

async function splitTextBlock(input) {
  const node = textNodeById(input.nodeId);
  if (hasInstanceAncestor(node)) throw new Error("Text inside an instance cannot be split structurally. Detach or edit the source component first.");
  const parent = node.parent;
  if (!parent || !("insertChild" in parent) || !("children" in parent)) throw new Error("The text node's parent cannot accept a second text layer.");
  if (parent.layoutMode === "HORIZONTAL") throw new Error("Cannot split text into a vertical heading/body pair inside a horizontal auto-layout parent.");
  const original = node.characters;
  if (input.splitAt <= 0 || input.splitAt >= original.length) throw new Error("splitAt must leave non-empty heading and body text.");
  if (splitsSurrogatePair(original, input.splitAt)) throw new Error("splitAt falls inside a multi-unit character. Choose the boundary before or after it.");

  let headingEnd = input.splitAt;
  let bodyStart = input.splitAt;
  if (input.trimBoundary) {
    while (headingEnd > 0 && /\s/.test(original[headingEnd - 1])) headingEnd -= 1;
    while (bodyStart < original.length && /\s/.test(original[bodyStart])) bodyStart += 1;
  }
  if (headingEnd <= 0 || bodyStart >= original.length) throw new Error("The requested split would leave an empty heading or body after trimming.");
  if (splitsSurrogatePair(original, headingEnd) || splitsSurrogatePair(original, bodyStart)) throw new Error("The trimmed split falls inside a multi-unit character.");

  await loadCurrentTextFonts(node);
  const originalName = node.name;
  const originalWidth = node.width;
  const originalX = node.x;
  const originalY = node.y;
  const originalIndex = parent.children.indexOf(node);
  const body = node.clone();
  try {
    parent.insertChild(originalIndex + 1, body);
    body.deleteCharacters(0, bodyStart);
    body.name = input.bodyName ?? `${originalName} body`;
    if (input.autoResize === "height") {
      body.resize(originalWidth, Math.max(1, body.height));
      body.textAutoResize = "HEIGHT";
    }

    node.deleteCharacters(headingEnd, original.length);
    node.name = input.headingName ?? `${originalName} heading`;
    if (input.autoResize === "height") {
      node.resize(originalWidth, Math.max(1, node.height));
      node.textAutoResize = "HEIGHT";
    }

    if (parent.layoutMode !== "VERTICAL") {
      node.x = originalX;
      node.y = originalY;
      body.x = originalX;
      body.y = originalY + node.height + input.gap;
    }
    figma.currentPage.selection = [node, body];
    figma.viewport.scrollAndZoomIntoView([node, body]);
    return {
      mutatedNodeIds: [node.id],
      createdNodeIds: [body.id],
      heading: compactTextNode(figma.currentPage, node, 0),
      body: compactTextNode(figma.currentPage, body, 1),
    };
  } catch (error) {
    if (!body.removed) body.remove();
    throw error;
  }
}

async function applyCopyUpdates(input, reportProgress = async () => {}) {
  const updateResult = await applyTextUpdates(input.updates);
  const audits = [];
  for (const frameId of input.auditFrames) {
    try {
      audits.push({ frameId, result: await auditTextOverflow(sceneNode(frameId), { includeHidden: input.includeHidden }, reportProgress) });
    } catch (error) {
      audits.push({ frameId, error: errorMessage(error) });
    }
  }

  const exports = [];
  let totalExportBytes = 0;
  const maxBatchExportBytes = 45 * 1024 * 1024;
  for (const frameId of input.exportFrames) {
    try {
      const frame = sceneNode(frameId);
      const image = await screenshotNode(frame, input);
      const estimatedBytes = Math.floor(image.imageBase64.length * 0.75);
      if (totalExportBytes + estimatedBytes > maxBatchExportBytes) {
        exports.push({ frameId, error: "Skipped because successful batch exports would exceed the 45 MB bridge-response safety limit." });
        continue;
      }
      totalExportBytes += estimatedBytes;
      exports.push({ frameId, result: { ...image, nodeName: frame.name } });
    } catch (error) {
      exports.push({ frameId, error: errorMessage(error) });
    }
  }

  return {
    ...updateResult,
    audits,
    exports,
    verificationComplete: audits.every((item) => !item.error && item.result.complete === true) && exports.every((item) => !item.error),
  };
}

function orderedByPosition(nodes) {
  return [...nodes].sort((left, right) => {
    const leftBounds = left.absoluteBoundingBox;
    const rightBounds = right.absoluteBoundingBox;
    if (!leftBounds && !rightBounds) return left.name.localeCompare(right.name);
    if (!leftBounds) return 1;
    if (!rightBounds) return -1;
    const rowTolerance = Math.max(4, Math.min(leftBounds.height, rightBounds.height) * 0.5);
    if (Math.abs(leftBounds.y - rightBounds.y) > rowTolerance) return leftBounds.y - rightBounds.y;
    return leftBounds.x - rightBounds.x;
  });
}

function layoutBounds(node) {
  const bounds = node?.absoluteBoundingBox;
  if (bounds) return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  if (!node || typeof node.x !== "number" || typeof node.y !== "number" || typeof node.width !== "number" || typeof node.height !== "number") return null;
  let x = node.x;
  let y = node.y;
  let parent = node.parent;
  while (parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT") {
    x += typeof parent.x === "number" ? parent.x : 0;
    y += typeof parent.y === "number" ? parent.y : 0;
    parent = parent.parent;
  }
  return { x, y, width: node.width, height: node.height };
}

function layoutVisible(node) {
  let current = node;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    if (current.visible === false || current.opacity === 0) return false;
    current = current.parent;
  }
  return true;
}

function intersectBounds(left, right) {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const width = Math.min(left.x + left.width, right.x + right.width) - x;
  const height = Math.min(left.y + left.height, right.y + right.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height, area: width * height } : null;
}

function unionBounds(bounds) {
  if (!bounds.length) return null;
  const minX = Math.min(...bounds.map((item) => item.x));
  const minY = Math.min(...bounds.map((item) => item.y));
  const maxX = Math.max(...bounds.map((item) => item.x + item.width));
  const maxY = Math.max(...bounds.map((item) => item.y + item.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function proposedAbsoluteBounds(proposed, parent) {
  const parentBounds = parent.type === "PAGE" ? { x: 0, y: 0 } : layoutBounds(parent);
  if (!parentBounds) throw new Error("The proposed parent has no readable canvas bounds.");
  return { x: parentBounds.x + proposed.x, y: parentBounds.y + proposed.y, width: proposed.width, height: proposed.height };
}

function siblingCollisionReport(targetBounds, parent, excludedIds = [], includeHidden = false, limit = 250) {
  const excluded = new Set(excludedIds);
  const candidates = "children" in parent ? parent.children : [];
  const overlaps = [];
  for (const candidate of candidates) {
    if (excluded.has(candidate.id) || (!includeHidden && !layoutVisible(candidate))) continue;
    const bounds = layoutBounds(candidate);
    if (!bounds) continue;
    const intersection = intersectBounds(targetBounds, bounds);
    if (intersection) overlaps.push({ node: serializeNode(candidate), intersection });
    if (overlaps.length >= limit) break;
  }
  return { clear: overlaps.length === 0, overlapCount: overlaps.length, overlaps };
}

function canvasLayout(input) {
  const topLevel = figma.currentPage.children.filter((node) => input.includeHidden || layoutVisible(node));
  const topLevelBounds = topLevel.map(layoutBounds).filter(Boolean);
  const sections = topLevel.filter((node) => node.type === "SECTION").map((section) => ({
    id: section.id,
    name: section.name,
    bounds: layoutBounds(section),
    childCount: section.children.length,
    artboards: section.children.filter((child) => ["FRAME", "COMPONENT", "INSTANCE"].includes(child.type)).map((child) => ({ id: child.id, name: child.name, type: child.type, bounds: layoutBounds(child) })),
  }));
  let target = null;
  let parent = figma.currentPage;
  let bounds = null;
  const excludedIds = [...(input.ignoreNodeIds ?? [])];
  if (input.nodeId) {
    const node = sceneNode(input.nodeId);
    parent = node.parent;
    if (!parent || !("children" in parent)) throw new Error("The target node has no inspectable sibling container.");
    bounds = layoutBounds(node);
    if (!bounds) throw new Error("The target node has no readable canvas bounds.");
    target = { kind: "node", node: serializeNode(node), bounds };
    excludedIds.push(node.id);
  } else if (input.proposed) {
    parent = pageNode(input.proposed.parentId);
    if (!("children" in parent)) throw new Error("The proposed parent cannot contain children.");
    bounds = proposedAbsoluteBounds(input.proposed, parent);
    target = { kind: "proposed", bounds, relativeBounds: { x: input.proposed.x, y: input.proposed.y, width: input.proposed.width, height: input.proposed.height }, parentId: parent.id };
  }
  const collision = bounds ? siblingCollisionReport(bounds, parent, excludedIds, input.includeHidden, input.limit) : null;
  return {
    page: { id: figma.currentPage.id, name: figma.currentPage.name, unbounded: true },
    contentBounds: unionBounds(topLevelBounds),
    sections,
    topLevelNodes: topLevel.slice(0, input.limit).map((node) => serializeNode(node)),
    ...(target ? { target, parent: { id: parent.id, name: parent.name, type: parent.type }, collision } : {}),
    note: "Figma pages are unbounded; contentBounds is the occupied top-level canvas envelope, not a page boundary.",
  };
}

function orderedChildren(container) {
  if (!("children" in container)) return [];
  if (container.layoutMode === "HORIZONTAL") {
    return [...container.children].sort((left, right) => (left.absoluteBoundingBox?.x ?? left.x) - (right.absoluteBoundingBox?.x ?? right.x));
  }
  if (container.layoutMode === "VERTICAL") {
    return [...container.children].sort((left, right) => (left.absoluteBoundingBox?.y ?? left.y) - (right.absoluteBoundingBox?.y ?? right.y));
  }
  return orderedByPosition(container.children);
}

function textNodesInReadingOrder(root) {
  const results = [];
  function visit(node) {
    if (node.type === "TEXT") {
      results.push(node);
      return;
    }
    for (const child of orderedChildren(node)) visit(child);
  }
  for (const child of orderedChildren(root)) visit(child);
  return results;
}

function relativeHierarchy(root, node) {
  const path = [];
  let current = node;
  while (current) {
    path.unshift({ id: current.id, name: current.name, type: current.type });
    if (current.id === root.id) return path;
    current = current.parent;
  }
  return path;
}

function fontSizesForText(node) {
  return [...new Set(node.getStyledTextSegments(["fontSize"]).map((segment) => segment.fontSize))].sort((left, right) => left - right);
}

function visibilityInfo(root, node) {
  let current = node;
  let effectiveOpacity = 1;
  const hiddenBy = [];
  while (current) {
    if ("visible" in current && current.visible === false) hiddenBy.push({ id: current.id, name: current.name, reason: "visible=false" });
    if ("opacity" in current && typeof current.opacity === "number") {
      effectiveOpacity *= current.opacity;
      if (current.opacity === 0) hiddenBy.push({ id: current.id, name: current.name, reason: "opacity=0" });
    }
    if (current.id === root.id) break;
    current = current.parent;
  }
  return {
    visible: node.visible,
    opacity: node.opacity,
    effectiveOpacity,
    effectiveVisible: current?.id === root.id && hiddenBy.length === 0 && effectiveOpacity > 0,
    hiddenBy,
  };
}

function compactTextNode(root, node, readingIndex) {
  const visibility = visibilityInfo(root, node);
  return {
    readingIndex,
    id: node.id,
    copy: node.characters,
    bounds: node.absoluteBoundingBox,
    fontSizes: fontSizesForText(node),
    visible: visibility.visible,
    opacity: visibility.opacity,
    effectiveOpacity: visibility.effectiveOpacity,
    effectiveVisible: visibility.effectiveVisible,
  };
}

function compactCopy(root, includeHidden = false) {
  if (!("findAllWithCriteria" in root)) throw new Error("The target node cannot contain text descendants.");
  const allText = textNodesInReadingOrder(root).map((node, index) => compactTextNode(root, node, index));
  const text = includeHidden ? allText : allText.filter((item) => item.effectiveVisible);
  return {
    frame: { id: root.id, name: root.name, bounds: root.absoluteBoundingBox },
    textCount: text.length,
    excludedHiddenTextCount: allText.length - text.length,
    text,
    copy: text.map((item) => item.copy).filter(Boolean).join("\n"),
  };
}

function textContent(root, options = {}) {
  if (!("findAllWithCriteria" in root)) throw new Error("The target node cannot contain text descendants.");
  const textNodes = textNodesInReadingOrder(root);
  const text = textNodes.map((node, index) => {
    const visibility = visibilityInfo(root, node);
    return {
      readingIndex: index,
      id: node.id,
      name: node.name,
      characters: node.characters,
      bounds: node.absoluteBoundingBox,
      hierarchy: relativeHierarchy(root, node),
      fontSizes: fontSizesForText(node),
      ...visibility,
    };
  });
  const visibleText = text.filter((item) => item.effectiveVisible);
  return {
    frame: serializeNode(root),
    textCount: text.length,
    visibleTextCount: visibleText.length,
    hiddenTextCount: text.length - visibleText.length,
    text,
    copy: visibleText.map((item) => item.characters).filter(Boolean).join("\n"),
    allCopy: text.map((item) => item.characters).filter(Boolean).join("\n"),
    ...(options.auditLayout === true ? { layoutDiagnostics: (() => {
      const warnings = [];
      const nodes = root.findAll(node => !isInsideInstance(node) && visibilityInfo(root, node).effectiveVisible);
      for (const node of nodes) {
        if (!["FRAME", "INSTANCE"].includes(node.type)) continue;
        const parent = node.parent;
        if (!parent?.clipsContent || !node.absoluteBoundingBox || !parent.absoluteBoundingBox) continue;
        if (!containsBounds(parent.absoluteBoundingBox, node.absoluteBoundingBox, 1)) warnings.push({code:"CONTROL_OUTSIDE_CONTAINER",id:node.id,name:node.name,type:node.type,parentId:parent.id,parentName:parent.name,bounds:node.absoluteBoundingBox,parentBounds:parent.absoluteBoundingBox});
      }
      const groups = new Map();
      for (const node of nodes.filter(n => n.type === "TEXT" && n.characters.trim())) {const list=groups.get(node.parent.id)||[];list.push(node);groups.set(node.parent.id,list);}
      for (const list of groups.values()) for(let i=0;i<list.length;i++) for(let j=i+1;j<list.length;j++) {const a=list[i],b=list[j],A=a.absoluteBoundingBox,B=b.absoluteBoundingBox;if(!A||!B)continue;const ox=Math.min(A.x+A.width,B.x+B.width)-Math.max(A.x,B.x),oy=Math.min(A.y+A.height,B.y+B.height)-Math.max(A.y,B.y);if(ox>2&&oy>2)warnings.push({code:"SIBLING_TEXT_OVERLAP",a:{id:a.id,copy:a.characters,bounds:A},b:{id:b.id,copy:b.characters,bounds:B},parentId:a.parent.id,parentName:a.parent.name});}
      return warnings;
    })() } : {}),
    ...(options.auditPaints === true ? { nativePaints: [root, ...root.findAll(() => true)].filter(node => !isInsideInstance(node) && visibilityInfo(root, node).effectiveVisible).flatMap(node => {
      const record = {id: node.id, type: node.type, name: node.name};
      for (const [property, styleProperty] of [["fills", "fillStyleId"], ["strokes", "strokeStyleId"]]) {
        if (!(property in node) || node[property] === figma.mixed || node[styleProperty]) continue;
        const paints = node[property];
        if (paints.length === 1 && paints[0].type === "SOLID" && paints[0].visible !== false && !paints[0].boundVariables?.color) record[property] = paints.map(summarizePaint);
      }
      return record.fills || record.strokes ? [record] : [];
    }) } : {}),
  };
}

function containsBounds(outer, inner, tolerance = 0.5) {
  return inner.x >= outer.x - tolerance
    && inner.y >= outer.y - tolerance
    && inner.x + inner.width <= outer.x + outer.width + tolerance
    && inner.y + inner.height <= outer.y + outer.height + tolerance;
}

function clippingAncestorsWithin(root, node) {
  const ancestors = [];
  let current = node.parent;
  while (current && current.id !== root.id) {
    if ("clipsContent" in current && current.clipsContent && current.absoluteBoundingBox) ancestors.push(current);
    current = current.parent;
  }
  if (current?.id === root.id && "clipsContent" in current && current.clipsContent && current.absoluteBoundingBox) ancestors.push(current);
  return ancestors;
}

async function naturalTextMetrics(node) {
  if (node.hasMissingFont) return { error: "Missing font prevents reliable measurement." };
  await loadCurrentTextFonts(node);
  const probe = node.clone();
  try {
    figma.currentPage.appendChild(probe);
    probe.visible = false;
    probe.x = 100_000;
    probe.y = 100_000;
    probe.textAutoResize = "NONE";
    probe.resize(node.width, Math.max(1, node.height));
    probe.textAutoResize = "HEIGHT";
    const wrappedHeight = probe.height;
    probe.textAutoResize = "WIDTH_AND_HEIGHT";
    return { wrappedHeight, unwrappedWidth: probe.width, unwrappedHeight: probe.height };
  } finally {
    probe.remove();
  }
}

const overflowAuditCursors = new Map();
const overflowAuditCursorTtlMs = 5 * 60_000;
const overflowAuditCursorLimit = 8;
let overflowAuditSequence = 0;

function cleanOverflowAuditCursors(now = Date.now()) {
  for (const [cursor, state] of overflowAuditCursors) if (now - state.updatedAt > overflowAuditCursorTtlMs) overflowAuditCursors.delete(cursor);
}
function overflowAuditBudget(value, fallback, maximum, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${label} must be an integer from 1 to ${maximum}.`);
  return value;
}
function overflowAuditRootSignature(root) {
  const bounds = root.absoluteBoundingBox;
  return JSON.stringify([root.parent?.id, root.children?.length ?? 0, bounds?.x, bounds?.y, bounds?.width, bounds?.height]);
}
function overflowAuditChildren(entry) {
  if (entry.node.removed) throw new Error("The audited layer was removed. Start a fresh audit.");
  // The API returns an array for children. Reusing it prevents a wide parent
  // from allocating that full array again for every sibling visited.
  if (!entry.children) entry.children = "children" in entry.node ? entry.node.children : [];
  return entry.children;
}
function refreshOverflowAuditStack(state) {
  for (const entry of state.stack) {
    if (entry.node.removed) throw new Error("The audited layer was removed. Start a fresh audit.");
    const children = "children" in entry.node ? entry.node.children : [];
    if (entry.entered && (children.length !== entry.childCount || (entry.index > 0 && children[entry.index - 1]?.id !== entry.children[entry.index - 1]?.id)))
      throw new Error("The audited layer structure changed between batches. Start a fresh audit.");
    entry.children = children;
  }
}
function trimOverflowAuditStack(state) {
  while (state.stack.length) {
    const entry = state.stack[state.stack.length - 1];
    if (!entry.entered || entry.index < overflowAuditChildren(entry).length) break;
    state.stack.pop();
  }
}
function nextOverflowAuditNode(state) {
  trimOverflowAuditStack(state);
  if (!state.stack.length) return null;
  let entry = state.stack[state.stack.length - 1];
  if (entry.entered) {
    const child = overflowAuditChildren(entry)[entry.index++];
    if (!child || child.parent?.id !== entry.node.id) throw new Error("The audited layer structure changed between batches. Start a fresh audit.");
    if (state.stack.length >= 256) throw new Error("The audited layer nesting exceeds the safe depth limit. Audit a smaller frame.");
    entry = { node: child, entered: false, index: 0 };
    state.stack.push(entry);
  }
  entry.childCount = overflowAuditChildren(entry).length;
  entry.entered = true;
  return entry.node;
}

async function measureOverflowAuditText(root, node) {
  const rootBounds = root.absoluteBoundingBox;
    const bounds = node.absoluteBoundingBox;
    const warnings = [];
    let metrics;
    try {
      metrics = await naturalTextMetrics(node);
    } catch (error) {
      metrics = { error: errorMessage(error) };
      warnings.push({ code: "MEASUREMENT_FAILED", message: `Figma could not measure this text node: ${metrics.error}` });
    }
    if (node.hasMissingFont) warnings.push({ code: "MISSING_FONT", message: "Text uses a font unavailable to Figma, so overflow measurement is unreliable." });
    if (node.textTruncation === "ENDING" || node.textAutoResize === "TRUNCATE") {
      warnings.push({ code: "TRUNCATION_ENABLED", message: "Text is configured to truncate with an ellipsis." });
    }
    if (node.maxLines !== null && node.maxLines !== undefined) {
      warnings.push({ code: "MAX_LINES", message: `Text is limited to ${node.maxLines} lines.` });
    }
    if (metrics.wrappedHeight !== undefined && ["NONE", "TRUNCATE"].includes(node.textAutoResize) && metrics.wrappedHeight > node.height + 0.5) {
      warnings.push({ code: "VERTICAL_OVERFLOW", message: `Text needs approximately ${metrics.wrappedHeight.toFixed(1)}px height but its box is ${node.height.toFixed(1)}px.` });
    }
    if (bounds && rootBounds && !containsBounds(rootBounds, bounds)) {
      warnings.push({ code: "OUTSIDE_FRAME", message: "The text node extends outside the audited frame bounds." });
    }
    for (const ancestor of bounds ? clippingAncestorsWithin(root, node) : []) {
      if (!containsBounds(ancestor.absoluteBoundingBox, bounds)) {
        warnings.push({ code: "CLIPPED_BY_ANCESTOR", message: `Text extends outside clipping ancestor “${ancestor.name}” (${ancestor.id}).`, ancestorId: ancestor.id });
      }
    }
    const visibility = visibilityInfo(root, node);
    return {
      id: node.id,
      name: node.name,
      characters: node.characters,
      bounds,
      box: { width: node.width, height: node.height },
      hierarchy: relativeHierarchy(root, node),
      fontSizes: fontSizesForText(node),
      ...visibility,
      hasMissingFont: node.hasMissingFont,
      textAutoResize: node.textAutoResize,
      textTruncation: node.textTruncation,
      maxLines: node.maxLines,
      requiredSize: metrics.error ? { error: metrics.error } : { wrappedHeight: metrics.wrappedHeight, unwrappedWidth: metrics.unwrappedWidth, unwrappedHeight: metrics.unwrappedHeight },
      warnings,
    };
}

async function auditTextOverflow(root, options = {}, reportProgress = async () => {}) {
  if (!("children" in root)) throw new Error("The target node cannot contain text descendants.");
  cleanOverflowAuditCursors();
  const limits = {
    maxTextNodes: overflowAuditBudget(options.maxTextNodes, 40, 200, "maxTextNodes"),
    maxTraversalNodes: overflowAuditBudget(options.maxTraversalNodes, 400, 4_000, "maxTraversalNodes"),
    timeBudgetMs: overflowAuditBudget(options.timeBudgetMs, 1_000, 3_000, "timeBudgetMs"),
  };
  const includeHidden = options.includeHidden === true;
  let state;
  if (options.cursor !== undefined) {
    if (typeof options.cursor !== "string" || !overflowAuditCursors.has(options.cursor)) throw new Error("Audit cursor is unavailable or expired. Start a fresh audit in this plugin runtime.");
    state = overflowAuditCursors.get(options.cursor);
    if (state.rootId !== root.id || state.pageId !== figma.currentPage.id || state.includeHidden !== includeHidden)
      throw new Error("Audit cursor does not match this frame, page or includeHidden option. Resume with the original inputs or start a fresh audit.");
    overflowAuditCursors.delete(options.cursor);
    if (root.removed || overflowAuditRootSignature(root) !== state.rootSignature) throw new Error("The audited frame changed between batches. Start a fresh audit.");
    refreshOverflowAuditStack(state);
  } else {
    state = { rootId: root.id, pageId: figma.currentPage.id, includeHidden, rootSignature: overflowAuditRootSignature(root),
      stack: [{ node: root, entered: false, index: 0 }],
      totals: { visitedNodeCount: 0, textCount: 0, skippedHiddenTextCount: 0, warningCount: 0, visibleWarningCount: 0 } };
  }
  const text = [];
  const batch = { visitedNodeCount: 0, textCount: 0, skippedHiddenTextCount: 0, warningCount: 0, visibleWarningCount: 0, elapsedMs: 0 };
  let incompleteReason = null;
  let lastYieldVisits = 0;
  let lastYieldTexts = 0;
  const publishProgress = async (complete = false) => reportProgress({ phase: "text-audit",
    message: `Auditing ${root.name}: ${batch.textCount} text nodes measured, ${batch.visitedNodeCount} layers visited in this batch.${complete ? " Scan complete." : ""}`,
    current: batch.textCount, total: limits.maxTextNodes,
    percent: complete ? 100 : Math.min(99, Math.round(Math.max(batch.textCount / limits.maxTextNodes, batch.visitedNodeCount / limits.maxTraversalNodes) * 100)) });
  await publishProgress();
  const startedAt = Date.now();
  while (true) {
    trimOverflowAuditStack(state);
    if (!state.stack.length) break;
    if (batch.textCount >= limits.maxTextNodes) { incompleteReason = "text_limit"; break; }
    if (batch.visitedNodeCount >= limits.maxTraversalNodes) { incompleteReason = "traversal_limit"; break; }
    if (Date.now() - startedAt >= limits.timeBudgetMs) { incompleteReason = "time_limit"; break; }
    const node = nextOverflowAuditNode(state);
    if (!node) break;
    batch.visitedNodeCount++;
    state.totals.visitedNodeCount++;
    if (node.type === "TEXT") {
      if (!includeHidden && !visibilityInfo(root, node).effectiveVisible) {
        batch.skippedHiddenTextCount++;
        state.totals.skippedHiddenTextCount++;
      } else {
        const item = await measureOverflowAuditText(root, node);
        text.push(item);
        batch.textCount++;
        state.totals.textCount++;
        batch.warningCount += item.warnings.length;
        state.totals.warningCount += item.warnings.length;
        const visibleWarnings = item.effectiveVisible ? item.warnings.length : 0;
        batch.visibleWarningCount += visibleWarnings;
        state.totals.visibleWarningCount += visibleWarnings;
      }
    }
    if (batch.visitedNodeCount - lastYieldVisits >= 25 || batch.textCount - lastYieldTexts >= 5) {
      lastYieldVisits = batch.visitedNodeCount; lastYieldTexts = batch.textCount;
      await publishProgress();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  const complete = state.stack.length === 0;
  let nextCursor = null;
  if (!complete) {
    nextCursor = `overflow-audit-${++overflowAuditSequence}-${Math.random().toString(36).slice(2)}`;
    state.updatedAt = Date.now();
    overflowAuditCursors.set(nextCursor, state);
    while (overflowAuditCursors.size > overflowAuditCursorLimit) overflowAuditCursors.delete(overflowAuditCursors.keys().next().value);
  }
  batch.elapsedMs = Date.now() - startedAt;
  await publishProgress(complete);
  return {
    frame: serializeNode(root), includeHidden,
    complete, nextCursor, incompleteReason, batchOnly: true, order: "document",
    textCount: state.totals.textCount, skippedHiddenTextCount: state.totals.skippedHiddenTextCount,
    warningCount: state.totals.warningCount, visibleWarningCount: state.totals.visibleWarningCount,
    batch, totals: { ...state.totals }, limits, text,
    note: "Text contains only this batch; counts are cumulative. Resume nextCursor with the same frame and includeHidden option. The time limit is cooperative between Figma API calls. Restart if the document changes between batches.",
  };
}

function auditSummary(audit) {
  return {
    frame: { id: audit.frame.id, name: audit.frame.name, bounds: audit.frame.bounds },
    includeHidden: audit.includeHidden,
    textCount: audit.textCount,
    skippedHiddenTextCount: audit.skippedHiddenTextCount,
    warningCount: audit.warningCount,
    visibleWarningCount: audit.visibleWarningCount,
    complete: audit.complete,
    nextCursor: audit.nextCursor,
    incompleteReason: audit.incompleteReason,
    batchOnly: audit.batchOnly,
    order: audit.order,
    batch: audit.batch,
    totals: audit.totals,
    limits: audit.limits,
    note: audit.note,
    text: audit.text.map((item) => ({
      id: item.id,
      name: item.name,
      copy: item.characters,
      bounds: item.bounds,
      fontSizes: item.fontSizes,
      effectiveVisible: item.effectiveVisible,
      warnings: item.warnings,
    })),
  };
}

function base64(bytes) {
  let result = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)));
  }
  return btoa(result);
}

function constrainedScale(node, maxDimension, requestedScale) {
  const bounds = node.absoluteBoundingBox ?? node;
  const largestDimension = Math.max(bounds.width, bounds.height, 1);
  return Math.min(requestedScale, maxDimension / largestDimension);
}

async function screenshotNode(node, input) {
  if (!("exportAsync" in node)) throw new Error("The target node cannot be exported as an image.");
  const scale = constrainedScale(node, input.maxDimension, input.scale);
  const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
  const bounds = node.absoluteBoundingBox ?? node;
  return { imageBase64: base64(bytes), mimeType: "image/png", width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale), nodeId: node.id };
}

async function screenshotPage(input) {
  const sources = figma.currentPage.children.filter((node) => node.visible !== false && node.absoluteBoundingBox);
  if (sources.length === 0) throw new Error("The current page has no visible exportable nodes.");
  const boxes = sources.map((node) => node.absoluteBoundingBox);
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  const temporary = figma.createFrame();
  temporary.name = "__Local MCP temporary page screenshot";
  temporary.resize(Math.max(1, maxX - minX), Math.max(1, maxY - minY));
  temporary.x = minX;
  temporary.y = minY;
  temporary.fills = [];
  temporary.clipsContent = true;
  try {
    for (const source of sources) {
      const copy = source.clone();
      try {
        temporary.appendChild(copy);
        const box = source.absoluteBoundingBox;
        copy.x = box.x - minX;
        copy.y = box.y - minY;
      } catch {
        copy.remove();
      }
    }
    const image = await screenshotNode(temporary, input);
    return { ...image, nodeId: undefined, pageId: figma.currentPage.id };
  } finally {
    temporary.remove();
  }
}

function focus(node) {
  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);
}

function removeFailedCreation(node, error) {
  if (!node.removed) node.remove();
  throw error;
}

function compatibleAutoLayoutNode(node) {
  return node && ["FRAME", "COMPONENT", "INSTANCE", "COMPONENT_SET"].includes(node.type) ? node : null;
}

const indexedCurrentPageNodes = new Map();
function pageNode(nodeId) {
  if (!nodeId) return figma.currentPage;
  let node = indexedCurrentPageNodes.get(nodeId);
  if (node && !node.removed) {
    let page = node;
    while (page && page.type !== "PAGE") page = page.parent;
    if (page?.id === figma.currentPage.id) return node;
  }
  node = figma.currentPage.findOne((candidate) => candidate.id === nodeId);
  if (node) indexedCurrentPageNodes.set(nodeId, node);
  if (!node) throw new Error("The target node was not found on the current page.");
  return node;
}

function appendToParent(node, parentId) {
  const parent = pageNode(parentId);
  if (!("appendChild" in parent)) {
    throw new Error("The supplied parent cannot contain children.");
  }
  if (node.parent === parent) return;
  parent.appendChild(node);
}

function hexToColor(hex) {
  const value = hex.slice(1);
  return {
    r: Number.parseInt(value.slice(0, 2), 16) / 255,
    g: Number.parseInt(value.slice(2, 4), 16) / 255,
    b: Number.parseInt(value.slice(4, 6), 16) / 255,
  };
}

function solidPaint(hex, opacity = 1) {
  return { type: "SOLID", color: hexToColor(hex), opacity };
}

async function tokenPaint(hex, tokenId, opacity = 1) {
  const paint = solidPaint(hex ?? "#000000", opacity);
  if (!tokenId) return paint;
  const token = await figma.variables.getVariableByIdAsync(tokenId);
  if (!token || token.resolvedType !== "COLOR") throw new Error("The supplied colour token was not found or is not a colour variable.");
  return figma.variables.setBoundVariableForPaint(paint, "color", token);
}

async function applyVisualStyle(node, input) {
  let fill;
  let stroke;
  if ((input.fillColor !== undefined || input.fillTokenId !== undefined) && "fills" in node) {
    fill = await tokenPaint(input.fillColor, input.fillTokenId, input.fillOpacity ?? 1);
  }
  if ((input.strokeColor !== undefined || input.strokeTokenId !== undefined) && "strokes" in node) {
    stroke = await tokenPaint(input.strokeColor, input.strokeTokenId, input.strokeOpacity ?? 1);
  }
  if (fill) node.fills = [fill];
  if (stroke) node.strokes = [stroke];
  if (input.strokeWeight !== undefined && "strokeWeight" in node) node.strokeWeight = input.strokeWeight;
  if (input.opacity !== undefined && "opacity" in node) node.opacity = input.opacity;
  if (input.cornerRadius !== undefined && "cornerRadius" in node) node.cornerRadius = input.cornerRadius;
  if (input.clipsContent !== undefined && "clipsContent" in node) node.clipsContent = input.clipsContent;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function figmaTextCase(value = "original") {
  return value === "small-caps" ? "SMALL_CAPS" : value.toUpperCase();
}

async function createStyledText(input, parent) {
  const fonts = [{ family: input.fontFamily, style: input.fontStyle }];
  for (const span of input.spans ?? []) {
    fonts.push({ family: span.fontFamily ?? input.fontFamily, style: span.fontStyle ?? input.fontStyle });
    if (span.end > input.text.length) throw new Error(`Styled span ${span.start}–${span.end} exceeds text length ${input.text.length}.`);
    if (splitsSurrogatePair(input.text, span.start) || splitsSurrogatePair(input.text, span.end)) throw new Error(`Styled span ${span.start}–${span.end} splits a multi-unit character.`);
  }
  const loaded = new Set();
  for (const font of fonts) {
    const key = `${font.family}\u0000${font.style}`;
    if (!loaded.has(key)) {
      loaded.add(key);
      await dsFont(font);
    }
  }

  const node = figma.createText();
  try {
    parent.appendChild(node);
    node.name = input.name || input.text.replace(/\s+/g, " ").slice(0, 80) || "Text";
    node.fontName = fonts[0];
    node.fontSize = input.fontSize;
    if (input.lineHeight !== undefined) node.lineHeight = { unit: "PIXELS", value: input.lineHeight };
    if (input.letterSpacing !== undefined) node.letterSpacing = { unit: "PIXELS", value: input.letterSpacing };
    if (input.textAlign !== undefined) node.textAlignHorizontal = input.textAlign.toUpperCase();
    node.characters = input.text;
    node.textCase = figmaTextCase(input.textCase);
    if (input.width !== undefined) {
      node.resize(input.width, Math.max(1, node.height));
      node.textAutoResize = "HEIGHT";
    }
    node.x = input.x;
    node.y = input.y;
    await applyVisualStyle(node, input);

    for (const span of input.spans ?? []) {
      const font = { family: span.fontFamily ?? input.fontFamily, style: span.fontStyle ?? input.fontStyle };
      node.setRangeFontName(span.start, span.end, font);
      if (span.fontSize !== undefined) node.setRangeFontSize(span.start, span.end, span.fontSize);
      if (span.lineHeight !== undefined) node.setRangeLineHeight(span.start, span.end, { unit: "PIXELS", value: span.lineHeight });
      if (span.letterSpacing !== undefined) node.setRangeLetterSpacing(span.start, span.end, { unit: "PIXELS", value: span.letterSpacing });
      if (span.textCase !== undefined) node.setRangeTextCase(span.start, span.end, figmaTextCase(span.textCase));
      if (span.fillColor !== undefined) node.setRangeFills(span.start, span.end, [solidPaint(span.fillColor, span.fillOpacity ?? 1)]);
    }
    return node;
  } catch (error) {
    if (!node.removed) node.remove();
    throw error;
  }
}

function validateArchiveNodes(nodeIds, replacementNodeId) {
  const nodes = nodeIds.map(sceneNode);
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) throw new Error("Archive node IDs must be unique.");
  if (replacementNodeId && nodeIds.includes(replacementNodeId)) throw new Error("The replacement node cannot also be archived.");
  const parent = nodes[0].parent;
  if (!parent || !("children" in parent) || nodes.some((node) => node.parent !== parent)) throw new Error("Archive nodes must be siblings under the same page, frame, section, or group.");
  for (const node of nodes) {
    if (hasInstanceAncestor(node)) throw new Error(`Node ${node.id} is inside an instance and cannot be archived structurally.`);
    let current = node.parent;
    while (current && current !== parent) {
      if (nodeIds.includes(current.id)) throw new Error("Archive IDs cannot contain both an ancestor and its descendant.");
      current = current.parent;
    }
  }
  const replacement = replacementNodeId ? sceneNode(replacementNodeId) : null;
  return { nodes, parent, replacement };
}

function archiveNodes(input, prepared) {
  const { nodes, parent, replacement } = prepared ?? validateArchiveNodes(input.nodeIds, input.replacementNodeId);
  const previousChildren = new Set(parent.children);
  const snapshots = nodes.map((node) => ({ node, index: parent.children.indexOf(node), visible: node.visible, x: node.x, y: node.y, transform: node.relativeTransform ? cloneValue(node.relativeTransform) : null }));
  let group;
  try {
    group = figma.group(nodes, parent);
    group.name = input.archiveName;
    group.setPluginData("figma_local_bridge.archivedAt", new Date().toISOString());
    group.setPluginData("figma_local_bridge.replacementNodeId", replacement?.id ?? "");
    group.setPluginData("figma_local_bridge.reason", input.reason ?? "");
    group.visible = false;
    return {
      createdNodeIds: [group.id],
      mutatedNodeIds: nodes.map((node) => node.id),
      archive: { id: group.id, name: group.name, hidden: true, archivedNodeIds: nodes.map((node) => node.id), replacementNodeId: replacement?.id ?? null, reason: input.reason ?? null },
    };
  } catch (error) {
    // Grouping may throw after reparenting, before returning the new group.
    const groups = new Set([group, ...parent.children.filter((node) => !previousChildren.has(node) && node.type === "GROUP")].filter(Boolean));
    const unrestored = [];
    // Evacuate originals before removing temporary groups, so their indices
    // cannot displace unaffected siblings during final order restoration.
    for (const snapshot of snapshots) {
      try { parent.appendChild(snapshot.node); }
      catch (_) { unrestored.push(snapshot.node.id); }
    }
    for (const candidate of groups) if (!candidate.removed && candidate.children.length === 0) candidate.remove();
    for (const snapshot of snapshots.sort((a, b) => a.index - b.index)) {
      try {
        parent.insertChild(snapshot.index, snapshot.node);
        snapshot.node.visible = snapshot.visible;
        if (snapshot.transform) snapshot.node.relativeTransform = snapshot.transform;
        else { snapshot.node.x = snapshot.x; snapshot.node.y = snapshot.y; }
      } catch (_) {
        unrestored.push(snapshot.node.id);
      }
    }
    if (unrestored.length) throw new Error(`Archive failed and originals ${unrestored.join(", ")} could not be fully restored. Inspect these nodes before retrying.`);
    throw error;
  }
}

function applyComposedImage(node, element) {
  if (!element.imageSourceNodeId) return null;
  if (!("fills" in node)) throw new Error(`Composed element “${element.key}” cannot accept an image fill.`);
  const source = sceneNode(element.imageSourceNodeId);
  const { paint, adjustment } = copiedImagePaint(source, node, element.imageScaleMode, element.imageTransform);
  node.fills = [paint];
  return { sourceNodeId: source.id, scaleMode: paint.scaleMode, imageTransform: paint.imageTransform ?? null, adjustment };
}

function auditComposedImages(elements, byKey) {
  const required = elements.filter((element) => element.imageRequired || element.imageSourceNodeId);
  const warnings = [];
  for (const element of required) {
    const node = byKey.get(element.key);
    const fills = node && "fills" in node && node.fills !== figma.mixed ? node.fills : [];
    const filled = node && visibilityInfo(figma.currentPage, node).effectiveVisible
      && fills.some((fill) => fill.type === "IMAGE" && fill.imageHash && fill.visible !== false && (fill.opacity ?? 1) > 0);
    if (!filled) warnings.push({ key: element.key, nodeId: node?.id ?? null, name: element.name, warning: "Required image area has no visible image fill." });
  }
  return { requiredCount: required.length, filledCount: required.length - warnings.length, warningCount: warnings.length, warnings };
}

async function composeFrame(input, reportProgress = async () => {}) {
  await reportProgress({ phase: "preflight", message: "Checking composition inputs and archive targets.", current: 2, total: 100, percent: 2 });
  const keys = new Set();
  for (const element of input.elements) {
    if (keys.has(element.key)) throw new Error(`Duplicate compose element key “${element.key}”.`);
    if (element.parentKey && !keys.has(element.parentKey)) throw new Error(`Element “${element.key}” refers to parentKey “${element.parentKey}” before that parent is created.`);
    if (element.imageTransform && !element.imageSourceNodeId) throw new Error(`Element “${element.key}” supplies imageTransform without imageSourceNodeId.`);
    keys.add(element.key);
  }
  const preparedArchive = input.archiveNodeIds.length ? validateArchiveNodes(input.archiveNodeIds) : null;
  const root = figma.createFrame();
  const created = [root];
  const byKey = new Map();
  const imageFillAdjustments = [];
  try {
    await reportProgress({ phase: "root", message: "Creating the native root frame.", current: 8, total: 100, percent: 8 });
    root.name = input.frame.name;
    root.resize(input.frame.width, input.frame.height);
    appendToParent(root, input.frame.parentId);
    root.x = input.frame.x;
    root.y = input.frame.y;
    await applyVisualStyle(root, input.frame);
    applyAutoLayout(root, { direction: input.frame.layout ?? "none", itemSpacing: input.frame.itemSpacing ?? 0, padding: input.frame.padding ?? 0 });
    const rootBounds = layoutBounds(root);
    if (!rootBounds || !root.parent || !("children" in root.parent)) throw new Error("The composed frame has no inspectable canvas placement.");
    const placement = siblingCollisionReport(rootBounds, root.parent, [root.id, ...input.archiveNodeIds], false, 250);
    if ((input.collisionPolicy ?? "reject") === "reject" && !placement.clear) {
      throw new Error(`The composed frame would overlap ${placement.overlapCount} existing sibling node${placement.overlapCount === 1 ? "" : "s"}. Inspect canvas layout or choose collisionPolicy=report only when the overlap is intentional.`);
    }

    for (let index = 0; index < input.elements.length; index += 1) {
      const element = input.elements[index];
      const elementPercent = 12 + Math.round((index / Math.max(1, input.elements.length)) * 58);
      await reportProgress({ phase: "elements", message: `Creating ${element.name || element.key}.`, current: elementPercent, total: 100, percent: elementPercent });
      const parent = element.parentKey ? byKey.get(element.parentKey) : root;
      if (!parent || !("appendChild" in parent)) throw new Error(`Element “${element.key}” requires a frame parent.`);
      let node;
      if (element.type === "frame") {
        node = figma.createFrame();
        parent.appendChild(node);
        node.name = element.name;
        node.resize(element.width, element.height);
        node.x = element.x;
        node.y = element.y;
        await applyVisualStyle(node, element);
        applyAutoLayout(node, { direction: element.layout, itemSpacing: element.itemSpacing, padding: element.padding });
      } else if (element.type === "rectangle") {
        node = figma.createRectangle();
        parent.appendChild(node);
        node.name = element.name;
        node.resize(element.width, element.height);
        node.x = element.x;
        node.y = element.y;
        await applyVisualStyle(node, element);
      } else {
        node = await createStyledText(element, parent);
      }
      if (element.type !== "text") {
        const image = applyComposedImage(node, element);
        if (image?.adjustment) imageFillAdjustments.push({ key: element.key, nodeId: node.id, ...image.adjustment });
      }
      created.push(node);
      byKey.set(element.key, node);
    }

    if (created.length !== input.elements.length + 1 || byKey.size !== input.elements.length) {
      throw new Error(`Composition created ${created.length - 1} of ${input.elements.length} requested native elements.`);
    }

    await reportProgress({ phase: "image-audit", message: "Checking required image areas.", current: 74, total: 100, percent: 74 });
    const imageAudit = auditComposedImages(input.elements, byKey);
    if (input.audit) await reportProgress({ phase: "text-audit", message: "Auditing text overflow.", current: 80, total: 100, percent: 80 });
    const audits = input.audit ? [{ frameId: root.id, result: auditSummary(await auditTextOverflow(root, { includeHidden: false }, async (progress) => reportProgress({ ...progress, current: 80 + progress.percent * 0.06, total: 100, percent: 80 + progress.percent * 0.06 }))) }] : [];
    if (input.export) await reportProgress({ phase: "export", message: "Exporting the composed frame preview.", current: 88, total: 100, percent: 88 });
    const exports = input.export ? [{ frameId: root.id, result: { ...(await screenshotNode(root, input)), nodeName: root.name } }] : [];
    focus(root);
    const verificationComplete = audits.every((item) => !item.error && item.result.complete === true) && exports.every((item) => !item.error) && imageAudit.warningCount === 0;
    const result = {
      ok: true,
      createdNodeIds: created.map((node) => node.id),
      frame: serializeNode(root),
      elements: [...byKey].map(([key, node]) => ({ key, id: node.id, name: node.name, type: node.type })),
      placement,
      audits,
      imageAudit,
      imageFillAdjustments,
      exports,
      verificationComplete,
    };
    if (preparedArchive && verificationComplete) {
      await reportProgress({ phase: "archive", message: "Archiving the verified previous layout.", current: 96, total: 100, percent: 96 });
      const archived = archiveNodes({ nodeIds: input.archiveNodeIds, replacementNodeId: root.id, archiveName: input.archiveName, reason: input.archiveReason }, { ...preparedArchive, replacement: root });
      result.archived = archived.archive;
    } else if (preparedArchive) {
      result.archiveSkipped = { reason: "Composition verification is incomplete; previous nodes were preserved.", nodeIds: input.archiveNodeIds };
    }
    // The layout is committed. A lost progress connection must not undo it.
    try {
      await reportProgress({ phase: "complete", message: verificationComplete ? "Composition complete and verified." : "Composition complete with verification warnings.", current: 100, total: 100, percent: 100 });
    } catch (_) {}
    return result;
  } catch (error) {
    if (!root.removed) root.remove();
    throw error;
  }
}

function colorHex(color) {
  const channel = (value) => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`.toUpperCase();
}

async function listPageTokens(input) {
  const [variables, paintStyles, textStyles, effectStyles] = await Promise.all([
    figma.variables.getLocalVariablesAsync(), figma.getLocalPaintStylesAsync(), figma.getLocalTextStylesAsync(), figma.getLocalEffectStylesAsync(),
  ]);
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const collectionById = new Map(collections.map((collection) => [collection.id, collection]));
  const result = {
    variables: variables.slice(0, input.limit).map((variable) => ({
      id: variable.id, name: variable.name, type: variable.resolvedType, scopes: variable.scopes,
      collection: collectionById.get(variable.variableCollectionId)?.name ?? null,
      valuesByMode: cloneValue(variable.valuesByMode),
    })),
    paintStyles: paintStyles.slice(0, input.limit).map((style) => ({ id: style.id, name: style.name, paints: style.paints.map(summarizePaint) })),
    textStyles: textStyles.slice(0, input.limit).map((style) => ({ id: style.id, name: style.name, fontName: style.fontName, fontSize: style.fontSize, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, textCase: style.textCase })),
    effectStyles: effectStyles.slice(0, input.limit).map((style) => ({ id: style.id, name: style.name, effectCount: style.effects.length })),
  };
  if (input.includePageUsage) {
    const colors = new Map();
    const fonts = new Map();
    for (const node of figma.currentPage.findAll(() => true).slice(0, input.limit)) {
      if ("fills" in node && node.fills !== figma.mixed) {
        for (const paint of node.fills) if (paint.type === "SOLID") colors.set(colorHex(paint.color), { value: colorHex(paint.color), opacity: paint.opacity ?? 1 });
      }
      if (node.type === "TEXT") {
        for (const segment of node.getStyledTextSegments(["fontName", "fontSize"])) {
          const key = `${segment.fontName.family}\u0000${segment.fontName.style}\u0000${segment.fontSize}`;
          fonts.set(key, { family: segment.fontName.family, style: segment.fontName.style, size: segment.fontSize });
        }
      }
    }
    result.pageUsage = { colors: [...colors.values()], fonts: [...fonts.values()] };
  }
  return result;
}

function componentSummary(component, usageCount = 0) {
  return {
    id: component.id, key: component.key || null, name: component.name, description: component.description || "",
    remote: component.remote === true, usageCount,
    componentSet: component.parent?.type === "COMPONENT_SET"
      ? { id: component.parent.id, key: component.parent.key || null, name: component.parent.name, remote: component.parent.remote === true }
      : null,
    // Variants cannot report property definitions; the set owns them.
    componentProperties: cloneValue((component.parent?.type === "COMPONENT_SET" ? component.parent : component).componentPropertyDefinitions ?? {}),
  };
}

function styleSummary(style, usageCount = 0) {
  return { id: style.id, key: style.key || null, name: style.name, type: style.type, description: style.description || "", remote: style.remote === true, usageCount };
}

async function listDesignSystemAssets(input) {
  const usageByComponentId = new Map();
  const usedStyleIds = new Map();
  const pageNodes = figma.currentPage.findAll(() => true).slice(0, input.scanLimit);
  for (const node of pageNodes) {
    if (node.type === "INSTANCE") {
      const main = await node.getMainComponentAsync();
      if (main) usageByComponentId.set(main.id, (usageByComponentId.get(main.id) ?? 0) + 1);
    }
    for (const [aspect, property] of [["fill", "fillStyleId"], ["stroke", "strokeStyleId"], ["effect", "effectStyleId"], ["grid", "gridStyleId"], ["text", "textStyleId"]]) {
      const styleId = node[property];
      if (typeof styleId === "string" && styleId) {
        const usage = usedStyleIds.get(styleId) ?? { aspects: new Set(), count: 0 };
        usage.aspects.add(aspect);
        usage.count += 1;
        usedStyleIds.set(styleId, usage);
      }
    }
  }
  await figma.loadAllPagesAsync();
  const definitions = figma.root.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] }).filter((node) => !node.remote);
  const localComponents = definitions.filter((node) => node.type === "COMPONENT");
  const localComponentSets = definitions.filter((node) => node.type === "COMPONENT_SET");
  const [localPaintStyles, localTextStyles, localEffectStyles, localGridStyles, localVariables, localCollections] = await Promise.all([
    figma.getLocalPaintStylesAsync(), figma.getLocalTextStylesAsync(),
    figma.getLocalEffectStylesAsync(), figma.getLocalGridStylesAsync(), figma.variables.getLocalVariablesAsync(), figma.variables.getLocalVariableCollectionsAsync(),
  ]);
  const usedComponents = [];
  for (const [id, count] of usageByComponentId) {
    const component = await figma.getNodeByIdAsync(id);
    if (component?.type === "COMPONENT") usedComponents.push(componentSummary(component, count));
  }
  const usedStyles = [];
  for (const [id, usage] of usedStyleIds) {
    const style = await figma.getStyleByIdAsync(id);
    if (style) usedStyles.push({ ...styleSummary(style, usage.count), aspects: [...usage.aspects] });
  }
  let linkedLibraryVariableCollections = [];
  let linkedLibraryWarning = null;
  if (input.includeLinkedLibraries && figma.teamLibrary?.getAvailableLibraryVariableCollectionsAsync) {
    try {
      linkedLibraryVariableCollections = (await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()).slice(0, input.limit).map((collection) => ({ key: collection.key, name: collection.name, libraryName: collection.libraryName }));
    } catch (error) {
      linkedLibraryWarning = errorMessage(error);
    }
  }
  return {
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
    scan: { nodeCount: pageNodes.length, truncated: pageNodes.length === input.scanLimit },
    components: {
      used: usedComponents.slice(0, input.limit),
      local: localComponents.slice(0, input.limit).map((component) => componentSummary(component, usageByComponentId.get(component.id) ?? 0)),
      localSets: localComponentSets.slice(0, input.limit).map((set) => ({ id: set.id, key: set.key || null, name: set.name, description: set.description || "", remote: set.remote === true, variantGroupProperties: cloneValue(set.variantGroupProperties ?? {}) })),
    },
    styles: {
      used: usedStyles.slice(0, input.limit),
      local: [...localPaintStyles, ...localTextStyles, ...localEffectStyles, ...localGridStyles].slice(0, input.limit).map((style) => styleSummary(style)),
    },
    variables: {
      localCollections: localCollections.slice(0, input.limit).map((collection) => ({ id: collection.id, key: collection.key || null, name: collection.name, modes: collection.modes, variableCount: collection.variableIds.length })),
      local: localVariables.slice(0, input.limit).map((variable) => ({ id: variable.id, key: variable.key || null, name: variable.name, type: variable.resolvedType, collectionId: variable.variableCollectionId, scopes: variable.scopes })),
      linkedLibraryCollections: linkedLibraryVariableCollections,
    },
    ...(linkedLibraryWarning ? { warning: `Linked library variables could not be listed: ${linkedLibraryWarning}` } : {}),
    guidance: "Prefer a matching used remote component/style, then a local component/style or bound variable. A library must already be enabled in this Figma file; plugins cannot enable libraries.",
  };
}

async function createComponentInstance(input) {
  let component;
  if (input.componentId) {
    component = await figma.getNodeByIdAsync(input.componentId);
    if (component?.type !== "COMPONENT") throw new Error(`Component ${input.componentId} was not found in the current file.`);
  } else {
    component = await dsLibImport(`component:${input.componentKey}`, () => figma.importComponentByKeyAsync(input.componentKey));
  }
  const instance = component.createInstance();
  try {
    appendToParent(instance, input.parentId);
    instance.name = input.name ?? component.name;
    instance.x = input.x;
    instance.y = input.y;
    if (input.componentProperties && Object.keys(input.componentProperties).length) instance.setProperties(input.componentProperties);
    focus(instance);
    return { createdNodeIds: [instance.id], component: componentSummary(component), instance: serializeNode(instance), componentProperties: cloneValue(instance.componentProperties ?? {}) };
  } catch (error) {
    removeFailedCreation(instance, error);
  }
}

function partialStyleResult(targets, completedCount, hasCurrentTarget) {
  return {
    ok: false,
    partial: true,
    completedNodeIds: targets.slice(0, completedCount).map((node) => node.id),
    potentiallyMutatedNodeIds: hasCurrentTarget ? [targets[completedCount].id] : [],
    unattemptedNodeIds: targets.slice(completedCount + (hasCurrentTarget ? 1 : 0)).map((node) => node.id),
    error: "Figma could not complete the style operation. Re-read the affected nodes before retrying.",
  };
}

async function applyDesignStyle(input) {
  const style = input.styleId ? await figma.getStyleByIdAsync(input.styleId) : await dsLibImport(`style:${input.styleKey}`, () => figma.importStyleByKeyAsync(input.styleKey));
  if (!style) throw new Error("The requested Figma style was not found.");
  const targets = await Promise.all(input.targetNodeIds.map(id => figma.getNodeByIdAsync(id)));
  for (const node of targets) {
    if (!node || node.type === "PAGE" || node.type === "DOCUMENT") throw new Error("The target node was not found on the current page.");
    let ancestor = node;
    while (ancestor && ancestor.type !== "PAGE") ancestor = ancestor.parent;
    if (!ancestor || ancestor.id !== figma.currentPage.id) throw new Error("The target node was not found on the current page.");
  }
  const styleTypes = { fill: "PAINT", stroke: "PAINT", effect: "EFFECT", text: "TEXT" };
  const methods = { fill: "setFillStyleIdAsync", stroke: "setStrokeStyleIdAsync", effect: "setEffectStyleIdAsync", text: "setTextStyleIdAsync" };
  const method = methods[input.aspect];
  if (!method || style.type !== styleTypes[input.aspect]) throw new Error(`The requested style is incompatible with aspect ${input.aspect}.`);
  for (const target of targets) {
    if (typeof target[method] !== "function" || (input.aspect === "text" && target.type !== "TEXT")) throw new Error(`Node ${target.id} cannot accept a ${input.aspect} style.`);
  }
  if (input.aspect === "text") {
    for (const target of targets) await loadCurrentTextFonts(target);
    await dsFont(style.fontName);
  }
  // Independent style setters run in bounded groups, within this one bridge command.
  const completedNodeIds = [];
  for (let offset = 0; offset < targets.length; offset += 100) {
    const batch = targets.slice(offset, offset + 100);
    const results = await Promise.allSettled(batch.map(target => target[method](style.id)));
    const failedNodeIds = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") completedNodeIds.push(batch[index].id);
      else failedNodeIds.push(batch[index].id);
    });
    if (failedNodeIds.length) return {
      ok: false, partial: true, completedNodeIds,
      potentiallyMutatedNodeIds: failedNodeIds,
      unattemptedNodeIds: targets.slice(offset + batch.length).map(node => node.id),
      error: "Figma could not complete the style operation. Re-read the affected nodes before retrying."
    };
  }
  try {
    // Style linkage does not need to change the viewport or force repeated geometry reads.
    return { style: styleSummary(style), aspect: input.aspect, mutatedNodeIds: targets.map((target) => target.id), targets: targets.map(target => ({id: target.id, name: target.name, type: target.type})) };
  } catch (_) { return partialStyleResult(targets, targets.length, false); }
}

async function copyStyleFromNode(input) {
  const source = sceneNode(input.sourceNodeId);
  const targets = input.targetNodeIds.map(sceneNode);
  let textStyle = null;
  if (input.aspects.includes("typography")) {
    if (source.type !== "TEXT") throw new Error("Typography can only be copied from a text source node.");
    const segment = source.characters.length ? source.getStyledTextSegments(["fontName", "fontSize", "lineHeight", "letterSpacing", "textCase", "fills"])[0] : null;
    if (input.textSource === "whole" && [source.fontName, source.fontSize, source.lineHeight, source.letterSpacing, source.textCase].includes(figma.mixed)) throw new Error("Source typography is mixed; use textSource=first-span or choose a uniform source node.");
    textStyle = segment ?? { fontName: source.fontName, fontSize: source.fontSize, lineHeight: source.lineHeight, letterSpacing: source.letterSpacing, textCase: source.textCase, fills: source.fills };
    await figma.loadFontAsync(textStyle.fontName);
  }
  if (textStyle) {
    for (const target of targets) if (target.type !== "TEXT") throw new Error(`Typography target ${target.id} is not text.`);
    for (const target of targets) await loadCurrentTextFonts(target);
  }
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    try {
      if (input.aspects.includes("fills") && "fills" in source && "fills" in target && source.fills !== figma.mixed) target.fills = cloneValue(source.fills);
      if (input.aspects.includes("strokes") && "strokes" in source && "strokes" in target && source.strokes !== figma.mixed) {
        target.strokes = cloneValue(source.strokes);
        if ("strokeWeight" in source && "strokeWeight" in target && source.strokeWeight !== figma.mixed) target.strokeWeight = source.strokeWeight;
      }
      if (input.aspects.includes("effects") && "effects" in source && "effects" in target) target.effects = cloneValue(source.effects);
      if (input.aspects.includes("corners") && "cornerRadius" in source && "cornerRadius" in target && source.cornerRadius !== figma.mixed) target.cornerRadius = source.cornerRadius;
      if (input.aspects.includes("opacity") && "opacity" in source && "opacity" in target) target.opacity = source.opacity;
      if (input.aspects.includes("typography")) {
        target.fontName = textStyle.fontName;
        target.fontSize = textStyle.fontSize;
        target.lineHeight = textStyle.lineHeight;
        target.letterSpacing = textStyle.letterSpacing;
        target.textCase = textStyle.textCase;
        if (textStyle.fills && textStyle.fills !== figma.mixed) target.fills = cloneValue(textStyle.fills);
      }
    } catch (_) { return partialStyleResult(targets, index, true); }
  }
  try {
    if (targets.length) figma.viewport.scrollAndZoomIntoView(targets);
    return { sourceNodeId: source.id, mutatedNodeIds: targets.map((node) => node.id), targets: targets.map(serializeNode), aspects: input.aspects };
  } catch (_) { return partialStyleResult(targets, targets.length, false); }
}

function imageFill(node) {
  if (!("fills" in node) || node.fills === figma.mixed) throw new Error(`Node ${node.id} does not have readable fills.`);
  const paint = node.fills.find((fill) => fill.type === "IMAGE" && fill.imageHash);
  if (!paint) throw new Error(`Node ${node.id} has no image fill.`);
  return paint;
}

function aspectRatioChanged(width, height, nextWidth, nextHeight) {
  const horizontal = nextWidth * height;
  const vertical = nextHeight * width;
  return Math.abs(horizontal - vertical) > 1e-6 * Math.max(Math.abs(horizontal), Math.abs(vertical));
}

function copiedImagePaint(source, target, scaleMode, imageTransform) {
  const paint = cloneValue(imageFill(source));
  let adjustment = null;
  if (!scaleMode && !imageTransform && paint.scaleMode === "CROP"
    && aspectRatioChanged(source.width, source.height, target.width, target.height)) {
    paint.scaleMode = "FILL";
    adjustment = { from: "CROP", to: "FILL", reason: "aspect-ratio-changed" };
  }
  if (scaleMode) paint.scaleMode = scaleMode;
  if (imageTransform) {
    paint.scaleMode = "CROP";
    paint.imageTransform = imageTransform;
  } else if (paint.scaleMode !== "CROP") {
    delete paint.imageTransform;
  }
  return { paint, adjustment };
}

function copyImageFill(input) {
  const source = sceneNode(input.sourceNodeId);
  const target = sceneNode(input.targetNodeId);
  if (!("fills" in target)) throw new Error("Target node cannot accept image fills.");
  const { paint, adjustment } = copiedImagePaint(source, target, input.scaleMode, input.imageTransform);
  target.fills = [paint];
  focus(target);
  return { sourceNodeId: source.id, mutatedNodeIds: [target.id], target: serializeNode(target), image: { scaleMode: paint.scaleMode, imageTransform: paint.imageTransform ?? null, adjustment } };
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function placeLocalImage(input) {
  const node = figma.createRectangle();
  try {
    node.name = input.name;
    node.resize(input.width, input.height);
    appendToParent(node, input.parentId);
    node.x = input.x;
    node.y = input.y;
    const image = figma.createImage(decodeBase64(input.imageBase64));
    const paint = { type: "IMAGE", imageHash: image.hash, scaleMode: input.imageTransform ? "CROP" : input.scaleMode };
    if (input.imageTransform) paint.imageTransform = input.imageTransform;
    node.fills = [paint];
    if (input.cornerRadius !== undefined) node.cornerRadius = input.cornerRadius;
    if (input.opacity !== undefined) node.opacity = input.opacity;
    focus(node);
    return { createdNodeIds: [node.id], node: serializeNode(node), source: { path: input.sourcePath, mimeType: input.mimeType }, image: { scaleMode: paint.scaleMode, imageTransform: paint.imageTransform ?? null } };
  } catch (error) {
    return removeFailedCreation(node, error);
  }
}

function sceneNode(nodeId) {
  const node = pageNode(nodeId);
  if (node.type === "PAGE" || node.type === "DOCUMENT") throw new Error("Select a visible object, not the page.");
  return node;
}

function autoLayoutNode(nodeId) {
  if (nodeId) {
    return compatibleAutoLayoutNode(figma.currentPage.findOne((node) => node.id === nodeId));
  }
  if (figma.currentPage.selection.length !== 1) {
    throw new Error("Select exactly one frame, component, component set, or instance—or provide its node ID.");
  }
  return compatibleAutoLayoutNode(figma.currentPage.selection[0]);
}

function applyAutoLayout(node, input) {
  node.layoutMode = input.direction === "none" ? "NONE" : input.direction === "horizontal" ? "HORIZONTAL" : "VERTICAL";
  if (node.layoutMode !== "NONE") {
    node.itemSpacing = input.itemSpacing;
    node.paddingTop = input.padding;
    node.paddingRight = input.padding;
    node.paddingBottom = input.padding;
    node.paddingLeft = input.padding;
  }
}

async function fontRoots(rootIds) {
  if (!rootIds || !rootIds.length) return [figma.currentPage];
  const roots = [];
  for (const id of rootIds) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node) throw new Error(`Node ${id} was not found.`);
    // With dynamic page loading, a node on another page has no loaded descendants until its page loads.
    let page = node;
    while (page && page.type !== "PAGE") page = page.parent;
    if (page) await page.loadAsync();
    roots.push(node);
  }
  return roots;
}

function isInsideInstance(node) {
  for (let current = node.parent; current && current.type !== "PAGE"; current = current.parent) {
    if (current.type === "INSTANCE") return true;
  }
  return false;
}

// Text ranges as { start, end, fontName, textStyleId }, including empty layers, which have no segments.
function fontRanges(text) {
  if (text.characters.length === 0) {
    if (text.fontName === figma.mixed) return [];
    return [{ start: 0, end: 0, fontName: text.fontName, textStyleId: typeof text.textStyleId === "string" ? text.textStyleId : "" }];
  }
  return text.getStyledTextSegments(["fontName", "textStyleId"]);
}

// Read-only. Counts text ranges by font and by what decides that font: a text style (local or
// library), the main component (text inside an instance), or the layer itself.
async function fontInventory(input) {
  const roots = await fontRoots(input.rootIds);
  const maxNodes = input.maxNodes || 50_000;
  const fonts = new Map();
  const styleNames = new Map();
  let textNodes = 0;
  let truncated = false;
  for (const root of roots) {
    if (truncated) break;
    if (root.type === "PAGE") await root.loadAsync();
    const texts = root.type === "TEXT" ? [root] : root.findAllWithCriteria({ types: ["TEXT"] });
    for (const text of texts) {
      if (textNodes >= maxNodes) { truncated = true; break; }
      textNodes += 1;
      const inInstance = isInsideInstance(text);
      for (const range of fontRanges(text)) {
        const key = `${range.fontName.family}::${range.fontName.style}`;
        const entry = fonts.get(key) || { family: range.fontName.family, style: range.fontName.style, ranges: 0, libraryStyle: 0, localStyle: 0, instance: 0, layer: 0, styles: {}, samples: [] };
        entry.ranges += 1;
        if (range.textStyleId) {
          if (!styleNames.has(range.textStyleId)) {
            const style = await figma.getStyleByIdAsync(range.textStyleId);
            styleNames.set(range.textStyleId, style ? { name: style.name, remote: style.remote } : { name: "(missing style)", remote: false });
          }
          const style = styleNames.get(range.textStyleId);
          if (style.remote) entry.libraryStyle += 1; else entry.localStyle += 1;
          entry.styles[style.name] = (entry.styles[style.name] || 0) + 1;
        } else if (inInstance) entry.instance += 1;
        else entry.layer += 1;
        // sampleDetail returns { id, name, text, size, inInstance, visible } per sample instead of bare ids.
        if (entry.samples.length < (input.sampleLimit || 5)) {
          entry.samples.push(input.sampleDetail
            ? { id: text.id, name: text.name, text: text.characters.slice(range.start, range.end).slice(0, 60), size: text.characters.length ? text.getRangeFontSize(range.start, Math.max(range.end, range.start + 1)) : text.fontSize, inInstance, visible: text.visible }
            : text.id);
        }
        fonts.set(key, entry);
      }
    }
  }
  const localStyles = (await figma.getLocalTextStylesAsync()).map((style) => ({ id: style.id, name: style.name, fontName: style.fontName }));
  return {
    roots: roots.map((root) => ({ id: root.id, name: root.name, type: root.type })),
    textNodes,
    truncated,
    fonts: [...fonts.values()].sort((left, right) => right.ranges - left.ranges),
    localTextStyles: localStyles,
  };
}

// Centres section subheadings. A heading layer (TEXT, or a "Heading · …" wrapper frame around live text)
// forms a block with the eyebrow just above and the intro line just below; when its parent is a text-only
// header frame (Intro, Header, …) narrower than its section, that frame is the block. Text in the block is
// centre-aligned and the block is centred in its container. Split layouts, cards, overlays and long-form
// copy are skipped and listed.
async function centerSubheadings(input) {
  const dryRun = input.dryRun !== false;
  const headingRe = new RegExp(input.headingPattern || "^Heading( ·|$)");
  const excludeRe = new RegExp(input.excludeAncestorPattern || "Hero|^Archived|^Archive|^Previous|^Superseded|^Exploration|^Notes|^Dev handoff| · label$|^Library components");
  const cardRe = new RegExp(input.cardAncestorPattern || "[Cc]ard|Glass|Tile|Modal|Drawer|Dialog|Sheet|Popover|Toast|Banner|Overlay|Menu");
  const proseRe = new RegExp(input.proseAncestorPattern || "^(Article|Legal|Privacy|Terms|Policy|Prose|Body copy)|^\\d+\\. ");
  const eyebrowRe = new RegExp(input.eyebrowPattern || "^Eyebrow");
  const ledeRe = new RegExp(input.ledePattern || "^(Body|Intro|Lede|Lead|Subhead|Subheading|Sub ·|Description|Supporting|Subtitle)");
  const maxGap = input.maxGap || 48;
  const result = { dryRun, centred: 0, blocks: 0, alreadyCentred: 0, skipped: {}, samples: [], skippedSamples: [], errors: [], undo: [] };
  const skip = (reason, node) => {
    result.skipped[reason] = (result.skipped[reason] || 0) + 1;
    if (result.skippedSamples.length < (input.sampleLimit || 40)) result.skippedSamples.push({ id: node.id, name: node.name.slice(0, 60), parent: node.parent && node.parent.name.slice(0, 50), reason });
  };
  const visible = (node) => { let n = node; while (n && n.type !== "PAGE") { if (n.visible === false) return false; n = n.parent; } return true; };
  const textOf = (node) => node.type === "TEXT" ? node : node.findOne ? node.findOne((n) => n.type === "TEXT") : null;
  const alignText = async (text) => { if (!text || text.type !== "TEXT") return; await loadCurrentTextFonts(text); if (!dryRun) text.textAlignHorizontal = "CENTER"; };
  const besideIn = (nodes, host) => {
    const top = Math.min(...nodes.map((n) => n.y)), bottom = Math.max(...nodes.map((n) => n.y + n.height));
    const left = Math.min(...nodes.map((n) => n.x)), right = Math.max(...nodes.map((n) => n.x + n.width));
    return host.children.some((c) => !nodes.includes(c) && c.visible !== false && c.width > 24 && c.height > 24
      && c.y < bottom && c.y + c.height > top && (c.x >= right - 2 || c.x + c.width <= left + 2));
  };
  const columnBeside = (node) => {
    const host = node.parent;
    if (!host || !("children" in host) || host.type === "PAGE" || host.type === "SECTION") return false;
    if (host.layoutMode === "HORIZONTAL") return true;
    if (node.width > host.width * 0.8) return false;
    return besideIn([node], host);
  };
  const isHeaderFrame = (frame) => frame.type === "FRAME" && frame.children.filter((c) => c.visible !== false)
    .every((c) => c.type === "TEXT" || (c.type === "FRAME" && headingRe.test(c.name)) || c.height <= 64);
  const roots = await fontRoots(input.rootIds);
  for (const root of roots) {
    if (root.type === "PAGE") await root.loadAsync();
    const headings = root.findAll((n) => (n.type === "TEXT" || n.type === "FRAME") && headingRe.test(n.name));
    for (const heading of headings) {
      try {
        if (heading.type === "TEXT" && heading.parent && heading.parent.type === "FRAME" && headingRe.test(heading.parent.name)) continue;
        if (isInsideInstance(heading)) { skip("inside a component instance", heading); continue; }
        let a = heading.parent, reason = null, depth = 0;
        while (a && a.type !== "PAGE") {
          depth += 1;
          if (excludeRe.test(a.name)) { reason = "excluded"; break; }
          if (cardRe.test(a.name) && depth <= (input.cardDepth || 3)) { reason = "inside a card or overlay"; break; }
          if (proseRe.test(a.name)) { reason = "long-form copy"; break; }
          a = a.parent;
        }
        if (reason === "excluded") continue;
        if (reason) { skip(reason, heading); continue; }
        if (!visible(heading)) continue;
        const parent = heading.parent;
        if (!parent || parent.type !== "FRAME") { skip("parent is a group or section", heading); continue; }
        if (parent.layoutMode === "HORIZONTAL") { skip("split layout (row)", heading); continue; }
        const shown = (f) => f.children.filter((c) => c.visible !== false);
        // A header frame is a short stack: text, heading wrappers, small links or buttons, or one nested text column.
        const textish = (c) => c.type === "TEXT" || (c.type === "FRAME" && headingRe.test(c.name));
        const smallAction = (c) => (c.type === "INSTANCE" || c.type === "FRAME") && c.height <= 64 && c.width <= 420;
        const headerLike = (f, depth = 0) => !!f && f.type === "FRAME" && f.layoutMode !== "HORIZONTAL" && f.height <= 420
          && shown(f).length > 0 && shown(f).length <= 8
          && shown(f).every((c) => textish(c) || smallAction(c) || (depth === 0 && c.type === "FRAME" && headerLike(c, 1)))
          && f.findAll((n) => (n.type === "TEXT" || n.type === "FRAME") && headingRe.test(n.name)).length >= 1;
        const multiText = heading.type === "FRAME" && heading.findAll((n) => n.type === "TEXT").length > 1;
        let start = multiText ? heading : (headerLike(parent) ? parent : null);
        while (start && start.parent && start.parent.type === "FRAME" && headerLike(start.parent) && start.parent.width <= start.width + 2) start = start.parent;
        const headerBlock = !!start;
        let block, host;
        if (headerBlock) { block = [start]; host = start.parent; }
        else {
          const siblings = parent.children.filter((c) => c !== heading && c.visible !== false);
          const top = heading.y, bottom = heading.y + heading.height;
          const eyebrow = siblings.find((c) => c.type === "TEXT" && eyebrowRe.test(c.name) && c.y + c.height <= top + 4 && top - (c.y + c.height) <= maxGap && c.x < heading.x + heading.width && c.x + c.width > heading.x);
          const lede = siblings.find((c) => c.type === "TEXT" && ledeRe.test(c.name) && c.y >= bottom - 4 && c.y - bottom <= maxGap && c.x < heading.x + heading.width && c.x + c.width > heading.x);
          block = [eyebrow, heading, lede].filter(Boolean); host = parent;
        }
        if (!host || host.type !== "FRAME") { skip("parent is a group or section", heading); continue; }
        if (host.layoutMode === "HORIZONTAL") { skip("split layout (row)", heading); continue; }
        if ((host.layoutMode || "NONE") === "NONE" && besideIn(block, host)) { skip("split layout (content beside it)", heading); continue; }
        if (columnBeside(host)) { skip("split layout (column beside other content)", heading); continue; }
        // Frames whose children get centred, and the text layers to centre-align.
        const frames = headerBlock ? [start, ...start.findAll((n) => n.type === "FRAME" && !isInsideInstance(n) && n.parent && n.parent.type === "FRAME" && headerLike(n.parent) && headerLike(n))] : [];
        const texts = headerBlock ? start.findAll((n) => n.type === "TEXT" && !isInsideInstance(n) && n.visible !== false) : block.map(textOf).filter(Boolean);
        const cx = host.width / 2;
        const centredIn = (n, f) => Math.abs(n.x + n.width / 2 - f.width / 2) < 2;
        // Heading wrappers ("Heading · …" frames around one live text) inside the block.
        const wrappers = headerBlock ? start.findAll((n) => n.type === "FRAME" && headingRe.test(n.name) && n.findAll((m) => m.type === "TEXT").length === 1) : [];
        if (headerBlock && start.type === "FRAME" && headingRe.test(start.name) && start.findAll((m) => m.type === "TEXT").length === 1) wrappers.push(start);
        const already = texts.every((t) => t.textAlignHorizontal === "CENTER")
          && (headerBlock ? frames.every((f) => f.layoutMode === "VERTICAL" ? f.counterAxisAlignItems === "CENTER" : shown(f).every((c) => centredIn(c, f))) : true)
          && wrappers.every((w) => { const t = textOf(w); return !t || centredIn(t, w); })
          && ((host.layoutMode || "NONE") !== "NONE" || block.every((n) => Math.abs(n.x + n.width / 2 - cx) < 2));
        if (already) { result.alreadyCentred += 1; continue; }
        if (!dryRun) {
          const seen = new Set();
          const record = (n) => { if (!n || seen.has(n.id)) return; seen.add(n.id);
            result.undo.push({ id: n.id, x: n.x, align: n.type === "TEXT" ? n.textAlignHorizontal : undefined, layoutAlign: n.layoutAlign,
              counterAxisAlignItems: n.type === "FRAME" ? n.counterAxisAlignItems : undefined }); };
          texts.forEach(record); block.forEach(record);
          frames.forEach((f) => { record(f); shown(f).forEach(record); });
        }
        for (const t of texts) await alignText(t);
        if (!dryRun) {
          for (const f of frames) {
            if (f.layoutMode === "VERTICAL") f.counterAxisAlignItems = "CENTER";
            else if ((f.layoutMode || "NONE") === "NONE") for (const c of shown(f)) c.x = Math.round(f.width / 2 - c.width / 2);
          }
          for (const w of wrappers) { const t = textOf(w); if (t) { result.undo.push({ id: t.id, x: t.x }); t.x = Math.round((w.width - t.width) / 2); } }
          for (const node of block) {
            if (!headerBlock && node.type === "FRAME" && headingRe.test(node.name)) { const t = textOf(node); if (t) t.x = Math.round((node.width - t.width) / 2); }
            if ((host.layoutMode || "NONE") === "NONE") node.x = Math.round(cx - node.width / 2);
            else if (!headerBlock && node.layoutPositioning !== "ABSOLUTE") node.layoutAlign = "STRETCH";
          }
        }
        result.centred += 1;
        if (headerBlock) result.blocks += 1;
        if (result.samples.length < (input.sampleLimit || 40)) result.samples.push({ id: heading.id, name: heading.name.slice(0, 60), parent: parent.name.slice(0, 50), host: host.name.slice(0, 50), headerBlock, layout: host.layoutMode || "NONE", parts: block.length });
      } catch (error) {
        if (result.errors.length < 12) result.errors.push({ id: heading.id, name: heading.name, error: String(error && error.message || error) });
      }
    }
  }
  return result;
}

// Moves heading text to a new face. Rules match a range either by its own font
// ({ from: { family, style? } }, unstyled ranges only) or by the name of the text style it is bound to
// ({ fromStyleName: regex }); a style match detaches the range first. Optional per rule: namePattern
// (regex on the layer name) and minSize. to.italicStyle is used when the source style is italic.
// skipAncestorPattern skips layers under a matching ancestor (archives); exceptCharacters keeps
// whole-text matches (wordmarks); tracking [{ minSize, percent }] sets letter spacing on changed ranges.
// Text inside instances follows its main component and is counted, not changed. dryRun defaults to true.
async function retypeHeadings(input) {
  const dryRun = input.dryRun !== false;
  const rules = (input.rules || []).map((rule) => ({
    ...rule,
    styleRe: rule.fromStyleName ? new RegExp(rule.fromStyleName) : null,
    nameRe: rule.namePattern ? new RegExp(rule.namePattern) : null,
  }));
  if (!rules.length) throw new Error("Provide rules.");
  const skipRe = input.skipAncestorPattern ? new RegExp(input.skipAncestorPattern) : null;
  const instanceExcludeRe = input.instanceExcludePattern ? new RegExp(input.instanceExcludePattern) : null;
  const except = new Set((input.exceptCharacters || []).map((value) => String(value).trim()));
  const tracking = [...(input.tracking || [])].sort((a, b) => b.minSize - a.minSize);
  const available = new Set((await figma.listAvailableFontsAsync()).map((font) => `${font.fontName.family}::${font.fontName.style}`));
  const loaded = new Set();
  const load = async (font) => {
    const key = `${font.family}::${font.style}`;
    if (!loaded.has(key)) { await figma.loadFontAsync(font); loaded.add(key); }
  };
  const styleNames = new Map();
  const styleName = async (id) => {
    if (!id) return "";
    if (!styleNames.has(id)) { const style = await figma.getStyleByIdAsync(id); styleNames.set(id, style ? style.name : ""); }
    return styleNames.get(id);
  };
  const result = { dryRun, textNodes: 0, ranges: 0, detached: 0, skippedArchived: 0, skippedInstance: 0, skippedExcepted: 0,
    byRule: {}, mirrored: 0, instanceOverrides: 0, mirrorStyles: [], missingFonts: [], errors: [], samples: [], truncated: false };
  const missing = new Set();
  const mirrors = new Map();
  const localStyles = await figma.getLocalTextStylesAsync();
  const mirrorStyle = async (sourceId, target) => {
    const key = `${sourceId}::${target.family}::${target.style}`;
    if (mirrors.has(key)) return mirrors.get(key);
    const source = await figma.getStyleByIdAsync(sourceId);
    const face = target.style === "Regular" ? target.family : `${target.family} ${target.style}`;
    const name = `${source.name} · local mirror (${face})`;
    let style = localStyles.find((candidate) => candidate.name === name);
    if (!style) {
      style = figma.createTextStyle();
      style.name = name;
      await load(target);
      style.fontName = target;
      for (const field of ["fontSize", "lineHeight", "paragraphSpacing", "paragraphIndent", "textCase", "textDecoration", "listSpacing", "leadingTrim", "hangingPunctuation"]) {
        try { if (source[field] !== undefined) style[field] = source[field]; } catch (error) { /* field not supported here */ }
      }
      const rule2 = tracking.find((t) => source.fontSize >= t.minSize);
      style.letterSpacing = rule2 ? { unit: "PERCENT", value: rule2.percent } : source.letterSpacing;
      style.description = `Local stand-in for ${source.name} in ${face} until the design-system library publishes; swap back to the library style then.`;
      localStyles.push(style);
      result.mirrorStyles.push({ name, size: source.fontSize });
    }
    mirrors.set(key, style);
    return style;
  };
  const roots = await fontRoots(input.rootIds);
  const maxNodes = input.maxNodes || 40_000;
  let visited = 0;
  for (const root of roots) {
    if (result.truncated) break;
    if (root.type === "PAGE") await root.loadAsync();
    const texts = root.type === "TEXT" ? [root] : root.findAllWithCriteria({ types: ["TEXT"] });
    for (const text of texts) {
      if (visited >= maxNodes) { result.truncated = true; break; }
      visited += 1;
      if (skipRe) {
        let node = text.parent, archived = false;
        while (node && node.type !== "PAGE") { if (skipRe.test(node.name)) { archived = true; break; } node = node.parent; }
        if (archived) { result.skippedArchived += 1; continue; }
      }
      const plans = [];
      for (const range of fontRanges(text)) {
        const name = await styleName(range.textStyleId);
        const size = text.characters.length ? text.getRangeFontSize(range.start, Math.max(range.end, range.start + 1)) : text.fontSize;
        const rule = rules.find((candidate) => {
          if (candidate.styleRe) { if (!range.textStyleId || !candidate.styleRe.test(name)) return false; }
          else {
            if (range.textStyleId) return false;
            if (candidate.from.family !== range.fontName.family) return false;
            if (candidate.from.style && candidate.from.style !== range.fontName.style) return false;
          }
          if (candidate.nameRe && !candidate.nameRe.test(text.name)) return false;
          if (candidate.minSize && !(typeof size === "number" && size >= candidate.minSize)) return false;
          return true;
        });
        if (rule) plans.push({ range, rule, size, styleName: name });
      }
      if (!plans.length) continue;
      if (isInsideInstance(text)) {
        // includeInstances writes instance overrides (undo with Reset overrides), except layers named like instanceExcludePattern.
        if (!input.includeInstances || (instanceExcludeRe && instanceExcludeRe.test(text.name))) { result.skippedInstance += plans.length; continue; }
        result.instanceOverrides += plans.length;
      }
      if (except.has(text.characters.trim())) { result.skippedExcepted += plans.length; continue; }
      let touched = false;
      if (!dryRun) {
        // Figma refuses range writes while any font in the layer is unloaded.
        try { await loadCurrentTextFonts(text); } catch (error) { /* reported per range below */ }
      }
      for (const { range, rule, size } of plans) {
        const italic = /italic/i.test(range.fontName.style);
        const target = { family: rule.to.family, style: italic && rule.to.italicStyle ? rule.to.italicStyle : rule.to.style };
        if (!available.has(`${target.family}::${target.style}`)) { missing.add(`${target.family} ${target.style}`); continue; }
        const key = rule.label || rule.fromStyleName || `${rule.from.family}${rule.from.style ? " " + rule.from.style : ""}`;
        result.byRule[key] = (result.byRule[key] || 0) + 1;
        result.ranges += 1;
        touched = true;
        if (dryRun) continue;
        try {
          await load(range.fontName);
          await load(target);
          const end = Math.max(range.end, range.start + (text.characters.length ? 1 : 0));
          if (range.textStyleId && rule.mirrorStyle) {
            // Keep the layer style-linked: point it at a local copy of its style set in the new face.
            const mirror = await mirrorStyle(range.textStyleId, target);
            await text.setRangeTextStyleIdAsync(range.start, end, mirror.id);
            result.mirrored += 1;
            continue;
          }
          if (range.textStyleId) { await text.setRangeTextStyleIdAsync(range.start, end, ""); result.detached += 1; }
          if (text.characters.length === 0) text.fontName = target;
          else text.setRangeFontName(range.start, end, target);
          const rule2 = tracking.find((t) => typeof size === "number" && size >= t.minSize);
          if (rule2 && text.characters.length) text.setRangeLetterSpacing(range.start, end, { unit: "PERCENT", value: rule2.percent });
        } catch (error) {
          if (result.errors.length < 12) result.errors.push({ id: text.id, name: text.name, error: String(error && error.message || error) });
        }
      }
      if (touched) {
        result.textNodes += 1;
        if (result.samples.length < (input.sampleLimit || 12)) result.samples.push({ id: text.id, name: text.name, text: text.characters.slice(0, 40) });
      }
    }
  }
  result.missingFonts = [...missing];
  return result;
}

// Swaps fonts per map [{ from: { family, style? }, to: { family, style? } }]; a missing to.style keeps
// the range's own style. Updates local text styles that use a from font, and ranges that set their
// own font. Ranges bound to a text style follow the style, and text inside instances follows its main
// component, so both are skipped and counted. dryRun defaults to true and only counts.
async function retypeFont(input) {
  if (!Array.isArray(input.map) || !input.map.length) throw new Error("Provide map: [{ from: { family }, to: { family, style } }].");
  const dryRun = input.dryRun !== false;
  const available = new Set((await figma.listAvailableFontsAsync()).map((font) => `${font.fontName.family}::${font.fontName.style}`));
  const targetFor = (font) => {
    const rule = input.map.find((candidate) => candidate.from.family === font.family && (!candidate.from.style || candidate.from.style === font.style));
    return rule ? { family: rule.to.family, style: rule.to.style || font.style } : null;
  };
  const loaded = new Set();
  const load = async (font) => {
    const key = `${font.family}::${font.style}`;
    if (!available.has(key)) throw new Error(`${font.family} ${font.style} is not installed.`);
    if (!loaded.has(key)) { await figma.loadFontAsync(font); loaded.add(key); }
  };
  const result = { dryRun, textStyles: [], textNodes: 0, ranges: 0, renamed: 0, skippedStyled: 0, skippedInstance: 0, skippedExcepted: 0, missingFonts: [], errors: [], samples: [], truncated: false };
  const missing = new Set();
  // Layers whose whole text is listed here keep their font, e.g. a wordmark set in the brand face.
  const exceptCharacters = new Set((input.exceptCharacters || []).map((value) => String(value).trim()));

  if (input.updateLocalStyles !== false) {
    for (const style of await figma.getLocalTextStylesAsync()) {
      const target = targetFor(style.fontName);
      if (!target) continue;
      if (!available.has(`${target.family}::${target.style}`)) { missing.add(`${target.family} ${target.style}`); continue; }
      result.textStyles.push({ name: style.name, from: style.fontName, to: target });
      if (!dryRun) { await load(target); style.fontName = target; }
    }
  }

  const roots = await fontRoots(input.rootIds);
  const maxNodes = input.maxNodes || 20_000;
  let visited = 0;
  for (const root of roots) {
    if (result.truncated) break;
    if (root.type === "PAGE") await root.loadAsync();
    const texts = root.type === "TEXT" ? [root] : root.findAllWithCriteria({ types: ["TEXT"] });
    for (const text of texts) {
      if (visited >= maxNodes) { result.truncated = true; break; }
      visited += 1;
      const ranges = fontRanges(text).filter((range) => targetFor(range.fontName));
      if (!ranges.length) continue;
      if (isInsideInstance(text)) { result.skippedInstance += ranges.length; continue; }
      if (exceptCharacters.has(text.characters.trim())) { result.skippedExcepted += ranges.length; continue; }
      let touched = false;
      for (const range of ranges) {
        if (range.textStyleId) { result.skippedStyled += 1; continue; }
        const target = targetFor(range.fontName);
        if (!available.has(`${target.family}::${target.style}`)) { missing.add(`${target.family} ${target.style}`); continue; }
        result.ranges += 1;
        touched = true;
        if (dryRun) continue;
        try {
          await load(target);
          if (text.characters.length === 0) text.fontName = target;
          else text.setRangeFontName(range.start, range.end, target);
        } catch (error) {
          if (result.errors.length < 12) result.errors.push({ id: text.id, name: text.name, error: String(error && error.message || error) });
        }
      }
      if (touched) {
        result.textNodes += 1;
        if (result.samples.length < 12) result.samples.push({ id: text.id, name: text.name, text: text.characters.slice(0, 40) });
        if (input.rename && text.name.includes(input.rename.find)) {
          result.renamed += 1;
          if (!dryRun) text.name = text.name.split(input.rename.find).join(input.rename.replace);
        }
      }
    }
  }
  result.missingFonts = [...missing];
  return result;
}

// Resizes text set in one family by an exact size map (e.g. { "18": 22 }). Local text styles in that
// family are resized too; ranges bound to a style follow the style. Fixed pixel line heights scale
// with the size. Text inside instances is resized only when includeInstances is true (an override).
async function resizeFontSizes(input) {
  if (!input.family || !input.map) throw new Error("Provide family and map: { \"<fromSize>\": <toSize> }.");
  const dryRun = input.dryRun !== false;
  const sizeMap = new Map(Object.entries(input.map).map(([from, to]) => [Number(from), Number(to)]));
  const result = { dryRun, textStyles: [], textNodes: 0, ranges: 0, fixedBoxes: 0, skippedStyled: 0, skippedInstance: 0, skippedHidden: 0, otherSizes: {}, byName: {}, errors: [], samples: [], fixedSamples: [], truncated: false };
  const matches = (fontName) => fontName && fontName !== figma.mixed && fontName.family === input.family;
  const tally = (text, size) => {
    if (!input.reportNames) return;
    const key = `${text.name.split(" · ")[0].slice(0, 40)} @ ${size}`;
    result.byName[key] = (result.byName[key] || 0) + 1;
  };
  const scaleLineHeight = (lineHeight, from, to) =>
    lineHeight && lineHeight !== figma.mixed && lineHeight.unit === "PIXELS" ? { unit: "PIXELS", value: Math.round(lineHeight.value * to / from * 100) / 100 } : null;
  const loaded = new Set();
  const load = async (font) => { const key = `${font.family}::${font.style}`; if (!loaded.has(key)) { await figma.loadFontAsync(font); loaded.add(key); } };

  if (input.updateLocalStyles !== false) {
    for (const style of await figma.getLocalTextStylesAsync()) {
      if (!matches(style.fontName) || !sizeMap.has(style.fontSize)) continue;
      const to = sizeMap.get(style.fontSize);
      result.textStyles.push({ name: style.name, from: style.fontSize, to });
      if (dryRun) continue;
      await load(style.fontName);
      const lineHeight = scaleLineHeight(style.lineHeight, style.fontSize, to);
      style.fontSize = to;
      if (lineHeight) style.lineHeight = lineHeight;
    }
  }

  const roots = await fontRoots(input.rootIds);
  const maxNodes = input.maxNodes || 20_000;
  let visited = 0;
  for (const root of roots) {
    if (result.truncated) break;
    if (root.type === "PAGE") await root.loadAsync();
    const texts = root.type === "TEXT" ? [root] : root.findAllWithCriteria({ types: ["TEXT"] });
    for (const text of texts) {
      if (visited >= maxNodes) { result.truncated = true; break; }
      visited += 1;
      if (!text.characters.length) continue;
      const segments = text.getStyledTextSegments(["fontName", "fontSize", "lineHeight", "textStyleId"]).filter((segment) => matches(segment.fontName));
      if (!segments.length) continue;
      if (input.skipHidden !== false) {
        let hidden = false;
        for (let node = text; node && node.type !== "PAGE"; node = node.parent) if (node.visible === false) { hidden = true; break; }
        if (hidden) { result.skippedHidden += segments.length; continue; }
      }
      const inInstance = isInsideInstance(text);
      if (inInstance && !input.includeInstances) { result.skippedInstance += segments.length; continue; }
      let touched = false;
      for (const segment of segments) {
        if (!sizeMap.has(segment.fontSize)) { result.otherSizes[segment.fontSize] = (result.otherSizes[segment.fontSize] || 0) + 1; continue; }
        if (segment.textStyleId) { result.skippedStyled += 1; continue; }
        const to = sizeMap.get(segment.fontSize);
        result.ranges += 1;
        touched = true;
        tally(text, segment.fontSize);
        if (dryRun) continue;
        try {
          await load(segment.fontName);
          text.setRangeFontSize(segment.start, segment.end, to);
          const lineHeight = scaleLineHeight(segment.lineHeight, segment.fontSize, to);
          if (lineHeight) text.setRangeLineHeight(segment.start, segment.end, lineHeight);
        } catch (error) {
          if (result.errors.length < 12) result.errors.push({ id: text.id, name: text.name, error: String(error && error.message || error) });
        }
      }
      if (touched) {
        result.textNodes += 1;
        if (text.textAutoResize === "NONE" || text.textAutoResize === "TRUNCATE") {
          result.fixedBoxes += 1;
          if (result.fixedSamples.length < 40) result.fixedSamples.push({ id: text.id, name: text.name, text: text.characters.slice(0, 40) });
        }
        if (result.samples.length < 12) result.samples.push({ id: text.id, name: text.name, text: text.characters.slice(0, 40), sizes: [...new Set(segments.map((segment) => segment.fontSize))] });
      }
    }
  }
  return result;
}

// Read-only. Finds text in a family at given sizes (or bound to named local styles) whose box now
// overlaps a visible sibling in a parent without auto layout, e.g. after a font-size change.
async function textOverlapCheck(input) {
  const sizes = new Set((input.sizes || []).map(Number));
  const styleIds = new Set((await figma.getLocalTextStylesAsync()).filter((style) => (input.styleNames || []).includes(style.name)).map((style) => style.id));
  const roots = await fontRoots(input.rootIds);
  const result = { checked: 0, overlaps: [], truncated: false };
  const limit = input.limit || 200;
  const boxOf = (node) => node.absoluteBoundingBox;
  for (const root of roots) {
    if (root.type === "PAGE") await root.loadAsync();
    const texts = root.type === "TEXT" ? [root] : root.findAllWithCriteria({ types: ["TEXT"] });
    for (const text of texts) {
      if (!text.visible || !text.characters.length) continue;
      const parent = text.parent;
      if (!parent || !("children" in parent) || ("layoutMode" in parent && parent.layoutMode !== "NONE")) continue;
      if ("layoutPositioning" in text && text.layoutPositioning === "ABSOLUTE" && parent.layoutMode !== "NONE") continue;
      const segments = text.getStyledTextSegments(["fontName", "fontSize", "textStyleId"]);
      const hit = segments.some((segment) => (segment.fontName.family === input.family && sizes.has(segment.fontSize)) || styleIds.has(segment.textStyleId));
      if (!hit) continue;
      result.checked += 1;
      const a = boxOf(text);
      if (!a) continue;
      for (const sibling of parent.children) {
        if (sibling === text || !sibling.visible) continue;
        const b = boxOf(sibling);
        if (!b) continue;
        // Only siblings that start below the text's top and sit in the same column.
        if (b.y < a.y || b.x >= a.x + a.width || b.x + b.width <= a.x) continue;
        const overlap = a.y + a.height - b.y;
        if (overlap > 1) {
          result.overlaps.push({ id: text.id, name: text.name, text: text.characters.slice(0, 40), sibling: sibling.id, siblingName: sibling.name, overlap: Math.round(overlap) });
          if (result.overlaps.length >= limit) { result.truncated = true; return result; }
        }
      }
    }
  }
  return result;
}

// Shrinks absolutely positioned cards to their last visible child plus their side padding, keeps
// cards that share a row equal in height, then closes the gap: everything below moves up and each
// non-auto-layout ancestor shrinks, up to the first section, page or component set.
async function tightenCards(input) {
  const dryRun = input.dryRun !== false;
  const result = { dryRun, rows: [], ancestors: [], skipped: [] };
  const cards = [];
  for (const id of input.cardIds || []) cards.push(await dsNode(id));
  const visibleBottom = (card) => {
    let bottom = 0;
    for (const child of card.children) if (child.visible) bottom = Math.max(bottom, child.y + child.height);
    return bottom;
  };
  const sidePad = (card) => {
    const xs = card.children.filter((child) => child.visible && child.type === "TEXT").map((child) => child.x);
    return xs.length ? Math.min(...xs) : 24;
  };
  const isFreeFrame = (node) => node && ["FRAME", "COMPONENT"].includes(node.type) && (!("layoutMode" in node) || node.layoutMode === "NONE");
  const setHeight = (node, height) => {
    if (dryRun) return;
    if ("resizeWithoutConstraints" in node) node.resizeWithoutConstraints(node.width, height);
    else node.resize(node.width, height);
  };
  // Close a gap of `delta` in `container` below the line `cut` (container coordinates).
  const closeGap = (container, cut, delta, except) => {
    for (const child of container.children) {
      if (child === except) continue;
      if (child.y >= cut - 0.5) { if (!dryRun) child.y -= delta; continue; }
      const spans = child.y + child.height > cut + 0.5;
      if (spans && (child.type === "RECTANGLE" || child.height >= container.height - 1)) setHeight(child, child.height - delta);
      else if (spans) result.skipped.push({ id: child.id, name: child.name, reason: "spans the cut" });
    }
  };
  const propagate = (node, oldHeight, delta) => {
    let current = node;
    let currentOld = oldHeight;
    while (current.parent && isFreeFrame(current.parent)) {
      const parent = current.parent;
      const parentOld = parent.height;
      closeGap(parent, current.y + currentOld, delta, current);
      setHeight(parent, parentOld - delta);
      result.ancestors.push({ id: parent.id, name: parent.name, from: parentOld, to: parentOld - delta });
      current = parent;
      currentOld = parentOld;
    }
  };
  // Cards that share an ancestor named like input.uniformAncestorName get one (the tallest) height.
  const uniformKey = (card) => {
    if (!input.uniformAncestorName) return null;
    for (let node = card.parent; node; node = node.parent) if (node.name && node.name.includes(input.uniformAncestorName)) return node.id;
    return null;
  };
  const uniformHeights = new Map();
  for (const card of cards) {
    const key = uniformKey(card);
    if (!key) continue;
    uniformHeights.set(key, Math.max(uniformHeights.get(key) || 0, Math.ceil(visibleBottom(card) + sidePad(card))));
  }
  const uniformHeight = (card) => uniformHeights.get(uniformKey(card)) || 0;
  // Group cards by parent, then by row (same top), deepest parents first, rows bottom-up.
  const byParent = new Map();
  for (const card of cards) {
    if (!byParent.has(card.parent.id)) byParent.set(card.parent.id, { parent: card.parent, cards: [] });
    byParent.get(card.parent.id).cards.push(card);
  }
  const depth = (node) => { let d = 0; for (let n = node; n.parent; n = n.parent) d += 1; return d; };
  const groups = [...byParent.values()].sort((a, b) => depth(b.parent) - depth(a.parent));
  for (const { parent, cards: siblings } of groups) {
    const rows = new Map();
    for (const card of siblings) {
      const key = Math.round(card.y);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(card);
    }
    // Component variants are sized one by one; a set holds different breakpoints side by side.
    const ordered = parent.type === "COMPONENT_SET"
      ? siblings.map((card) => [card.y, [card]])
      : [...rows.entries()].sort((a, b) => b[0] - a[0]);
    for (const [, row] of ordered) {
      const oldHeight = Math.max(...row.map((card) => card.height));
      const own = Math.max(...row.map((card) => Math.ceil(visibleBottom(card) + sidePad(card))));
      const newHeight = parent.type === "COMPONENT_SET" ? own : Math.max(own, uniformHeight(row[0]));
      const delta = oldHeight - newHeight;
      result.rows.push({ parent: parent.id, cards: row.map((card) => card.id), from: oldHeight, to: newHeight });
      if (delta <= 0) continue;
      for (const card of row) setHeight(card, newHeight);
      if (isFreeFrame(parent)) {
        const parentOld = parent.height;
        closeGap(parent, row[0].y + oldHeight, delta, null);
        // Cards in this row were not moved by closeGap (they start above the cut).
        setHeight(parent, parentOld - delta);
        result.ancestors.push({ id: parent.id, name: parent.name, from: parentOld, to: parentOld - delta });
        propagate(parent, parentOld, delta);
      }
    }
  }
  return result;
}

// Makes room: in a free (non-auto-layout) container, moves every child that starts at or below
// `cut` down by `delta`, grows full-height backgrounds and the container itself, then repeats in
// each non-auto-layout ancestor (cut = the old bottom of the child it came from), stopping at the
// first section, page or auto-layout frame. Optional `alsoGrow` nodes grow by `delta` (row siblings)
// and `alsoMove` nodes move down by `delta`. Dry run unless dryRun is false.
async function dsShiftBelow(input) {
  const dryRun = input.dryRun !== false;
  const delta = input.delta;
  const result = { dryRun, moved: [], grown: [], skipped: [] };
  const isFreeFrame = (node) => node && ["FRAME", "COMPONENT"].includes(node.type) && (!("layoutMode" in node) || node.layoutMode === "NONE");
  const setHeight = (node, height) => {
    result.grown.push({ id: node.id, name: node.name, from: Math.round(node.height), to: Math.round(height) });
    if (dryRun) return;
    if ("resizeWithoutConstraints" in node) node.resizeWithoutConstraints(node.width, height);
    else node.resize(node.width, height);
  };
  const shift = (container, cut, except) => {
    for (const child of container.children) {
      if (child === except) continue;
      if (child.y >= cut - 0.5) { result.moved.push({ id: child.id, name: child.name }); if (!dryRun) child.y += delta; continue; }
      const spans = child.y + child.height > cut + 0.5;
      if (spans && (child.type === "RECTANGLE" || child.height >= container.height - 1)) setHeight(child, child.height + delta);
      else if (spans) result.skipped.push({ id: child.id, name: child.name, reason: "spans the cut" });
    }
  };
  for (const id of input.alsoGrow || []) { const node = await dsNode(id); setHeight(node, node.height + delta); }
  for (const id of input.alsoMove || []) { const node = await dsNode(id); result.moved.push({ id: node.id, name: node.name }); if (!dryRun) node.y += delta; }
  let container = await dsNode(input.containerId);
  if (!isFreeFrame(container)) throw new Error("containerId must be a frame without auto layout.");
  let cut = input.cut;
  let except = null;
  while (isFreeFrame(container)) {
    const oldHeight = container.height;
    shift(container, cut, except);
    setHeight(container, oldHeight + delta);
    except = container;
    cut = container.y + oldHeight;
    container = container.parent;
  }
  return result;
}

// Sets the font (and optionally letter spacing) of named local text styles; other properties stay.
async function setTextStyleFonts(input) {
  const dryRun = input.dryRun !== false;
  const styles = await figma.getLocalTextStylesAsync();
  const result = { dryRun, updated: [], notFound: [] };
  for (const spec of input.styles || []) {
    const style = styles.find((candidate) => candidate.name === spec.name || candidate.id === spec.name);
    if (!style) { result.notFound.push(spec.name); continue; }
    const fontName = { family: spec.family, style: spec.style };
    result.updated.push({ name: style.name, from: style.fontName, to: fontName, letterSpacing: spec.letterSpacingPercent ?? null });
    if (dryRun) continue;
    await figma.loadFontAsync(fontName);
    style.fontName = fontName;
    if (typeof spec.letterSpacingPercent === "number") style.letterSpacing = { unit: "PERCENT", value: spec.letterSpacingPercent };
  }
  return result;
}

// Sets local variable values in one mode (default: the collection's default mode).
async function setVariableValues(input) {
  const dryRun = input.dryRun !== false;
  const result = { dryRun, updated: [], notFound: [] };
  const local = await figma.variables.getLocalVariablesAsync();
  for (const item of input.items || []) {
    // item.id may be a variable ID or a local variable name such as "heading/family".
    const variable = local.find((candidate) => candidate.id === item.id || candidate.name === item.id)
      || await figma.variables.getVariableByIdAsync(item.id);
    if (!variable || variable.remote) { result.notFound.push(item.id); continue; }
    const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
    const modeId = item.modeId || collection.defaultModeId;
    result.updated.push({ id: variable.id, name: variable.name, from: variable.valuesByMode[modeId], to: item.value });
    if (!dryRun) variable.setValueForMode(modeId, item.value);
  }
  return result;
}

async function execute(name, input, reportProgress = async () => {}) {
  // A resumed audit must not combine measurements taken before and after bridge edits.
  if (mutatingCommands.has(name)) overflowAuditCursors.clear();
  const refs = new Set();
  const collect = (value, key = "") => {
    if (typeof value === "string" && /(?:node|parent|frame).*Ids?$/i.test(key) && /^(?:I)?\d+:\d+/.test(value)) refs.add(value);
    else if (Array.isArray(value)) value.forEach(v => collect(v, key));
    else if (value && typeof value === "object") Object.entries(value).forEach(([k,v]) => collect(v,k));
  };
  collect(input);
  for (const id of refs) {
    const node = await figma.getNodeByIdAsync(id);
    if (node && node.type !== "DOCUMENT") {
      let page = node; while (page && page.type !== "PAGE") page = page.parent;
      if (page?.id === figma.currentPage.id) indexedCurrentPageNodes.set(id, node);
    }
  }
  if (name === "setVariableValues") return setVariableValues(input);
  if (name === "fontInventory") return fontInventory(input);
  if (name === "retypeFont") return retypeFont(input);
  if (name === "resizeFontSizes") return resizeFontSizes(input);
  if (name === "textOverlapCheck") return textOverlapCheck(input);
  if (name === "tightenCards") return tightenCards(input);
  if (name === "retypeHeadings") return retypeHeadings(input);
  if (name === "centerSubheadings") return centerSubheadings(input);
  if (name === "setTextStyleFonts") return setTextStyleFonts(input);

  if (name === "getSelection") {
    return { page: { id: figma.currentPage.id, name: figma.currentPage.name }, selection: figma.currentPage.selection.map(serializeNode) };
  }

  if (name === "listPages") {
    return figma.root.children.map((page) => ({ id: page.id, name: page.name, isCurrent: page.id === figma.currentPage.id }));
  }

  if (name === "navigateToPage") {
    const page = figma.root.children.find((candidate) => candidate.id === input.pageId || candidate.name === input.pageName);
    if (!page) throw new Error("No page with that ID or exact name exists in this file.");
    await figma.setCurrentPageAsync(page);
    figma.currentPage.selection = [];
    return { page: { id: page.id, name: page.name } };
  }

  if (name === "createPage") {
    const pageName = String(input.name ?? "").trim();
    if (!pageName) throw new Error("A page name is required.");
    // Idempotent by exact name, so a retry after a timeout never adds a duplicate page.
    let page = figma.root.children.find((candidate) => candidate.name === pageName);
    const created = !page;
    if (created) {
      page = figma.createPage();
      page.name = pageName;
      if (Number.isInteger(input.index)) {
        figma.root.insertChild(Math.max(0, Math.min(input.index, figma.root.children.length - 1)), page);
      }
    }
    if (input.navigate !== false) {
      await figma.setCurrentPageAsync(page);
      figma.currentPage.selection = [];
    }
    return {
      created,
      page: { id: page.id, name: page.name, index: figma.root.children.indexOf(page), isCurrent: page.id === figma.currentPage.id },
    };
  }

  if (name === "queryPageNodes") {
    const nodes = descendantsForQuery(input);
    if (input.includeHierarchy) {
      return {
        page: { id: figma.currentPage.id, name: figma.currentPage.name },
        nodes: figma.currentPage.children.slice(0, input.limit).map((node) => hierarchy(node, 0, input.maxDepth)),
      };
    }
    return {
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      count: nodes.length,
      nodes: nodes.map((node) => ({ ...serializeNode(node), path: nodePath(node) })),
    };
  }

  if (name === "inspectCanvasLayout") return canvasLayout(input);

  if (name === "listArtboards") {
    const artboards = [];
    for (const child of figma.currentPage.children) {
      if (["FRAME", "COMPONENT", "INSTANCE"].includes(child.type)) artboards.push(child);
      if (child.type === "SECTION") {
        for (const sectionChild of child.children) {
          if (["FRAME", "COMPONENT", "INSTANCE"].includes(sectionChild.type)) artboards.push(sectionChild);
        }
      }
    }
    const ordered = orderedByPosition(artboards);
    return {
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      count: ordered.length,
      artboards: ordered.map((node, index) => ({
        index,
        id: node.id,
        name: node.name,
        type: node.type,
        bounds: node.absoluteBoundingBox,
        parent: node.parent?.type === "SECTION" ? { id: node.parent.id, name: node.parent.name, type: node.parent.type } : null,
        childCount: "children" in node ? node.children.length : 0,
      })),
    };
  }

  if (name === "readFrameContent") {
    const root = sceneNode(input.nodeId);
    return input.detail === "full" ? textContent(root, input) : compactCopy(root, input.includeHidden);
  }

  if (name === "readCopy") {
    const frames = input.nodeIds.map((id) => compactCopy(sceneNode(id), input.includeHidden));
    return {
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      includeHidden: input.includeHidden === true,
      frameCount: frames.length,
      excludedHiddenTextCount: frames.reduce((count, frame) => count + frame.excludedHiddenTextCount, 0),
      frames,
      copy: frames.map((frame) => frame.copy).join("\n\n"),
    };
  }

  if (name === "readSpreadContent") {
    const frames = input.nodeIds.map((id) => input.detail === "full" ? textContent(sceneNode(id), input) : compactCopy(sceneNode(id), input.includeHidden));
    return {
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      frameCount: frames.length,
      frames,
      copy: frames.map((frame) => frame.copy).join("\n\n"),
      ...(input.detail === "full" ? { allCopy: frames.map((frame) => frame.allCopy).join("\n\n") } : {}),
    };
  }

  if (name === "prepareReviewData") {
    const roots = input.nodeIds.map((id) => sceneNode(id));
    const frames = roots.map((root) => input.detail === "full" ? textContent(root, input) : compactCopy(root, false));
    const content = roots.length === 1 ? frames[0] : {
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      frameCount: frames.length,
      frames,
      copy: frames.map((frame) => frame.copy).join("\n\n"),
      ...(input.detail === "full" ? { allCopy: frames.map((frame) => frame.allCopy).join("\n\n") } : {}),
    };
    const overflowAudits = [];
    if (input.auditOverflow) {
      for (const root of roots) {
        const audit = await auditTextOverflow(root, { includeHidden: false }, reportProgress);
        overflowAudits.push(input.detail === "full" ? audit : auditSummary(audit));
      }
    }
    return { content, overflowAudits, verificationComplete: overflowAudits.every((audit) => audit.complete === true) };
  }

  if (name === "auditTextOverflow") {
    const audit = await auditTextOverflow(sceneNode(input.nodeId), input, reportProgress);
    return input.detail === "full" ? audit : auditSummary(audit);
  }

  if (name === "applyCopyUpdates") return applyCopyUpdates(input, reportProgress);

  if (name === "exportFramePng") {
    const node = sceneNode(input.nodeId);
    const image = await screenshotNode(node, input);
    return { ...image, nodeName: node.name };
  }

  if (name === "screenshot") {
    return input.target === "page" ? screenshotPage(input) : screenshotNode(sceneNode(input.nodeId), input);
  }

  if (name === "setSelection") {
    const nodes = input.nodeIds.map((id) => sceneNode(id));
    figma.currentPage.selection = nodes;
    if (nodes.length > 0) figma.viewport.scrollAndZoomIntoView(nodes);
    return { page: { id: figma.currentPage.id, name: figma.currentPage.name }, selection: nodes.map(serializeNode) };
  }

  if (name === "moveResizeReparent") {
    const node = sceneNode(input.nodeId);
    const parent = input.parentId ? pageNode(input.parentId) : null;
    if (parent && !("appendChild" in parent)) throw new Error("The supplied parent cannot contain children.");
    if (input.width !== undefined || input.height !== undefined) {
      if (!("resize" in node)) throw new Error("The target node cannot be resized.");
    }
    if (parent && node.parent !== parent) parent.appendChild(node);
    const imageResizeAdjustments = [];
    if (input.width !== undefined || input.height !== undefined) {
      const nextWidth = input.width ?? node.width;
      const nextHeight = input.height ?? node.height;
      // Compare relative proportions so very narrow/tall images use the same tolerance.
      const aspectChanged = aspectRatioChanged(node.width, node.height, nextWidth, nextHeight);
      const fills = "fills" in node && node.fills !== figma.mixed ? node.fills : null;
      const resetCropFills = aspectChanged && fills?.some((paint) => paint.type === "IMAGE" && paint.scaleMode === "CROP");
      const originalFills = resetCropFills ? cloneValue(fills) : null;

      if (resetCropFills) {
        const safeFills = cloneValue(fills);
        for (let index = 0; index < safeFills.length; index += 1) {
          const paint = safeFills[index];
          if (paint.type !== "IMAGE" || paint.scaleMode !== "CROP") continue;
          safeFills[index] = { ...paint, scaleMode: "FILL" };
          delete safeFills[index].imageTransform;
          imageResizeAdjustments.push({ fillIndex: index, from: "CROP", to: "FILL", reason: "aspect-ratio-changed" });
        }
        await node.setFillsAsync(safeFills);
      }

      try {
        node.resize(nextWidth, nextHeight);
      } catch (error) {
        if (originalFills) {
          try { await node.setFillsAsync(originalFills); }
          catch (_) { throw new Error(`Resize failed, and the original crop fill on node ${node.id} could not be restored. Inspect the node before retrying.`); }
        }
        throw error;
      }
    }
    if (input.x !== undefined) node.x = input.x;
    if (input.y !== undefined) node.y = input.y;
    focus(node);
    return { mutatedNodeIds: [node.id], node: serializeNode(node), imageResizeAdjustments };
  }

  if (name === "readText") {
    const node = sceneNode(input.nodeId);
    if (node.type !== "TEXT") throw new Error("The target node is not text.");
    return {
      ...serializeNode(node),
      text: node.characters,
      segments: node.getStyledTextSegments(["fontName", "fontSize", "textCase", "fills"]).map((segment) => ({
        start: segment.start,
        end: segment.end,
        characters: segment.characters,
        fontName: mixedValue(segment.fontName),
        fontSize: mixedValue(segment.fontSize),
        textCase: mixedValue(segment.textCase),
      })),
    };
  }

  if (name === "updateText") {
    const result = await applyTextUpdates([{ nodeId: input.nodeId, text: input.text, expectedText: input.expectedText }]);
    const node = textNodeById(input.nodeId);
    focus(node);
    return { ...result, node: serializeNode(node), text: node.characters };
  }

  if (name === "setTextFrame") return setTextFrame(input);

  if (name === "setTextCase") return setTextCase(input);

  if (name === "splitTextBlock") return splitTextBlock(input);

  if (name === "archiveNodes") return archiveNodes(input);

  if (name === "composeFrame") return composeFrame(input, reportProgress);

  if (name === "copyStyleFromNode") return copyStyleFromNode(input);

  if (name === "listPageTokens") return listPageTokens(input);

  if (name === "listDesignSystemAssets") return listDesignSystemAssets(input);

  if (name === "createComponentInstance") return createComponentInstance(input);

  if (name === "applyDesignStyle") return applyDesignStyle(input);

  if (name === "copyImageFill") return copyImageFill(input);

  if (name === "placeLocalImage") return placeLocalImage(input);

  if (name === "deleteNode") {
    const node = sceneNode(input.nodeId);
    const deleted = serializeNode(node);
    node.remove();
    return { deletedNodeIds: [deleted.id], deleted };
  }

  if (name === "duplicateNode") {
    const node = sceneNode(input.nodeId);
    if (!("clone" in node)) throw new Error("The target node cannot be duplicated.");
    const duplicate = node.clone();
    duplicate.name = input.name ?? `${node.name} copy`;
    duplicate.x += input.offsetX;
    duplicate.y += input.offsetY;
    focus(duplicate);
    return { sourceNodeId: node.id, createdNodeIds: [duplicate.id], node: serializeNode(duplicate) };
  }

  if (name === "createSection") {
    const node = figma.createSection();
    try {
      node.name = input.name;
      node.resize(input.width, input.height);
      node.x = input.x;
      node.y = input.y;
      if (input.fillColor !== undefined) node.fills = [solidPaint(input.fillColor, input.fillOpacity ?? 1)];
      if (input.opacity !== undefined) node.opacity = input.opacity;
      const bounds = layoutBounds(node);
      if (!bounds) throw new Error("The new section has no readable canvas bounds.");
      const placement = siblingCollisionReport(bounds, figma.currentPage, [node.id], false, 250);
      if ((input.collisionPolicy ?? "reject") === "reject" && !placement.clear) {
        throw new Error(`The new section would overlap ${placement.overlapCount} existing top-level node${placement.overlapCount === 1 ? "" : "s"}. Inspect canvas layout or choose collisionPolicy=report only when the overlap is intentional.`);
      }
      focus(node);
      return { createdNodeIds: [node.id], section: serializeNode(node), placement };
    } catch (error) {
      return removeFailedCreation(node, error);
    }
  }

  if (name === "createFrame") {
    const node = figma.createFrame();
    try {
      node.name = input.name;
      node.resize(input.width, input.height);
      appendToParent(node, input.parentId);
      node.x = input.x;
      node.y = input.y;
      await applyVisualStyle(node, input);
      applyAutoLayout(node, { direction: input.layout, itemSpacing: input.itemSpacing, padding: input.padding });
      focus(node);
      return { createdNodeIds: [node.id], node: serializeNode(node) };
    } catch (error) {
      return removeFailedCreation(node, error);
    }
  }

  if (name === "createText") {
    let node;
    try {
      node = await createStyledText(input, pageNode(input.parentId));
      focus(node);
      return { createdNodeIds: [node.id], node: serializeNode(node) };
    } catch (error) {
      if (node && !node.removed) node.remove();
      throw error;
    }
  }

  if (name === "createRectangle" || name === "createEllipse") {
    const node = name === "createRectangle" ? figma.createRectangle() : figma.createEllipse();
    try {
      node.name = input.name;
      node.resize(input.width, input.height);
      appendToParent(node, input.parentId);
      node.x = input.x;
      node.y = input.y;
      await applyVisualStyle(node, input);
      focus(node);
      return { createdNodeIds: [node.id], node: serializeNode(node) };
    } catch (error) {
      return removeFailedCreation(node, error);
    }
  }

  if (name === "importSvg") {
    const node = figma.createNodeFromSvg(input.svg);
    try {
      node.name = input.name;
      appendToParent(node, input.parentId);
      if (input.width !== undefined || input.height !== undefined) {
        node.resize(input.width ?? node.width, input.height ?? node.height);
      }
      node.x = input.x;
      node.y = input.y;
      if (input.opacity !== undefined) node.opacity = input.opacity;
      focus(node);
      return { createdNodeIds: [node.id], node: serializeNode(node) };
    } catch (error) {
      return removeFailedCreation(node, error);
    }
  }

  if (name === "styleNode") {
    const node = sceneNode(input.nodeId);
    await applyVisualStyle(node, input);
    focus(node);
    return { mutatedNodeIds: [node.id], node: serializeNode(node) };
  }

  if (name === "createColorTokens") {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    let collection = collections.find((candidate) => candidate.name === input.collectionName);
    const createdCollection = !collection;
    if (!collection) {
      collection = figma.variables.createVariableCollection(input.collectionName);
      collection.renameMode(collection.defaultModeId, input.modeName);
    }

    const existingVariables = await Promise.all(collection.variableIds.map((id) => figma.variables.getVariableByIdAsync(id)));
    const variablesByName = new Map(existingVariables.filter(Boolean).map((variable) => [variable.name, variable]));
    for (const color of input.colors) {
      const existing = variablesByName.get(color.name);
      if (existing && existing.resolvedType !== "COLOR") {
        throw new Error(`A non-colour variable named "${color.name}" already exists in ${input.collectionName}.`);
      }
    }
    const variableIds = [];
    for (const color of input.colors) {
      let variable = variablesByName.get(color.name);
      if (!variable) variable = figma.variables.createVariable(color.name, collection, "COLOR");
      variable.scopes = ["FRAME_FILL", "SHAPE_FILL", "TEXT_FILL", "STROKE_COLOR"];
      variable.setValueForMode(collection.defaultModeId, hexToColor(color.value));
      variablesByName.set(variable.name, variable);
      variableIds.push({ id: variable.id, name: variable.name, value: color.value });
    }

    return {
      collection: { id: collection.id, name: collection.name, modeName: collection.modes.find((mode) => mode.modeId === collection.defaultModeId)?.name },
      createdCollection,
      colors: variableIds,
    };
  }

  if (name === "listFonts") {
    const query = input.query?.toLowerCase();
    const fontMap = new Map();
    for (const font of await figma.listAvailableFontsAsync()) {
      if (query && !font.fontName.family.toLowerCase().includes(query)) continue;
      const styles = fontMap.get(font.fontName.family) ?? [];
      styles.push(font.fontName.style);
      fontMap.set(font.fontName.family, styles);
    }
    return [...fontMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, input.limit)
      .map(([family, styles]) => ({ family, styles }));
  }

  if (name === "setAutoLayout") {
    const node = autoLayoutNode(input.nodeId);
    if (!node) throw new Error("The target is not a frame, component, component set, or instance on the current page.");
    applyAutoLayout(node, input);
    focus(node);
    return { mutatedNodeIds: [node.id], node: serializeNode(node), layoutMode: node.layoutMode, itemSpacing: node.itemSpacing };
  }

  if (name.startsWith("ds")) return executeDesignSystem(name, input);
  throw new Error(`Unsupported command: ${name}`);
}

let staffWorkingCopyIds = [];
let staffWorkingCopyPageId = null;
let lastStaffContext = "";

function staffNodeSummary(node) { return { id: node.id, name: node.name, type: node.type }; }

function publishStaffContext(force = false) {
  const page = figma.currentPage;
  const selection = page.selection.map(staffNodeSummary);
  const selected = new Set(selection.map((node) => node.id));
  if (page.id !== staffWorkingCopyPageId || selected.size !== staffWorkingCopyIds.length || !staffWorkingCopyIds.every((id) => selected.has(id))) {
    staffWorkingCopyIds = [];
    staffWorkingCopyPageId = null;
  }
  const context = {
    type: "staff-context", pluginVersion, targetId: bridgeClientId,
    documentName: figma.root.name || bridgeMetadata.documentName || bridgeMetadata.label || "Current Figma file",
    pageId: page.id, pageName: page.name, selection, workingCopyIds: [...staffWorkingCopyIds],
  };
  const serialized = JSON.stringify(context);
  if (force === true || serialized !== lastStaffContext) {
    lastStaffContext = serialized;
    figma.ui.postMessage(context);
  }
}

function copyStaffSelection(message) {
  if (bridgeCommandInFlight || bridgePhase !== "connected" || !bridgeSessionId) throw new Error("Wait until the connection is ready and the current task has finished, then try again.");
  const page = figma.currentPage;
  const originals = [...page.selection];
  const expectedIds = new Set(Array.isArray(message.nodeIds) ? message.nodeIds : []);
  if (message.pageId !== page.id || expectedIds.size !== originals.length || !originals.every((node) => expectedIds.has(node.id))) {
    throw new Error("Your page or selection changed. Select the designs again and choose Work on a copy.");
  }
  if (!originals.length) throw new Error("Select one or more whole artboards or sections in Figma first.");
  if (originals.length > 20) throw new Error("Select no more than 20 artboards or sections at a time.");
  if (originals.some((node) => node.parent !== page || typeof node.clone !== "function")) {
    throw new Error("Select whole artboards or sections on the page, rather than layers inside them. This keeps the original layout unchanged.");
  }
  const bounds = originals.map((node) => ({ x: node.x, width: node.width }));
  if (bounds.some((node) => !Number.isFinite(node.x) || !Number.isFinite(node.width))) throw new Error("The selected designs cannot be positioned. Select whole artboards and try again.");
  const offset = Math.max(...bounds.map((node) => node.x + node.width)) - Math.min(...bounds.map((node) => node.x)) + 80;
  const copies = [];
  // No awaits: local copying cannot interleave with an assistant's canvas command.
  bridgeCommandInFlight = true;
  try {
    figma.commitUndo();
    for (const node of originals) {
      const copy = node.clone();
      copies.push(copy);
      copy.name = `${node.name} — Working copy`;
      copy.x = node.x + offset;
      copy.y = node.y;
    }
    page.selection = copies;
    figma.commitUndo();
  } catch (error) {
    let cleanupFailed = false;
    for (const copy of copies.reverse()) {
      try { if (!copy.removed) copy.remove(); } catch { cleanupFailed = true; }
    }
    try { page.selection = originals; } catch { cleanupFailed = true; }
    throw new Error(cleanupFailed
      ? "The copy could not be completed and some copies could not be removed. Inspect the page and use Figma Undo before trying again."
      : `No working copy was kept. ${errorMessage(error)}`);
  } finally { bridgeCommandInFlight = false; }
  staffWorkingCopyIds = copies.map((node) => node.id);
  staffWorkingCopyPageId = page.id;
  try { figma.viewport.scrollAndZoomIntoView(copies); } catch { /* Copying succeeded even if the viewport cannot move. */ }
  publishStaffContext();
  return { type: "staff-copy-result", createdNodes: copies.map(staffNodeSummary), pageId: page.id, pageName: page.name };
}

figma.on?.("selectionchange", publishStaffContext);
figma.on?.("currentpagechange", publishStaffContext);

figma.ui.onmessage = async (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "bridge-http-response") { finishTransportRequest(message); return; }
  if (message.type === "start" || message.type === "retry") {
    void restorePanelView();
    publishStaffContext();
    if (message.transport === "ui-http-v1") bridgeTransport = "ui-http-v1";
    if (!bridgeCommandInFlight) startBridge();
    return;
  }
  if (message.type === "panel-view") { setPanelView(message); return; }
  if (message.type === "staff-refresh-context") { publishStaffContext(true); return; }
  if (message.type === "staff-copy-selection") {
    try { figma.ui.postMessage(copyStaffSelection(message)); }
    catch (error) { figma.ui.postMessage({ type: "staff-error", error: errorMessage(error) }); publishStaffContext(); }
    return;
  }
  if (message.type === "set-metadata") {
    const value = { label: message.label, fileUrl: message.fileUrl };
    metadataSaveQueue = metadataSaveQueue.then(() => saveBridgeMetadata(value)).catch((error) => {
      figma.ui.postMessage({ type: "bridge-metadata-error", error: `Connection details were not saved: ${errorMessage(error)}` });
    });
    await metadataSaveQueue;
  }
  if (message.type === "open-file" && validFigmaFileUrl(message.url)) figma.openExternal(message.url);
  if (message.type === "resize") resizeBridgePanel(message.height);
};

// ===== Design-system extension (branch claude/design-system-commands) =====
// Declarative ds* commands only: every command takes JSON specs; nothing is evaluated as code.
// They create/index components, component sets, text/effect styles, number variables,
// pages and auto-layout node trees, so a design system can be built over the local bridge.
const DS_VERSION = "ds-33";
const dsState = { vars: null, textStyles: null, effectStyles: null, components: new Map(), fonts: new Set(),
  // Library assets by name for files that import the design system (registered with dsLibRegister).
  lib: { components: new Map(), styles: new Map(), variables: new Map(), imported: new Map() } };

async function dsLibImport(cacheKey, load) {
  if (!dsState.lib.imported.has(cacheKey)) dsState.lib.imported.set(cacheKey, await load());
  return dsState.lib.imported.get(cacheKey);
}

async function dsLibVariable(ref) {
  const key = dsState.lib.variables.get(ref);
  return key ? dsLibImport(`var:${key}`, () => figma.variables.importVariableByKeyAsync(key)) : null;
}

async function dsLibStyle(name) {
  const key = dsState.lib.styles.get(name);
  return key ? dsLibImport(`style:${key}`, () => figma.importStyleByKeyAsync(key)) : null;
}

async function dsTextStyle(name) {
  return (await dsTextStyleMap()).get(name) || dsLibStyle(name);
}

async function dsEffectStyle(name) {
  return (await dsEffectStyleMap()).get(name) || dsLibStyle(name);
}

function dsLibRegister(input) {
  for (const item of input.components || []) dsState.lib.components.set(item.name, { key: item.key, type: item.type });
  for (const item of input.styles || []) dsState.lib.styles.set(item.name, item.key);
  for (const item of input.variables || []) dsState.lib.variables.set(item.name, item.key);
  dsState.vars = null;
  return { components: dsState.lib.components.size, styles: dsState.lib.styles.size, variables: dsState.lib.variables.size };
}

async function dsNode(id) {
  const node = await figma.getNodeByIdAsync(id);
  if (!node) throw new Error(`Node ${id} was not found.`);
  return node;
}

async function dsVars() {
  if (!dsState.vars) {
    const map = new Map();
    for (const variable of await figma.variables.getLocalVariablesAsync()) {
      map.set(variable.name, variable);
      map.set(variable.id, variable);
    }
    dsState.vars = map;
  }
  return dsState.vars;
}

async function dsVar(ref) {
  let variable = (await dsVars()).get(ref);
  // createColorTokens or the Variables panel can add variables after the cache was built.
  if (!variable) { dsState.vars = null; variable = (await dsVars()).get(ref); }
  if (!variable) variable = await dsLibVariable(ref);
  if (!variable) throw new Error(`Unknown variable "${ref}".`);
  return variable;
}

async function dsTextStyleMap() {
  if (!dsState.textStyles) {
    const map = new Map();
    for (const style of await figma.getLocalTextStylesAsync()) { map.set(style.name, style); map.set(style.id, style); }
    dsState.textStyles = map;
  }
  return dsState.textStyles;
}

async function dsEffectStyleMap() {
  if (!dsState.effectStyles) {
    const map = new Map();
    for (const style of await figma.getLocalEffectStylesAsync()) { map.set(style.name, style); map.set(style.id, style); }
    dsState.effectStyles = map;
  }
  return dsState.effectStyles;
}

async function dsFont(fontName) {
  const key = `${fontName.family}::${fontName.style}`;
  if (!dsState.fonts.has(key)) {
    await figma.loadFontAsync(fontName);
    dsState.fonts.add(key);
  }
}

async function dsLoadTextNodeFonts(node) {
  if (node.characters.length === 0) { if (node.fontName !== figma.mixed) await dsFont(node.fontName); return; }
  for (const font of node.getRangeAllFontNames(0, node.characters.length)) await dsFont(font);
}

async function dsPaint(spec) {
  if (spec === null || spec === undefined || spec === false) return null;
  const source = typeof spec === "string" ? (spec.startsWith("#") ? { hex: spec } : { var: spec }) : spec;
  const opacity = source.opacity === undefined ? 1 : source.opacity;
  if (source.var) {
    // A bound colour variable supplies its own alpha and Figma ignores the paint's opacity,
    // so a translucent token must be an alpha variable rather than {var, opacity}.
    if (opacity !== 1) throw new Error(`Paint opacity can't be combined with variable "${source.var}". Bind a variable whose value has the alpha you need.`);
    const variable = await dsVar(source.var);
    return figma.variables.setBoundVariableForPaint({ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }, "color", variable);
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(source.hex || "")) throw new Error(`Invalid colour ${JSON.stringify(spec)}.`);
  return { type: "SOLID", color: hexToColor(source.hex), opacity };
}

async function dsPaints(spec) {
  const paint = await dsPaint(spec);
  return paint ? [paint] : [];
}

async function dsNumber(node, field, value) {
  if (value === undefined || value === null) return;
  if (typeof value === "object") {
    if (!value.var) throw new Error(`Invalid numeric value for ${field}.`);
    node.setBoundVariable(field, await dsVar(value.var));
  } else {
    node[field] = value;
  }
}

function dsEffect(effect) {
  // Blur effects take only a radius (Figma rejects colour/offset on them). Used for
  // frosted glass captured from CSS backdrop-filter (Oct 15 2026).
  if (effect.type === "BACKGROUND_BLUR" || effect.type === "LAYER_BLUR") {
    return { type: effect.type, radius: effect.blur || 0, visible: true };
  }
  const color = hexToColor(effect.hex || "#000000");
  const result = {
    type: effect.type || "DROP_SHADOW",
    color: { r: color.r, g: color.g, b: color.b, a: effect.opacity === undefined ? 0.1 : effect.opacity },
    offset: { x: effect.x || 0, y: effect.y || 0 },
    radius: effect.blur || 0,
    spread: effect.spread || 0,
    visible: true,
    blendMode: "NORMAL",
  };
  if (result.type === "DROP_SHADOW") result.showShadowBehindNode = false;
  return result;
}

async function dsApplyEffects(node, spec) {
  if (spec.effect) {
    const style = await dsEffectStyle(spec.effect);
    if (!style) throw new Error(`Unknown effect style "${spec.effect}".`);
    await node.setEffectStyleIdAsync(style.id);
  } else if (spec.effects) {
    node.effects = spec.effects.map(dsEffect);
  }
}

const DS_ALIGN = { start: "MIN", center: "CENTER", end: "MAX", between: "SPACE_BETWEEN" };
const DS_CROSS = { start: "MIN", center: "CENTER", end: "MAX", baseline: "BASELINE" };

function dsPad(pad) {
  if (pad === undefined || pad === null) return [0, 0, 0, 0];
  if (!Array.isArray(pad)) return [pad, pad, pad, pad];
  if (pad.length === 2) return [pad[0], pad[1], pad[0], pad[1]];
  if (pad.length === 4) return pad;
  throw new Error("pad must be a number, [vertical, horizontal] or [top, right, bottom, left].");
}

function dsIsAutoLayout(node) {
  return Boolean(node) && "layoutMode" in node && node.layoutMode !== "NONE";
}

async function dsStyleContainer(frame, spec) {
  if (spec.name) frame.name = spec.name;
  if (spec.layout === "H" || spec.layout === "V") {
    frame.layoutMode = spec.layout === "H" ? "HORIZONTAL" : "VERTICAL";
    await dsNumber(frame, "itemSpacing", spec.gap || 0);
    const [top, right, bottom, left] = dsPad(spec.pad);
    await dsNumber(frame, "paddingTop", top);
    await dsNumber(frame, "paddingRight", right);
    await dsNumber(frame, "paddingBottom", bottom);
    await dsNumber(frame, "paddingLeft", left);
    frame.primaryAxisAlignItems = DS_ALIGN[spec.align || "start"];
    frame.counterAxisAlignItems = DS_CROSS[spec.cross || "start"];
    if (spec.wrap) {
      frame.layoutWrap = "WRAP";
      if (spec.wrapGap !== undefined) frame.counterAxisSpacing = spec.wrapGap;
    }
  } else if ("layoutMode" in frame && frame.type !== "COMPONENT_SET") {
    frame.layoutMode = "NONE";
  }
  frame.fills = await dsPaints(spec.fill);
  if (spec.stroke) {
    frame.strokes = await dsPaints(spec.stroke);
    frame.strokeAlign = spec.strokeAlign || "INSIDE";
    if (spec.strokeSides) {
      const sides = spec.strokeSides;
      frame.strokeTopWeight = sides.top || 0;
      frame.strokeRightWeight = sides.right || 0;
      frame.strokeBottomWeight = sides.bottom || 0;
      frame.strokeLeftWeight = sides.left || 0;
    } else {
      frame.strokeWeight = spec.strokeW === undefined ? 1 : spec.strokeW;
    }
    if (spec.dash) frame.dashPattern = spec.dash;
  } else {
    frame.strokes = [];
  }
  await dsRadius(frame, spec);
  if ("clipsContent" in frame) frame.clipsContent = Boolean(spec.clip);
  if (spec.opacity !== undefined) frame.opacity = spec.opacity;
  await dsApplyEffects(frame, spec);
}

async function dsRadius(node, spec) {
  if (spec.radius !== undefined) {
    if (typeof spec.radius === "object") {
      const variable = await dsVar(spec.radius.var);
      for (const field of ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"]) node.setBoundVariable(field, variable);
    } else {
      node.cornerRadius = spec.radius;
    }
  }
  if (spec.radii) {
    node.topLeftRadius = spec.radii[0];
    node.topRightRadius = spec.radii[1];
    node.bottomRightRadius = spec.radii[2];
    node.bottomLeftRadius = spec.radii[3];
  }
}

function dsSize(node, spec, parent) {
  const parentAutoLayout = dsIsAutoLayout(parent);
  if (spec.abs && parentAutoLayout) node.layoutPositioning = "ABSOLUTE";
  const inFlow = parentAutoLayout && !spec.abs;
  const selfAutoLayout = dsIsAutoLayout(node);
  const keepDefault = node.type === "INSTANCE" ? "keep" : selfAutoLayout ? "hug" : "keep";
  const sizeW = spec.sizeW || (spec.w !== undefined ? "fixed" : keepDefault);
  const sizeH = spec.sizeH || (spec.h !== undefined ? "fixed" : keepDefault);

  if (node.type === "TEXT") {
    if (sizeW === "fill" && inFlow) {
      node.layoutSizingHorizontal = "FILL";
      node.textAutoResize = "HEIGHT";
    } else if (sizeW === "fixed" && spec.w !== undefined) {
      node.resize(spec.w, Math.max(1, node.height));
      node.textAutoResize = "HEIGHT";
    } else {
      node.textAutoResize = "WIDTH_AND_HEIGHT";
    }
    if (spec.grow && inFlow) node.layoutGrow = 1;
  } else {
    if (sizeW === "fixed" || sizeH === "fixed") {
      const width = sizeW === "fixed" && spec.w !== undefined ? spec.w : node.width;
      const height = sizeH === "fixed" && spec.h !== undefined ? spec.h : node.height;
      if ("resize" in node) node.resize(Math.max(0.01, width), Math.max(0.01, height));
    }
    if (selfAutoLayout || inFlow) {
      if (sizeW === "fill" && inFlow) node.layoutSizingHorizontal = "FILL";
      else if (sizeW === "hug" && selfAutoLayout) node.layoutSizingHorizontal = "HUG";
      else if (sizeW === "fixed") node.layoutSizingHorizontal = "FIXED";
      if (sizeH === "fill" && inFlow) node.layoutSizingVertical = "FILL";
      else if (sizeH === "hug" && selfAutoLayout) node.layoutSizingVertical = "HUG";
      else if (sizeH === "fixed") node.layoutSizingVertical = "FIXED";
      if (spec.minW !== undefined) node.minWidth = spec.minW;
      if (spec.maxW !== undefined) node.maxWidth = spec.maxW;
      if (spec.minH !== undefined) node.minHeight = spec.minH;
      if (spec.maxH !== undefined) node.maxHeight = spec.maxH;
    }
  }
  if (!inFlow) {
    if (spec.x !== undefined) node.x = spec.x;
    if (spec.y !== undefined) node.y = spec.y;
  }
  if (spec.constraints && "constraints" in node) node.constraints = spec.constraints;
}

function dsRecord(node, spec, ctx) {
  ctx.count += 1;
  if (!ctx.root) ctx.root = node;
  if (spec.key) ctx.keys[spec.key] = node.id;
}

// Figma adds new nodes to the current page immediately, before we parent them, so every
// created node is tracked from birth; dsRender removes them all if the render fails.
function dsTrack(node, ctx) {
  ctx.created.push(node);
  return node;
}

async function dsResolveComponent(ref, variant) {
  let node = null;
  if (typeof ref === "string" && /^\d+:\d+$/.test(ref)) node = await figma.getNodeByIdAsync(ref);
  else {
    const id = dsState.components.get(ref);
    if (id) node = await figma.getNodeByIdAsync(id);
  }
  if (!node && dsState.lib.components.has(ref)) {
    const lib = dsState.lib.components.get(ref);
    node = await dsLibImport(`component:${lib.key}`, () => lib.type === "COMPONENT_SET" ? figma.importComponentSetByKeyAsync(lib.key) : figma.importComponentByKeyAsync(lib.key));
  }
  if (!node) {
    if (dsState.components.get(ref)) dsState.components.delete(ref);
    throw new Error(`Component "${ref}" was not found. It may have been deleted; run dsIndex or create it first.`);
  }
  if (node.type === "COMPONENT_SET") {
    if (!variant) return node.defaultVariant;
    const match = node.children.find((child) => Object.entries(variant).every(([key, value]) => child.variantProperties && child.variantProperties[key] === value));
    if (!match) throw new Error(`No variant ${JSON.stringify(variant)} in "${ref}".`);
    return match;
  }
  if (node.type !== "COMPONENT") throw new Error(`"${ref}" is not a component.`);
  return node;
}

function dsFindNamed(root, name) {
  const found = [];
  const visit = (node) => {
    if (node !== root && node.name === name) found.push(node);
    if (node.type === "INSTANCE" && node !== root) return;
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(root);
  return found;
}

async function dsBindProperties(owner, props, variants) {
  const keys = {};
  for (const prop of props) {
    let defaultValue = prop.default;
    if (prop.type === "INSTANCE_SWAP") defaultValue = (await dsResolveComponent(prop.default)).id;
    const options = prop.preferred ? { preferredValues: await Promise.all(prop.preferred.map(async (ref) => ({ type: "COMPONENT", key: (await dsResolveComponent(ref)).key }))) } : undefined;
    const key = owner.addComponentProperty(prop.name, prop.type, defaultValue, options);
    keys[prop.name] = key;
    const field = prop.type === "TEXT" ? "characters" : prop.type === "BOOLEAN" ? "visible" : "mainComponent";
    let bound = 0;
    for (const variant of variants) {
      for (const target of dsFindNamed(variant, prop.bind || prop.name)) {
        target.componentPropertyReferences = Object.assign({}, target.componentPropertyReferences || {}, { [field]: key });
        bound += 1;
      }
    }
    if (bound === 0) throw new Error(`Property "${prop.name}" did not match a layer named "${prop.bind || prop.name}".`);
  }
  return keys;
}

async function dsSetInstanceProperties(instance, props, label) {
  const definitions = instance.componentProperties;
  const values = {};
  for (const [name, value] of Object.entries(props)) {
    const fullName = Object.keys(definitions).find((key) => key === name || key.split("#")[0] === name);
    if (!fullName) throw new Error(`"${label}" has no property "${name}".`);
    values[fullName] = definitions[fullName].type === "INSTANCE_SWAP" ? (await dsResolveComponent(value)).id : value;
  }
  // Swapping replaces the nested instance, dropping its colour override and layer name.
  // Skip no-op swaps and carry the Glyph colour and name across real ones.
  const holderFor = (key) => instance.findOne((node) => node.type === "INSTANCE" && node.componentPropertyReferences && node.componentPropertyReferences.mainComponent === key);
  const saved = new Map();
  for (const key of Object.keys(values)) {
    if (definitions[key].type !== "INSTANCE_SWAP") continue;
    if (definitions[key].value === values[key]) { delete values[key]; continue; }
    const holder = holderFor(key);
    const glyph = holder && holder.findOne((node) => node.name === "Glyph");
    if (holder) saved.set(key, { name: holder.name, strokes: glyph ? glyph.strokes : null });
  }
  instance.setProperties(values);
  for (const [key, before] of saved) {
    const holder = holderFor(key);
    if (!holder) continue;
    holder.name = before.name;
    const glyph = holder.findOne((node) => node.name === "Glyph");
    if (glyph && before.strokes) glyph.strokes = before.strokes;
  }
}

async function dsBuildText(spec, parent, ctx) {
  const text = dsTrack(figma.createText(), ctx);
  parent.appendChild(text);
  dsRecord(text, spec, ctx);
  let style = null;
  if (spec.style) {
    style = await dsTextStyle(spec.style);
    if (!style) throw new Error(`Unknown text style "${spec.style}".`);
    await dsFont(style.fontName);
    text.fontName = style.fontName;
  } else {
    const font = { family: (spec.font && spec.font.family) || "Manrope", style: (spec.font && spec.font.style) || "Regular" };
    await dsFont(font);
    text.fontName = font;
  }
  text.characters = spec.chars === undefined ? "" : String(spec.chars);
  if (style) {
    await text.setTextStyleIdAsync(style.id);
  } else if (spec.font) {
    if (spec.font.size) text.fontSize = spec.font.size;
    if (spec.font.lh) text.lineHeight = { unit: "PIXELS", value: spec.font.lh };
    if (spec.font.ls !== undefined) text.letterSpacing = { unit: "PIXELS", value: spec.font.ls };
    if (spec.font.textCase) text.textCase = spec.font.textCase;
  }
  if (spec.fill !== undefined) text.fills = await dsPaints(spec.fill);
  for (const span of spec.spans || []) {
    if (span.style) {
      const spanStyle = await dsTextStyle(span.style);
      if (!spanStyle) throw new Error(`Unknown text style "${span.style}".`);
      await dsFont(spanStyle.fontName);
      await text.setRangeTextStyleIdAsync(span.start, span.end, spanStyle.id);
    }
    if (span.font) {
      const current = text.getRangeFontName(span.start, span.start + 1);
      const font = { family: span.font.family || current.family, style: span.font.style || current.style };
      await dsFont(font);
      text.setRangeFontName(span.start, span.end, font);
      if (span.font.size) text.setRangeFontSize(span.start, span.end, span.font.size);
    }
    if (span.fill) text.setRangeFills(span.start, span.end, await dsPaints(span.fill));
    if (span.underline) text.setRangeTextDecoration(span.start, span.end, "UNDERLINE");
  }
  text.name = spec.name || text.characters.slice(0, 60) || "Text";
  if (spec.align) text.textAlignHorizontal = { left: "LEFT", center: "CENTER", right: "RIGHT" }[spec.align];
  if (spec.textCase) text.textCase = spec.textCase;
  if (spec.opacity !== undefined) text.opacity = spec.opacity;
  dsSize(text, spec, parent);
  return text;
}

async function dsBuildInstance(spec, parent, ctx) {
  const component = await dsResolveComponent(spec.of, spec.variant);
  const instance = dsTrack(component.createInstance(), ctx);
  parent.appendChild(instance);
  dsRecord(instance, spec, ctx);
  if (spec.name) instance.name = spec.name;
  if (spec.props) await dsSetInstanceProperties(instance, spec.props, spec.of);
  for (const override of spec.set || []) {
    const targets = instance.findAll((node) => node.name === override.name);
    if (targets.length === 0 && !override.optional) throw new Error(`"${spec.of}" has no layer named "${override.name}".`);
    for (const target of targets) {
      if (override.chars !== undefined && target.type === "TEXT") {
        await dsLoadTextNodeFonts(target);
        target.characters = String(override.chars);
      }
      if (override.style !== undefined && target.type === "TEXT") {
        const style = await dsTextStyle(override.style);
        if (!style) throw new Error(`Unknown text style "${override.style}".`);
        await dsFont(style.fontName);
        await target.setTextStyleIdAsync(style.id);
      }
      if (override.fill !== undefined) target.fills = await dsPaints(override.fill);
      if (override.stroke !== undefined) target.strokes = await dsPaints(override.stroke);
      if (override.visible !== undefined) target.visible = override.visible;
      if (override.props && target.type === "INSTANCE") await dsSetInstanceProperties(target, override.props, override.name);
    }
  }
  if (spec.iconColor !== undefined) {
    const paints = await dsPaints(spec.iconColor);
    for (const glyph of instance.findAll((node) => node.name === "Glyph")) glyph.strokes = paints;
  }
  if (spec.scale && spec.scale !== 1) instance.rescale(spec.scale);
  if (spec.pad !== undefined && dsIsAutoLayout(instance)) {
    const [top, right, bottom, left] = dsPad(spec.pad);
    await dsNumber(instance, "paddingTop", top);
    await dsNumber(instance, "paddingRight", right);
    await dsNumber(instance, "paddingBottom", bottom);
    await dsNumber(instance, "paddingLeft", left);
  }
  if (spec.exposed) instance.isExposedInstance = true;
  if (spec.effect || spec.effects) await dsApplyEffects(instance, spec);
  if (spec.opacity !== undefined) instance.opacity = spec.opacity;
  dsSize(instance, spec, parent);
  return instance;
}

async function dsBuildIcon(spec, parent, ctx) {
  const component = dsTrack(figma.createComponent(), ctx);
  component.name = spec.name;
  component.resize(24, 24);
  component.fills = [];
  component.clipsContent = false;
  parent.appendChild(component);
  dsRecord(component, spec, ctx);
  const source = dsTrack(figma.createNodeFromSvg(spec.svg), ctx);
  component.appendChild(source);
  source.x = 0;
  source.y = 0;
  const pieces = source.children.slice();
  if (pieces.length === 0) throw new Error(`Icon ${spec.name} has no drawable paths.`);
  const glyph = pieces.length === 1 ? pieces[0] : figma.flatten(pieces, source);
  const gx = glyph.x;
  const gy = glyph.y;
  component.appendChild(glyph);
  glyph.x = gx;
  glyph.y = gy;
  source.remove();
  glyph.name = "Glyph";
  glyph.fills = [];
  glyph.strokes = await dsPaints(spec.color || "text/secondary");
  glyph.strokeWeight = 2;
  glyph.strokeCap = "ROUND";
  glyph.strokeJoin = "ROUND";
  glyph.constraints = { horizontal: "SCALE", vertical: "SCALE" };
  if (spec.description) component.description = spec.description;
  dsState.components.set(spec.name, component.id);
  dsSize(component, { x: spec.x, y: spec.y }, parent);
  return component;
}

async function dsBuildComponentSet(spec, parent, ctx) {
  const components = [];
  for (const variant of spec.variants) components.push(await dsBuild(Object.assign({}, variant, { type: "component" }), parent, ctx));
  const set = dsTrack(figma.combineAsVariants(components, parent), ctx);
  set.name = spec.name;
  await dsStyleContainer(set, {
    layout: spec.layout || "H",
    gap: spec.gap === undefined ? 20 : spec.gap,
    pad: spec.pad === undefined ? 24 : spec.pad,
    align: "start",
    cross: spec.cross || "start",
    wrap: spec.wrap,
    wrapGap: spec.wrapGap === undefined ? (spec.gap === undefined ? 20 : spec.gap) : spec.wrapGap,
    fill: spec.fill === undefined ? { hex: "#FFFFFF", opacity: 0 } : spec.fill,
    stroke: spec.setStroke === undefined ? "#9747FF" : spec.setStroke,
    dash: [10, 5],
    radius: 5,
  });
  dsSize(set, { sizeW: spec.sizeW || "hug", sizeH: "hug", w: spec.w }, parent);
  if (spec.props) await dsBindProperties(set, spec.props, set.children);
  if (spec.description) set.description = spec.description;
  if (spec.key) ctx.keys[spec.key] = set.id;
  dsState.components.set(spec.name, set.id);
  return set;
}

async function dsBuild(spec, parent, ctx) {
  if (spec.type === "text") return dsBuildText(spec, parent, ctx);
  if (spec.type === "instance") return dsBuildInstance(spec, parent, ctx);
  if (spec.type === "icon") return dsBuildIcon(spec, parent, ctx);
  if (spec.type === "componentSet") return dsBuildComponentSet(spec, parent, ctx);

  let node;
  if (spec.type === "frame") node = figma.createFrame();
  else if (spec.type === "component") node = figma.createComponent();
  else if (spec.type === "rect") node = figma.createRectangle();
  else if (spec.type === "ellipse") node = figma.createEllipse();
  else if (spec.type === "svg") node = figma.createNodeFromSvg(spec.svg);
  else if (spec.type === "image") node = figma.createRectangle();
  else throw new Error(`Unknown node type "${spec.type}".`);
  dsTrack(node, ctx);

  if (spec.type === "frame" || spec.type === "component") {
    node.resize(spec.w || 100, spec.h || 100);
    await dsStyleContainer(node, spec);
  } else if (spec.type === "rect" || spec.type === "ellipse") {
    node.resize(Math.max(0.01, spec.w || 1), Math.max(0.01, spec.h || 1));
    node.name = spec.name || (spec.type === "rect" ? "Rectangle" : "Ellipse");
    node.fills = await dsPaints(spec.fill);
    if (spec.stroke) {
      node.strokes = await dsPaints(spec.stroke);
      node.strokeWeight = spec.strokeW === undefined ? 1 : spec.strokeW;
      node.strokeAlign = spec.strokeAlign || "INSIDE";
    }
    if (spec.type === "rect") await dsRadius(node, spec);
    if (spec.opacity !== undefined) node.opacity = spec.opacity;
    await dsApplyEffects(node, spec);
  } else if (spec.type === "svg") {
    node.name = spec.name || "Vector";
    node.fills = [];
  } else if (spec.type === "image") {
    node.resize(spec.w, spec.h);
    node.name = spec.name || "Image";
    const image = figma.createImage(figma.base64Decode(spec.base64));
    node.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: spec.scaleMode || "FIT" }];
    await dsRadius(node, spec);
  }

  parent.appendChild(node);
  dsRecord(node, spec, ctx);
  if (spec.type === "svg") dsSize(node, Object.assign({}, spec, { sizeW: spec.sizeW || "keep", sizeH: spec.sizeH || "keep", w: undefined, h: undefined }), parent);
  else dsSize(node, spec, parent);

  const built = [];
  for (const child of spec.children || []) built.push(await dsBuild(child, node, ctx));
  (spec.children || []).forEach((child, index) => {
    const childNode = built[index];
    if (child.fit === "parent") {
      childNode.resize(node.width, node.height);
      childNode.x = 0;
      childNode.y = 0;
      childNode.constraints = { horizontal: "STRETCH", vertical: "STRETCH" };
    }
    if (child.stretchH) {
      const top = child.stretchH.top || 0;
      const bottom = child.stretchH.bottom || 0;
      childNode.resize(childNode.width, Math.max(0.01, node.height - top - bottom));
      childNode.y = top;
      childNode.constraints = { horizontal: "MIN", vertical: "STRETCH" };
    }
    if (child.anchor) {
      if (child.anchor.right !== undefined) childNode.x = node.width - child.anchor.right - childNode.width;
      if (child.anchor.bottom !== undefined) childNode.y = node.height - child.anchor.bottom - childNode.height;
      if (child.anchor.centerX) childNode.x = Math.round((node.width - childNode.width) / 2);
      childNode.constraints = { horizontal: child.anchor.right !== undefined ? "MAX" : child.anchor.centerX ? "CENTER" : "MIN", vertical: child.anchor.bottom !== undefined ? "MAX" : "MIN" };
    }
  });

  if (spec.type === "component") {
    if (spec.description) node.description = spec.description;
    if (spec.props) await dsBindProperties(node, spec.props, [node]);
    if (spec.register !== false && spec.name && !/=/.test(spec.name)) dsState.components.set(spec.name, node.id);
  }
  return node;
}

async function dsRender(input) {
  const parent = input.parentId ? await dsNode(input.parentId) : figma.currentPage;
  if (parent.type === "PAGE") await parent.loadAsync();
  const ctx = { keys: {}, count: 0, root: null, created: [] };
  try {
    const node = await dsBuild(input.tree, parent, ctx);
    if (input.index !== undefined && "insertChild" in parent) parent.insertChild(input.index, node);
    return { rootId: node.id, name: node.name, type: node.type, width: node.width, height: node.height, count: ctx.count, keys: ctx.keys };
  } catch (error) {
    for (const node of ctx.created.slice().reverse()) {
      if (!node.removed) node.remove();
    }
    throw error;
  }
}

async function dsIndex(input) {
  const pages = input.pageId ? [await dsNode(input.pageId)] : figma.root.children;
  if (!input.pageId) dsState.components.clear();
  const names = [];
  const duplicates = new Set();
  const seen = new Set();
  for (const page of pages) {
    await page.loadAsync();
    for (const node of page.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] })) {
      if (node.type === "COMPONENT" && node.parent && node.parent.type === "COMPONENT_SET") continue;
      if (seen.has(node.name)) { duplicates.add(node.name); continue; }
      seen.add(node.name);
      dsState.components.set(node.name, node.id);
      names.push(node.name);
    }
  }
  dsState.vars = null;
  dsState.textStyles = null;
  dsState.effectStyles = null;
  return { count: names.length, names, ids: Object.fromEntries(dsState.components), duplicates: [...duplicates] };
}

async function dsTextStyles(input) {
  const styles = await dsTextStyleMap();
  const result = [];
  for (const spec of input.styles) {
    const font = { family: spec.family, style: spec.style };
    await dsFont(font);
    let style = styles.get(spec.name);
    if (!style) style = figma.createTextStyle();
    style.name = spec.name;
    style.fontName = font;
    style.fontSize = spec.size;
    style.lineHeight = { unit: "PIXELS", value: spec.lh };
    style.letterSpacing = { unit: "PIXELS", value: spec.ls || 0 };
    style.textCase = spec.textCase || "ORIGINAL";
    if (spec.description) style.description = spec.description;
    result.push({ id: style.id, name: style.name });
  }
  dsState.textStyles = null;
  return { styles: result };
}

async function dsEffectStyles(input) {
  const styles = await dsEffectStyleMap();
  const result = [];
  for (const spec of input.styles) {
    let style = styles.get(spec.name);
    if (!style) style = figma.createEffectStyle();
    style.name = spec.name;
    style.effects = spec.effects.map(dsEffect);
    if (spec.description) style.description = spec.description;
    result.push({ id: style.id, name: style.name });
  }
  dsState.effectStyles = null;
  return { styles: result };
}

async function dsNumberVars(input) {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  let collection = collections.find((candidate) => candidate.name === input.collection);
  if (!collection) collection = figma.variables.createVariableCollection(input.collection);
  const existing = await Promise.all(collection.variableIds.map((id) => figma.variables.getVariableByIdAsync(id)));
  const byName = new Map(existing.filter(Boolean).map((variable) => [variable.name, variable]));
  const result = [];
  for (const spec of input.vars) {
    let variable = byName.get(spec.name);
    if (!variable) variable = figma.variables.createVariable(spec.name, collection, "FLOAT");
    variable.setValueForMode(collection.defaultModeId, spec.value);
    if (spec.scopes) variable.scopes = spec.scopes;
    result.push({ id: variable.id, name: variable.name, value: spec.value });
  }
  dsState.vars = null;
  return { collection: { id: collection.id, name: collection.name }, vars: result };
}

async function dsPages(input) {
  for (const spec of input.ensure || []) {
    let page = spec.id ? await figma.getNodeByIdAsync(spec.id) : figma.root.children.find((candidate) => candidate.name === spec.name);
    if (!page) page = figma.createPage();
    page.name = spec.name;
    if (spec.background) page.backgrounds = [solidPaint(spec.background)];
  }
  (input.order || []).forEach((name, index) => {
    const page = figma.root.children.find((candidate) => candidate.name === name);
    if (page) figma.root.insertChild(index, page);
  });
  return { pages: figma.root.children.map((page) => ({ id: page.id, name: page.name })) };
}

async function dsMove(input) {
  const parent = await dsNode(input.parentId);
  if (parent.type === "PAGE") await parent.loadAsync();
  const moved = [];
  for (const id of input.ids) {
    const node = await dsNode(id);
    if (input.index !== undefined) parent.insertChild(input.index, node);
    else parent.appendChild(node);
    if (input.x !== undefined) node.x = input.x;
    if (input.y !== undefined) node.y = input.y;
    moved.push({ id: node.id, name: node.name });
  }
  return { moved };
}

async function dsDelete(input) {
  const removed = [];
  for (const id of input.ids) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node) continue;
    removed.push({ id, name: node.name, type: node.type });
    node.remove();
  }
  return { removed };
}

async function dsInspect(input) {
  const node = await dsNode(input.nodeId);
  const walk = (current, depth) => {
    const item = { id: current.id, name: current.name, type: current.type };
    if ("width" in current) { item.w = Math.round(current.width); item.h = Math.round(current.height); }
    if ("x" in current) { item.x = Math.round(current.x); item.y = Math.round(current.y); }
    if (current.type === "INSTANCE" && current.componentProperties) item.props = Object.fromEntries(Object.entries(current.componentProperties).map(([key, value]) => [key, value.value]));
    if (current.visible === false) item.hidden = true;
    if (current.type === "TEXT") item.text = current.characters.slice(0, input.textLength || 80);
    if (depth < (input.depth || 2) && "children" in current) item.children = current.children.map((child) => walk(child, depth + 1));
    return item;
  };
  return walk(node, 0);
}

async function dsColorVars(input) {
  const result = [];
  for (const spec of input.vars) {
    const variable = await dsVar(spec.name);
    const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
    const color = hexToColor(spec.hex);
    variable.setValueForMode(collection.defaultModeId, { r: color.r, g: color.g, b: color.b, a: spec.alpha === undefined ? 1 : spec.alpha });
    if (spec.description) variable.description = spec.description;
    result.push({ id: variable.id, name: variable.name });
  }
  dsState.vars = null;
  return { vars: result };
}

async function dsVarName(paint) {
  const alias = paint && paint.boundVariables && paint.boundVariables.color;
  if (!alias) return null;
  const variable = await figma.variables.getVariableByIdAsync(alias.id);
  return variable ? variable.name : alias.id;
}

async function dsReadGlyphs(input) {
  const root = await dsNode(input.nodeId);
  const out = [];
  const holders = root.type === "COMPONENT_SET" ? root.children : [root];
  for (const holder of holders) {
    for (const layer of dsFindNamed(holder, input.layer)) {
      const glyph = layer.type === "INSTANCE" ? layer.findOne((n) => n.name === "Glyph") : null;
      const paint = glyph && glyph.strokes && glyph.strokes[0];
      out.push({ variant: holder.name, layer: layer.id, glyph: glyph ? glyph.id : null, color: paint ? (await dsVarName(paint)) || JSON.stringify(paint.color) : null });
    }
  }
  return { glyphs: out };
}

async function dsRecolorGlyphs(input) {
  const root = await dsNode(input.nodeId);
  const holders = root.type === "COMPONENT_SET" ? root.children : [root];
  let changed = 0;
  for (const holder of holders) {
    for (const rule of input.rules) {
      if (rule.variant && !Object.entries(rule.variant).every(([key, value]) => holder.variantProperties && holder.variantProperties[key] === value)) continue;
      for (const layer of dsFindNamed(holder, rule.layer)) {
        const glyphs = layer.type === "INSTANCE" ? layer.findAll((n) => n.name === "Glyph") : [];
        const paints = await dsPaints(rule.color);
        for (const glyph of glyphs) { glyph.strokes = paints; changed += 1; }
      }
    }
  }
  return { changed };
}

async function dsDeleteStyles(input) {
  const removed = [];
  const text = await dsTextStyleMap();
  for (const name of input.text || []) {
    const style = text.get(name);
    if (style && style.name === name) { style.remove(); removed.push(name); }
  }
  const effects = await dsEffectStyleMap();
  for (const name of input.effect || []) {
    const style = effects.get(name);
    if (style && style.name === name) { style.remove(); removed.push(name); }
  }
  dsState.textStyles = null;
  dsState.effectStyles = null;
  return { removed };
}

// Retypes text ranges set in one font family to another, keeping each range's style (weight).
// Text bound to a text style follows the style; this reaches ranges with their own font, such as
// bold spans. With dryRun it only counts, which also verifies that a family is gone.
async function dsReplaceFont(input) {
  const { from, to } = input;
  if (!from || !to) throw new Error("dsReplaceFont needs from and to font families.");
  const roots = input.rootIds && input.rootIds.length ? await Promise.all(input.rootIds.map(dsNode)) : figma.root.children;
  const available = new Set((await figma.listAvailableFontsAsync()).filter((font) => font.fontName.family === to).map((font) => font.fontName.style));
  const result = { from, to, dryRun: !!input.dryRun, textNodes: 0, ranges: 0, styles: {}, missing: [], errors: [], samples: [] };
  const missing = new Set();
  for (const root of roots) {
    if (root.type === "PAGE") await root.loadAsync();
    const texts = root.type === "TEXT" ? [root] : root.findAllWithCriteria({ types: ["TEXT"] });
    for (const text of texts) {
      const segments = text.getStyledTextSegments(["fontName"]).filter((segment) => segment.fontName.family === from);
      if (!segments.length) continue;
      result.textNodes += 1;
      if (result.samples.length < 12) result.samples.push({ id: text.id, name: text.name });
      for (const segment of segments) {
        const style = segment.fontName.style;
        result.styles[style] = (result.styles[style] || 0) + 1;
        result.ranges += 1;
        if (!available.has(style)) { missing.add(style); continue; }
        if (input.dryRun) continue;
        try {
          await dsFont({ family: to, style });
          text.setRangeFontName(segment.start, segment.end, { family: to, style });
        } catch (error) {
          if (result.errors.length < 12) result.errors.push({ id: text.id, name: text.name, error: errorMessage(error) });
        }
      }
    }
  }
  result.missing = [...missing];
  return result;
}

// Read-only: reports instances whose main component is missing, deleted, or (with libraryPageId)
// outside the library page. Nested instances follow their parent's main component, so by default
// only outermost instances are checked.
async function dsAuditInstances(input) {
  const roots = input.rootIds && input.rootIds.length ? await Promise.all(input.rootIds.map(dsNode)) : figma.root.children;
  const pageOf = (node) => { let current = node; while (current && current.type !== "PAGE") current = current.parent; return current; };
  const insideInstance = (node) => { for (let current = node.parent; current; current = current.parent) if (current.type === "INSTANCE") return true; return false; };
  const result = { instances: 0, missing: 0, removed: 0, offLibrary: 0, samples: [] };
  for (const root of roots) {
    if (root.type === "PAGE") await root.loadAsync();
    const instances = root.type === "INSTANCE" ? [root] : root.findAllWithCriteria({ types: ["INSTANCE"] });
    for (const instance of instances) {
      if (!input.nested && insideInstance(instance)) continue;
      result.instances += 1;
      const main = await instance.getMainComponentAsync();
      const page = main && !main.removed ? pageOf(main) : null;
      const problem = !main ? "missing" : !page ? "removed" : input.libraryPageId && page.id !== input.libraryPageId ? "offLibrary" : null;
      if (!problem) continue;
      result[problem] += 1;
      if (result.samples.length < 20) result.samples.push({ id: instance.id, name: instance.name, problem, main: main ? main.name : null });
    }
  }
  return result;
}

// Which components a subtree uses: instances grouped by component set (or component) name, with
// sample IDs. Instances inside other instances are skipped unless nested is set. Read-only.
async function dsUsage(input) {
  const roots = await Promise.all((input.rootIds || []).map(dsNode));
  const usage = {};
  for (const root of roots) {
    if (root.type === "PAGE") await root.loadAsync();
    const instances = root.type === "INSTANCE" ? [root] : root.findAllWithCriteria({ types: ["INSTANCE"] });
    for (const instance of instances) {
      if (!input.nested) {
        let nested = false;
        for (let current = instance.parent; current && current !== root; current = current.parent) if (current.type === "INSTANCE") { nested = true; break; }
        if (nested) continue;
      }
      const main = await instance.getMainComponentAsync();
      const name = !main ? "(missing)" : main.parent && main.parent.type === "COMPONENT_SET" ? main.parent.name : main.name;
      const entry = usage[name] || (usage[name] = { count: 0, ids: [] });
      entry.count += 1;
      if (entry.ids.length < (input.sample || 5)) entry.ids.push(instance.id);
    }
  }
  return usage;
}

// Lists the library assets a subtree uses — components (by set), text/paint/effect/grid styles and
// bound variables — each with its key, remote flag, use count and one sample layer ID, so callers
// can check every asset comes from the expected library. Read-only.
// Read-only: text whose fill is one of `text` (variable names) sitting on one of `surfaces`, as
// decided by the nearest ancestor with a visible solid fill. Bounded by a time budget so a large
// page can't freeze Figma; `truncated` says when it stopped early.
async function dsContrastScan(input) {
  const root = await dsNode(input.rootId);
  if (root.type === "PAGE") await root.loadAsync();
  const texts = new Set(input.text || []);
  const surfaces = new Set(input.surfaces || []);
  const limit = input.limit || 400;
  const budget = input.budgetMs || 15000;
  const started = Date.now();
  const found = [];
  let visited = 0;
  let stopped = false;
  const paintName = async (paint) => (paint ? (await dsVarName(paint)) || "#raw" : null);
  const visit = async (node, surface, hidden, path) => {
    if (found.length >= limit || Date.now() - started > budget) { stopped = true; return; }
    visited += 1;
    const isHidden = hidden || node.visible === false;
    if (isHidden && !input.includeHidden) return;
    let here = surface;
    if (node.type !== "TEXT" && "fills" in node && Array.isArray(node.fills)) {
      const solid = node.fills.filter((paint) => paint.visible !== false && paint.type === "SOLID" && (paint.opacity === undefined || paint.opacity > 0.5));
      if (solid.length) here = await paintName(solid[solid.length - 1]);
    }
    if (node.type === "TEXT" && surfaces.has(here)) {
      const names = new Set();
      if (Array.isArray(node.fills)) {
        for (const paint of node.fills) if (paint.visible !== false && paint.type === "SOLID") names.add(await paintName(paint));
      } else {
        for (const segment of node.getStyledTextSegments(["fills"]))
          for (const paint of segment.fills) if (paint.visible !== false && paint.type === "SOLID") names.add(await paintName(paint));
      }
      const hit = [...names].filter((name) => texts.has(name));
      if (hit.length)
        found.push({ id: node.id, name: node.name, text: node.characters.slice(0, 60), fill: hit.join(","), mixed: !Array.isArray(node.fills), surface: here, path: path.slice(-3).join(" / ") });
    }
    if ("children" in node) {
      const next = node === root ? path : path.concat([node.name]);
      for (const child of node.children) await visit(child, here, isHidden, next);
    }
  };
  await visit(root, input.surface || null, false, []);
  return { found, visited, truncated: stopped, ms: Date.now() - started };
}

// Read-only: solid paints bound to a colour variable whose stored colour no longer matches the
// variable's value for that layer. Figma can keep rendering such a stale paint (seen after
// re-binding a bound fill), so these need binding again. Fills, strokes and text ranges; bounded
// by a time budget.
async function dsStaleFills(input) {
  const root = await dsNode(input.rootId);
  if (root.type === "PAGE") await root.loadAsync();
  const limit = input.limit || 400;
  const budget = input.budgetMs || 15000;
  const started = Date.now();
  const found = [];
  const variables = new Map();
  let visited = 0;
  let stopped = false;
  const variableOf = async (id) => {
    if (!variables.has(id)) variables.set(id, await figma.variables.getVariableByIdAsync(id));
    return variables.get(id);
  };
  const near = (a, b) => Math.abs(a - b) < 0.004;
  const check = async (node, paints, field, range) => {
    if (!Array.isArray(paints)) return;
    for (const paint of paints) {
      const alias = paint && paint.type === "SOLID" && paint.boundVariables && paint.boundVariables.color;
      if (!alias) continue;
      const variable = await variableOf(alias.id);
      if (!variable) continue;
      let value;
      try { value = variable.resolveForConsumer(node).value; } catch (error) { continue; }
      if (!value || typeof value !== "object" || !("r" in value)) continue;
      if (!near(value.r, paint.color.r) || !near(value.g, paint.color.g) || !near(value.b, paint.color.b))
        found.push({ id: node.id, name: node.name, type: node.type, field, range, variable: variable.name,
          stored: "#" + [paint.color.r, paint.color.g, paint.color.b].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join(""),
          text: node.type === "TEXT" ? node.characters.slice(0, 40) : undefined });
    }
  };
  const visit = async (node, hidden) => {
    if (found.length >= limit || Date.now() - started > budget) { stopped = true; return; }
    visited += 1;
    const isHidden = hidden || node.visible === false;
    if (isHidden && !input.includeHidden) return;
    if (node.type === "TEXT" && node.fills === figma.mixed) {
      for (const segment of node.getStyledTextSegments(["fills"])) await check(node, segment.fills, "fills", [segment.start, segment.end]);
    } else if ("fills" in node) await check(node, node.fills, "fills");
    if ("strokes" in node) await check(node, node.strokes, "strokes");
    if ("children" in node) for (const child of node.children) await visit(child, isHidden);
  };
  await visit(root, false);
  return { found, visited, truncated: stopped, ms: Date.now() - started };
}

// Read-only: a colour variable's value in every mode of its collection, and for a layer, the
// mode it resolves in (explicit modes up its ancestors) and the value it resolves to.
// Light and dark glass modes (Oct 29 2026): one variable collection with a mode per theme,
// layers bound to it by the role they play, so a frame or section flips with its mode.

// Find or create a collection with the given modes and variables (values per mode).
async function dsModeCollection(input) {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  let collection = collections.find((item) => item.name === input.name);
  if (!collection) collection = figma.variables.createVariableCollection(input.name);
  const mode = (name) => collection.modes.find((item) => item.name === name);
  input.modes.forEach((name, index) => {
    if (mode(name)) return;
    const first = collection.modes[0];
    if (index === 0 && collection.modes.length === 1 && !input.modes.includes(first.name)) collection.renameMode(first.modeId, name);
    else collection.addMode(name);
  });
  const modeIds = Object.fromEntries(input.modes.map((name) => [name, mode(name).modeId]));
  const local = await figma.variables.getLocalVariablesAsync();
  const ids = {};
  for (const spec of input.vars || []) {
    const type = spec.type || "COLOR";
    let variable = local.find((item) => item.variableCollectionId === collection.id && item.name === spec.name);
    if (!variable) variable = figma.variables.createVariable(spec.name, collection, type);
    if (spec.description !== undefined) variable.description = spec.description;
    if (spec.scopes) variable.scopes = spec.scopes;
    if (spec.web) variable.setVariableCodeSyntax("WEB", spec.web);
    for (const [name, value] of Object.entries(spec.values)) {
      if (!modeIds[name]) throw new Error(`Unknown mode "${name}".`);
      variable.setValueForMode(modeIds[name], type === "COLOR" ? Object.assign(hexToColor(value.hex), { a: value.a === undefined ? 1 : value.a }) : value);
    }
    ids[spec.name] = variable.id;
  }
  dsState.vars = null;
  return { collectionId: collection.id, modes: modeIds, vars: ids };
}

// Show a mode on frames or sections (null clears it, so they follow the page default).
async function dsSetMode(input) {
  const collection = (await figma.variables.getLocalVariableCollectionsAsync()).find((item) => item.name === input.collection);
  if (!collection) throw new Error(`Unknown collection "${input.collection}".`);
  const modeItem = collection.modes.find((item) => item.name === input.mode);
  if (input.mode !== null && !modeItem) throw new Error(`Unknown mode "${input.mode}".`);
  const done = [];
  for (const id of input.ids) {
    const node = await dsNode(id);
    if (input.mode === null) node.clearExplicitVariableModeForCollection(collection);
    else node.setExplicitVariableModeForCollection(collection, modeItem.modeId);
    done.push(id);
  }
  return { done };
}

const dsThemeHex = (color) => "#" + [color.r, color.g, color.b].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
const dsThemeLum = (color) => {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(color.r) + 0.7152 * lin(color.g) + 0.0722 * lin(color.b);
};
// The solid paint a layer reads as: hex, alpha (paint opacity x colour alpha) and a bound variable name.
async function dsThemePaintInfo(paint, names) {
  const alias = paint.boundVariables && paint.boundVariables.color;
  return {
    hex: dsThemeHex(paint.color),
    a: Math.round((paint.opacity === undefined ? 1 : paint.opacity) * 100) / 100,
    lum: dsThemeLum(paint.color),
    var: alias ? (names.get(alias.id) || alias.id) : null,
  };
}
// Rules: { field: "fills"|"strokes"|"text"|"shadow", types?, notTypes?, hex?, a?, tol?, on?, onVar?, onLum?: "dark"|"light",
//          pill?: bool, maxH?, minH?, radius?, var }. The first matching rule wins.
function dsThemeRuleMatch(rule, field, node, info, surface) {
  if (rule.field !== field) return false;
  if (rule.types && !rule.types.includes(node.type)) return false;
  if (rule.notTypes && rule.notTypes.includes(node.type)) return false;
  if (rule.hex && rule.hex.toLowerCase() !== info.hex) return false;
  if (rule.a !== undefined && Math.abs(rule.a - info.a) > (rule.tol === undefined ? 0.025 : rule.tol)) return false;
  if (rule.minA !== undefined && info.a < rule.minA) return false;
  if (rule.maxA !== undefined && info.a > rule.maxA) return false;
  if (rule.onVar !== undefined) {
    const list = Array.isArray(rule.onVar) ? rule.onVar : [rule.onVar];
    if (!list.includes(surface ? surface.var : null)) return false;
  }
  if (rule.notOnVar !== undefined) {
    const list = Array.isArray(rule.notOnVar) ? rule.notOnVar : [rule.notOnVar];
    if (list.includes(surface ? surface.var : null)) return false;
  }
  if (rule.onLum) {
    const dark = !surface || surface.lum < 0.35;
    if (rule.onLum === "dark" ? !dark : surface === null || surface.lum < 0.6) return false;
  }
  const h = "height" in node ? node.height : 0;
  if (rule.maxH !== undefined && h > rule.maxH) return false;
  if (rule.minH !== undefined && h < rule.minH) return false;
  if (rule.pill !== undefined) {
    const r = typeof node.cornerRadius === "number" ? node.cornerRadius : 0;
    const isPill = h > 0 && r >= h / 2 - 2;
    if (rule.pill !== isPill) return false;
  }
  return true;
}

// Read-only tally of solid paints under roots by field, node type, colour and what the layer
// sits on; or, with bind: true, bind matching paints to the collection's variables.
async function dsThemeWalk(input) {
  const collection = (await figma.variables.getLocalVariableCollectionsAsync()).find((item) => item.name === input.collection);
  const local = await figma.variables.getLocalVariablesAsync();
  const names = new Map(local.map((item) => [item.id, item.name]));
  const byName = new Map(local.filter((item) => !collection || item.variableCollectionId === collection.id).map((item) => [item.name, item]));
  const rules = input.rules || [];
  const bind = !!input.bind;
  if (bind && !collection) throw new Error(`Unknown collection "${input.collection}".`);
  const variable = (name) => {
    const found = byName.get(name);
    if (!found) throw new Error(`Unknown variable "${name}" in ${input.collection}.`);
    return found;
  };
  const started = Date.now();
  const budget = input.budgetMs || 12000;
  const tally = new Map();
  const bound = {};
  let visited = 0;
  let stopped = false;
  const note = (key, id) => {
    const item = tally.get(key) || { n: 0, ids: [] };
    item.n += 1;
    if (item.ids.length < 3) item.ids.push(id);
    tally.set(key, item);
  };
  const choose = (field, node, info, surface) => rules.find((rule) => dsThemeRuleMatch(rule, field, node, info, surface));
  const handlePaints = async (node, field, surface) => {
    const paints = node[field];
    if (!Array.isArray(paints) || paints.length === 0) return null;
    let changed = false;
    let top = null;
    const next = [];
    for (const paint of paints) {
      if (paint.type !== "SOLID" || paint.visible === false) { next.push(paint); continue; }
      const info = await dsThemePaintInfo(paint, names);
      const kind = field === "fills" && node.type === "TEXT" ? "text" : field;
      const rule = info.var ? null : choose(kind, node, info, surface);
      note(`${kind}|${node.type}|${info.hex}@${info.a}|on:${surface ? (surface.var || surface.hex + "@" + surface.a) : "scene"}|${rule ? rule.var : info.var ? "=" + info.var : "-"}`, node.id);
      if (bind && rule) {
        const solid = Object.assign({}, paint, { opacity: 1 });
        next.push(figma.variables.setBoundVariableForPaint(solid, "color", variable(rule.var)));
        bound[rule.var] = (bound[rule.var] || 0) + 1;
        changed = true;
        top = Object.assign({}, info, { var: rule.var });
      } else {
        next.push(paint);
        top = info;
      }
    }
    if (changed) node[field] = next;
    return top;
  };
  const handleText = async (node, surface) => {
    if (node.fills !== figma.mixed) { if (bind) await loadCurrentTextFonts(node); return handlePaints(node, "fills", surface); }
    const segments = node.getStyledTextSegments(["fills"]);
    let loaded = false;
    for (const segment of segments) {
      const paints = segment.fills;
      let changed = false;
      const next = [];
      for (const paint of paints) {
        if (paint.type !== "SOLID" || paint.visible === false) { next.push(paint); continue; }
        const info = await dsThemePaintInfo(paint, names);
        const rule = info.var ? null : choose("text", node, info, surface);
        note(`text|TEXT*|${info.hex}@${info.a}|on:${surface ? (surface.var || surface.hex + "@" + surface.a) : "scene"}|${rule ? rule.var : info.var ? "=" + info.var : "-"}`, node.id);
        if (bind && rule) {
          next.push(figma.variables.setBoundVariableForPaint(Object.assign({}, paint, { opacity: 1 }), "color", variable(rule.var)));
          bound[rule.var] = (bound[rule.var] || 0) + 1;
          changed = true;
        } else next.push(paint);
      }
      if (changed) {
        if (!loaded) { await loadCurrentTextFonts(node); loaded = true; }
        node.setRangeFills(segment.start, segment.end, next);
      }
    }
    return null;
  };
  const handleShadows = (node) => {
    if (!("effects" in node) || !Array.isArray(node.effects) || node.effects.length === 0 || node.effectStyleId) return;
    let changed = false;
    const next = node.effects.map((effect) => {
      if (effect.type !== "DROP_SHADOW" || effect.visible === false || (effect.boundVariables && effect.boundVariables.color)) return effect;
      const info = { hex: dsThemeHex(effect.color), a: Math.round(effect.color.a * 100) / 100, lum: dsThemeLum(effect.color), var: null };
      const rule = choose("shadow", node, info, null);
      note(`shadow|${node.type}|${info.hex}@${info.a}|${rule ? rule.var : "-"}`, node.id);
      if (!bind || !rule) return effect;
      changed = true;
      bound[rule.var] = (bound[rule.var] || 0) + 1;
      return figma.variables.setBoundVariableForEffect(effect, "color", variable(rule.var));
    });
    if (changed) node.effects = next;
  };
  // The photo's dark shade is a full-frame image above the photo: show it in Dark only, and add
  // a warm wash beside it for Light (both visibilities bound to boolean variables).
  const shades = [];
  const handleScene = async (root) => {
    const box = root.absoluteBoundingBox;
    const full = [];
    const find = (node) => {
      if (node.visible === false) return;
      if (node.type === "RECTANGLE" && Array.isArray(node.fills) && node.fills.some((p) => p.type === "IMAGE" && p.visible !== false)) {
        const b = node.absoluteBoundingBox;
        if (b && b.width >= box.width * 0.98 && b.height >= box.height * 0.9) full.push(node);
      }
      if ("children" in node && node.type !== "INSTANCE") for (const child of node.children) find(child);
    };
    find(root);
    for (const shade of full.slice(1)) {
      const already = shade.boundVariables && shade.boundVariables.visible;
      shades.push({ root: root.id, shade: shade.id, already: !!already });
      if (!bind || already || !input.scene) continue;
      const wash = figma.createRectangle();
      wash.name = "Light mode wash";
      shade.parent.insertChild(shade.parent.children.indexOf(shade) + 1, wash);
      if ("layoutMode" in shade.parent && shade.parent.layoutMode !== "NONE") wash.layoutPositioning = "ABSOLUTE";
      wash.x = shade.x; wash.y = shade.y;
      wash.resize(shade.width, shade.height);
      wash.constraints = shade.constraints;
      wash.fills = [figma.variables.setBoundVariableForPaint({ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }, "color", variable(input.scene.wash))];
      wash.setBoundVariable("visible", variable(input.scene.lightOnly));
      shade.setBoundVariable("visible", variable(input.scene.darkOnly));
    }
  };
  const visit = async (node, surface) => {
    if (stopped) return;
    if (Date.now() - started > budget) { stopped = true; return; }
    if (node.visible === false && !input.includeHidden) return;
    visited += 1;
    let mine = null;
    if (node.type === "TEXT") await handleText(node, surface);
    else if ("fills" in node) mine = await handlePaints(node, "fills", surface);
    if ("strokes" in node) await handlePaints(node, "strokes", surface);
    handleShadows(node);
    if (node.type === "INSTANCE" && !input.includeInstances) return;
    const own = mine && mine.a >= 0.5 && node.type !== "TEXT" && node.type !== "VECTOR" ? mine : null;
    if ("children" in node) for (const child of node.children) await visit(child, own || surface);
  };
  for (const id of input.rootIds) {
    const root = await dsNode(id);
    await handleScene(root);
    await visit(root, null);
    if (stopped) break;
  }
  const rows = [...tally.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, input.limit || 400).map(([key, item]) => Object.assign({ key }, item));
  return { visited, stopped, bound, shades, rows };
}

async function dsVarModes(input) {
  const node = input.nodeId ? await dsNode(input.nodeId) : null;
  const ids = new Set();
  if (node && "fills" in node && Array.isArray(node.fills))
    for (const paint of node.fills) if (paint.boundVariables && paint.boundVariables.color) ids.add(paint.boundVariables.color.id);
  const out = [];
  for (const id of ids) {
    const variable = await figma.variables.getVariableByIdAsync(id);
    const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
    const hex = (v) => (v && typeof v === "object" && "r" in v ? "#" + [v.r, v.g, v.b].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("") : JSON.stringify(v));
    const modes = collection.modes.map((mode) => ({ id: mode.modeId, name: mode.name, value: hex(variable.valuesByMode[mode.modeId]) }));
    const explicit = [];
    for (let at = node; at && at.type !== "DOCUMENT"; at = at.parent)
      if (at.explicitVariableModes && Object.keys(at.explicitVariableModes).length) explicit.push({ id: at.id, name: at.name, modes: at.explicitVariableModes });
    let resolved = null;
    try { resolved = hex(variable.resolveForConsumer(node).value); } catch (error) { resolved = String(error); }
    out.push({ variable: variable.name, remote: variable.remote, collection: collection.name, collectionId: collection.id, defaultMode: collection.defaultModeId, modes, explicit, resolved });
  }
  return { vars: out };
}

// Library copy of a local collection (Oct 29 2026): names, ids and publish keys of its variables.
async function dsCollectionKeys(input) {
  const collection = (await figma.variables.getLocalVariableCollectionsAsync()).find((item) => item.name === input.collection);
  if (!collection) throw new Error(`Unknown collection "${input.collection}".`);
  const vars = (await figma.variables.getLocalVariablesAsync()).filter((item) => item.variableCollectionId === collection.id);
  return { collectionId: collection.id, collectionKey: collection.key, modes: collection.modes, vars: Object.fromEntries(vars.map((item) => [item.name, { id: item.id, key: item.key }])) };
}

// Rebinds layers from a local collection to the library variables of the same names (imported by
// key): paints, text ranges, effects, single bound fields such as visible, and explicit modes.
// dryRun only counts. Bounded by a time budget; call again until it reports nothing found.
async function dsSwapVars(input) {
  const root = await dsNode(input.rootId);
  if (root.type === "PAGE") await root.loadAsync();
  const budget = input.budgetMs || 8000;
  const started = Date.now();
  const local = (await figma.variables.getLocalVariableCollectionsAsync()).find((item) => item.name === input.fromCollection);
  if (!local) throw new Error(`Unknown collection "${input.fromCollection}".`);
  const localVars = (await figma.variables.getLocalVariablesAsync()).filter((item) => item.variableCollectionId === local.id);
  const byId = new Map(localVars.map((item) => [item.id, item]));
  const imported = new Map();
  const target = async (id) => {
    const variable = byId.get(id);
    if (!variable) return null;
    if (!imported.has(variable.name)) {
      const key = input.keys[variable.name];
      if (!key) throw new Error(`No library key for "${variable.name}".`);
      imported.set(variable.name, await figma.variables.importVariableByKeyAsync(key));
    }
    return imported.get(variable.name);
  };
  let library = null;
  const libraryMode = async (localModeId) => {
    const mode = local.modes.find((item) => item.modeId === localModeId);
    if (!library) library = await figma.variables.getVariableCollectionByIdAsync((await target(localVars[0].id)).variableCollectionId);
    const match = mode && library.modes.find((item) => item.name === mode.name);
    if (!match) throw new Error(`The library collection has no mode for ${localModeId}.`);
    return match.modeId;
  };
  const counts = {};
  let found = 0;
  let visited = 0;
  let stopped = false;
  const tally = (field) => { counts[field] = (counts[field] || 0) + 1; found += 1; };
  const isLocal = (alias) => alias && alias.type === "VARIABLE_ALIAS" && byId.has(alias.id);
  const swapPaints = async (paints, field) => {
    if (!Array.isArray(paints)) return null;
    let touched = false;
    const next = [];
    for (const paint of paints) {
      const alias = paint && paint.boundVariables && paint.boundVariables.color;
      if (paint && paint.gradientStops && paint.gradientStops.some((stop) => stop.boundVariables && isLocal(stop.boundVariables.color))) tally(`${field}:gradient`);
      if (paint && paint.type === "SOLID" && isLocal(alias)) {
        tally(field);
        touched = true;
        next.push(input.dryRun ? paint : figma.variables.setBoundVariableForPaint(paint, "color", await target(alias.id)));
      } else next.push(paint);
    }
    return touched ? next : null;
  };
  const visit = async (node) => {
    if (Date.now() - started > budget) { stopped = true; return; }
    visited += 1;
    if (node.type === "TEXT" && node.fills === figma.mixed) {
      for (const segment of node.getStyledTextSegments(["fills"])) {
        const next = await swapPaints(segment.fills, "text");
        if (next && !input.dryRun) node.setRangeFills(segment.start, segment.end, next);
      }
    } else if ("fills" in node) {
      const next = await swapPaints(node.fills, node.type === "TEXT" ? "text" : "fills");
      if (next && !input.dryRun) node.fills = next;
    }
    if ("strokes" in node) {
      const next = await swapPaints(node.strokes, "strokes");
      if (next && !input.dryRun) node.strokes = next;
    }
    if ("effects" in node && Array.isArray(node.effects) && node.effects.length) {
      let touched = false;
      const next = [];
      for (const effect of node.effects) {
        let now = effect;
        for (const [field, alias] of Object.entries(effect.boundVariables || {})) {
          if (!isLocal(alias)) continue;
          tally(`effect.${field}`);
          touched = true;
          if (!input.dryRun) now = figma.variables.setBoundVariableForEffect(now, field, await target(alias.id));
        }
        next.push(now);
      }
      if (touched && !input.dryRun) node.effects = next;
    }
    for (const [field, alias] of Object.entries(node.boundVariables || {})) {
      if (Array.isArray(alias) || !isLocal(alias)) continue;
      tally(field);
      if (!input.dryRun) node.setBoundVariable(field, await target(alias.id));
    }
    const modes = node.explicitVariableModes;
    if (modes && modes[local.id]) {
      tally("explicitMode");
      if (!input.dryRun) {
        const modeId = await libraryMode(modes[local.id]);
        node.setExplicitVariableModeForCollection(library, modeId);
        node.clearExplicitVariableModeForCollection(local);
      }
    }
    if ("children" in node) for (const child of node.children) { await visit(child); if (stopped) return; }
  };
  await visit(root);
  return { found, counts, visited, truncated: stopped, dryRun: !!input.dryRun, ms: Date.now() - started };
}

// Removes a local variable collection. Layers still bound to it keep their last values, detached.
async function dsRemoveCollection(input) {
  if (input.confirm !== true) throw new Error("Pass confirm: true to remove a variable collection.");
  const collection = (await figma.variables.getLocalVariableCollectionsAsync()).find((item) => item.name === input.collection);
  if (!collection) throw new Error(`Unknown collection "${input.collection}".`);
  collection.remove();
  return { removed: input.collection };
}

// Read-only: paints bound to an imported library variable that is not the variable its key now
// imports (a stale copy left behind by an earlier import). Such a binding keeps the old value
// after the library changes. Fills, strokes and text ranges; bounded by a time budget.
async function dsStaleVars(input) {
  const root = await dsNode(input.rootId);
  if (root.type === "PAGE") await root.loadAsync();
  const limit = input.limit || 500;
  const budget = input.budgetMs || 15000;
  const started = Date.now();
  const found = [];
  const variables = new Map();
  const current = new Map();
  let visited = 0;
  let stopped = false;
  const isStale = async (id) => {
    if (!variables.has(id)) variables.set(id, await figma.variables.getVariableByIdAsync(id));
    const variable = variables.get(id);
    if (!variable || !variable.remote || !variable.key) return null;
    if (!current.has(variable.key)) {
      let imported = null;
      try { imported = await figma.variables.importVariableByKeyAsync(variable.key); } catch (error) { imported = null; }
      current.set(variable.key, imported);
    }
    const now = current.get(variable.key);
    return now && now.id !== variable.id ? variable.name : null;
  };
  const check = async (node, paints, field, range) => {
    if (!Array.isArray(paints)) return;
    for (const paint of paints) {
      const alias = paint && paint.type === "SOLID" && paint.boundVariables && paint.boundVariables.color;
      if (!alias) continue;
      const name = await isStale(alias.id);
      if (name) found.push({ id: node.id, type: node.type, field, range, variable: name, mixed: node.type === "TEXT" && node.fills === figma.mixed });
    }
  };
  const visit = async (node, hidden) => {
    if (found.length >= limit || Date.now() - started > budget) { stopped = true; return; }
    visited += 1;
    const isHidden = hidden || node.visible === false;
    if (isHidden && !input.includeHidden) return;
    if (node.type === "TEXT" && node.fills === figma.mixed) {
      for (const segment of node.getStyledTextSegments(["fills"])) await check(node, segment.fills, "fills", [segment.start, segment.end]);
    } else if ("fills" in node) await check(node, node.fills, "fills");
    if ("strokes" in node) await check(node, node.strokes, "strokes");
    if ("children" in node) for (const child of node.children) await visit(child, isHidden);
  };
  await visit(root, false);
  return { found, visited, truncated: stopped, ms: Date.now() - started };
}

// Binds every stale copy found by dsStaleVars to the variable its key imports now, changing only
// that paint (opacity, blend and the other paints stay). Bounded by a time budget; call again
// until it reports nothing left.
async function dsRebindStale(input) {
  const root = await dsNode(input.rootId);
  if (root.type === "PAGE") await root.loadAsync();
  const budget = input.budgetMs || 8000;
  const started = Date.now();
  const variables = new Map();
  const current = new Map();
  let changed = 0;
  let stopped = false;
  const replacement = async (id) => {
    if (!variables.has(id)) variables.set(id, await figma.variables.getVariableByIdAsync(id));
    const variable = variables.get(id);
    if (!variable || !variable.remote || !variable.key) return null;
    if (!current.has(variable.key)) {
      let imported = null;
      try { imported = await figma.variables.importVariableByKeyAsync(variable.key); } catch (error) { imported = null; }
      current.set(variable.key, imported);
    }
    const now = current.get(variable.key);
    return now && now.id !== variable.id ? now : null;
  };
  const fresh = async (paints) => {
    if (!Array.isArray(paints)) return null;
    let touched = false;
    const next = [];
    for (const paint of paints) {
      const alias = paint && paint.type === "SOLID" && paint.boundVariables && paint.boundVariables.color;
      const now = alias ? await replacement(alias.id) : null;
      if (now) { next.push(figma.variables.setBoundVariableForPaint(paint, "color", now)); touched = true; }
      else next.push(paint);
    }
    return touched ? next : null;
  };
  const visit = async (node, hidden) => {
    if (Date.now() - started > budget) { stopped = true; return; }
    const isHidden = hidden || node.visible === false;
    if (node.type === "TEXT" && node.fills === figma.mixed) {
      for (const segment of node.getStyledTextSegments(["fills"])) {
        const next = await fresh(segment.fills);
        if (next) { node.setRangeFills(segment.start, segment.end, next); changed += 1; }
      }
    } else if ("fills" in node) {
      const next = await fresh(node.fills);
      if (next) { node.fills = next; changed += 1; }
    }
    if ("strokes" in node) {
      const next = await fresh(node.strokes);
      if (next) { node.strokes = next; changed += 1; }
    }
    if ("children" in node) for (const child of node.children) await visit(child, isHidden);
  };
  await visit(root, false);
  return { changed, truncated: stopped, ms: Date.now() - started };
}

async function dsLibAudit(input) {
  const found = { components: new Map(), styles: new Map(), variables: new Map() };
  const styleCache = new Map();
  const variableCache = new Map();
  const add = (kind, key, entry, id) => {
    const current = found[kind].get(key);
    if (current) current.count += 1;
    else found[kind].set(key, Object.assign(entry, { count: 1, sample: id }));
  };
  const noteStyle = async (id, node, aspect) => {
    if (!id || id === figma.mixed) return;
    if (!styleCache.has(id)) {
      const style = await figma.getStyleByIdAsync(id);
      styleCache.set(id, style ? { key: style.key, name: style.name, type: style.type, remote: style.remote } : null);
    }
    const style = styleCache.get(id);
    add("styles", style ? `${style.key}:${aspect}` : `missing:${id}`, style ? Object.assign({ aspect }, style) : { key: null, name: "(missing)", aspect }, node.id);
  };
  const noteVariable = async (alias, node, field) => {
    if (!alias || alias.type !== "VARIABLE_ALIAS" || !alias.id) return;
    if (!variableCache.has(alias.id)) {
      const variable = await figma.variables.getVariableByIdAsync(alias.id);
      variableCache.set(alias.id, variable ? { key: variable.key, name: variable.name, remote: variable.remote, type: variable.resolvedType } : null);
    }
    const variable = variableCache.get(alias.id);
    add("variables", variable ? variable.key : `missing:${alias.id}`, variable ? Object.assign({ field }, variable) : { key: null, name: "(missing)", field }, node.id);
  };
  const noteBound = async (value, node, field) => {
    if (!value) return;
    if (Array.isArray(value)) { for (const item of value) await noteBound(item, node, field); return; }
    if (value.type === "VARIABLE_ALIAS") { await noteVariable(value, node, field); return; }
    if (typeof value === "object") for (const [key, item] of Object.entries(value)) await noteBound(item, node, `${field}.${key}`);
  };
  const visit = async (node) => {
    if (node.visible === false && !input.includeHidden) return;
    if (node.type === "INSTANCE") {
      const main = await node.getMainComponentAsync();
      if (!main) add("components", "missing", { key: null, name: "(missing)", remote: null }, node.id);
      else {
        const set = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent : null;
        const holder = set || main;
        add("components", holder.key || holder.id, { key: holder.key, name: holder.name, remote: main.remote }, node.id);
      }
    }
    for (const [aspect, property] of [["fill", "fillStyleId"], ["stroke", "strokeStyleId"], ["effect", "effectStyleId"], ["grid", "gridStyleId"]]) {
      if (property in node) await noteStyle(node[property], node, aspect);
    }
    if (node.type === "TEXT") {
      if (node.textStyleId === figma.mixed) {
        for (const segment of node.getStyledTextSegments(["textStyleId"])) await noteStyle(segment.textStyleId, node, "text");
      } else await noteStyle(node.textStyleId, node, "text");
    }
    if (node.boundVariables) for (const [field, value] of Object.entries(node.boundVariables)) await noteBound(value, node, field);
    if ("children" in node) for (const child of node.children) await visit(child);
  };
  for (const rootId of input.rootIds) {
    const root = await dsNode(rootId);
    if (root.type === "PAGE") await root.loadAsync();
    await visit(root);
  }
  const list = (kind) => [...found[kind].values()].sort((a, b) => b.count - a.count);
  return { components: list("components"), styles: list("styles"), variables: list("variables") };
}

// Like dsInspect, plus each layer's auto layout (mode, gap, padding, sizing, alignment, absolute
// positioning), clipping, fill/stroke variable names, text style and corner radius, so layout edits
// can be planned without more calls. Read-only.
async function dsInspectLayout(input) {
  const root = await dsNode(input.nodeId);
  const names = new Map();
  const variableName = async (alias) => {
    if (!alias || !alias.id) return null;
    if (!names.has(alias.id)) { const variable = await figma.variables.getVariableByIdAsync(alias.id); names.set(alias.id, variable ? variable.name : alias.id); }
    return names.get(alias.id);
  };
  const styleName = async (id) => {
    if (!id || id === figma.mixed) return id === figma.mixed ? "mixed" : null;
    if (!names.has(id)) { const style = await figma.getStyleByIdAsync(id); names.set(id, style ? style.name : id); }
    return names.get(id);
  };
  const paints = async (list) => {
    if (list === figma.mixed) return "mixed";
    const out = [];
    for (const paint of list || []) {
      if (paint.visible === false) continue;
      if (paint.type !== "SOLID") { out.push(paint.type); continue; }
      out.push((await variableName(paint.boundVariables && paint.boundVariables.color)) || dsHex(paint.color));
    }
    return out.length ? out : undefined;
  };
  const walk = async (current, depth) => {
    const item = { id: current.id, name: current.name, type: current.type };
    if ("width" in current) { item.w = Math.round(current.width); item.h = Math.round(current.height); }
    if ("x" in current) { item.x = Math.round(current.x); item.y = Math.round(current.y); }
    if (current.visible === false) item.hidden = true;
    if (current.type === "INSTANCE" && current.componentProperties) item.props = Object.fromEntries(Object.entries(current.componentProperties).map(([key, value]) => [key.split("#")[0], value.value]));
    if ("layoutMode" in current && current.layoutMode && current.layoutMode !== "NONE") {
      item.layout = { mode: current.layoutMode === "HORIZONTAL" ? "H" : "V", gap: current.itemSpacing, pad: [current.paddingTop, current.paddingRight, current.paddingBottom, current.paddingLeft], align: current.primaryAxisAlignItems, cross: current.counterAxisAlignItems };
      if (current.layoutWrap === "WRAP") item.layout.wrap = true;
    }
    if ("layoutSizingHorizontal" in current && current.parent && "layoutMode" in current.parent && current.parent.layoutMode && current.parent.layoutMode !== "NONE") {
      item.sizing = `${current.layoutSizingHorizontal[0]}${current.layoutSizingVertical[0]}`;
      if (current.layoutPositioning === "ABSOLUTE") item.abs = true;
    } else if ("layoutSizingHorizontal" in current && "layoutMode" in current && current.layoutMode && current.layoutMode !== "NONE") {
      item.sizing = `${current.layoutSizingHorizontal[0]}${current.layoutSizingVertical[0]}`;
    }
    if ("clipsContent" in current && current.clipsContent && current.type !== "INSTANCE") item.clip = true;
    if ("cornerRadius" in current && current.cornerRadius && current.cornerRadius !== figma.mixed && current.type !== "TEXT") item.radius = current.cornerRadius;
    if (current.type !== "INSTANCE" || input.instanceFills) {
      if ("fills" in current) { const fill = await paints(current.fills); if (fill) item.fill = fill; }
      if ("strokes" in current) { const stroke = await paints(current.strokes); if (stroke) item.stroke = stroke; }
    }
    if (current.type === "TEXT") {
      item.text = current.characters.slice(0, input.textLength || 120);
      item.style = await styleName(current.textStyleId);
      if (current.textStyleId === figma.mixed) item.segments = await Promise.all(current.getStyledTextSegments(["textStyleId"]).map(async (segment) => ({ chars: segment.characters.slice(0, 40), style: await styleName(segment.textStyleId) })));
      item.textAutoResize = current.textAutoResize;
    }
    if (depth < (input.depth || 2) && "children" in current) {
      item.children = [];
      for (const child of current.children) item.children.push(await walk(child, depth + 1));
    }
    return item;
  };
  const out = await walk(root, 0);
  if (root.parent) out.parent = { id: root.parent.id, name: root.parent.name, type: root.parent.type };
  return out;
}

// Resizes a section to wrap its children (positions are section-relative) plus padding.
async function dsFitSection(input) {
  const section = await dsNode(input.id);
  if (section.type !== "SECTION") throw new Error(`${input.id} is not a section.`);
  const pad = input.pad === undefined ? 100 : input.pad;
  let maxX = 0;
  let maxY = 0;
  for (const child of section.children) {
    maxX = Math.max(maxX, child.x + child.width);
    maxY = Math.max(maxY, child.y + child.height);
  }
  section.resizeWithoutConstraints(Math.max(maxX + pad, input.minWidth || 0), Math.max(maxY + pad, input.minHeight || 0));
  return { id: section.id, name: section.name, w: Math.round(section.width), h: Math.round(section.height) };
}

// Sets component properties (including variants) on existing instances in place.
async function dsSetProps(input) {
  const result = [];
  for (const item of input.items) {
    const instance = await dsNode(item.id);
    if (instance.type !== "INSTANCE") throw new Error(`${item.id} is not an instance.`);
    await dsSetInstanceProperties(instance, item.props, instance.name);
    result.push({ id: instance.id, name: instance.name, props: Object.fromEntries(Object.entries(instance.componentProperties).map(([key, value]) => [key, value.value])) });
  }
  return { updated: result };
}

async function dsSetVisible(input) {
  const result = [];
  for (const id of input.ids) {
    const node = await dsNode(id);
    node.visible = input.visible;
    result.push({ id: node.id, name: node.name, visible: node.visible });
  }
  return { updated: result };
}

async function dsRename(input) {
  const result = [];
  for (const item of input.items) {
    const node = await dsNode(item.id);
    node.name = item.name;
    result.push({ id: node.id, name: node.name });
  }
  return { updated: result };
}

// Adds a variant to an existing component set by cloning a sibling variant. Cloning drops
// componentPropertyReferences, so they are copied back from the source layer by layer.
// Add component properties to an existing component set (or component) and bind them to
// layers that already exist in every variant (by layer name), like dsRender does on creation.
async function dsAddProps(input) {
  const owner = await dsNode(input.id);
  if (owner.type !== "COMPONENT_SET" && owner.type !== "COMPONENT") throw new Error(`"${owner.name}" is not a component or component set.`);
  const variants = owner.type === "COMPONENT_SET" ? owner.children : [owner];
  const existing = Object.keys(owner.componentPropertyDefinitions || {}).map((key) => key.split("#")[0]);
  const props = input.props.filter((prop) => !existing.includes(prop.name));
  const keys = await dsBindProperties(owner, props, variants);
  return { id: owner.id, added: keys, skipped: input.props.filter((prop) => existing.includes(prop.name)).map((prop) => prop.name) };
}

// Remove component properties by name; bound layers keep their current values.
async function dsRemoveProps(input) {
  const owner = await dsNode(input.id);
  const defs = owner.componentPropertyDefinitions || {};
  const removed = [];
  for (const name of input.names) {
    const key = Object.keys(defs).find((k) => k === name || k.split("#")[0] === name);
    if (!key) continue;
    owner.deleteComponentProperty(key);
    removed.push(key);
  }
  return { id: owner.id, removed };
}

async function dsAddVariant(input) {
  const source = await dsNode(input.sourceId);
  const set = source.parent;
  if (source.type !== "COMPONENT" || !set || set.type !== "COMPONENT_SET") throw new Error(`${input.sourceId} is not a variant inside a component set.`);
  const clone = source.clone();
  const index = input.index === undefined ? set.children.indexOf(source) + 1 : input.index;
  set.insertChild(Math.min(index, set.children.length), clone);
  clone.name = input.name;
  // Layers inside a nested instance belong to that instance's own component, so stop there.
  const copyRefs = (from, to) => {
    if (from.componentPropertyReferences && Object.keys(from.componentPropertyReferences).length) to.componentPropertyReferences = Object.assign({}, from.componentPropertyReferences);
    if (from.type === "INSTANCE") return;
    if ("children" in from && "children" in to) from.children.forEach((child, i) => { if (to.children[i]) copyRefs(child, to.children[i]); });
  };
  try {
    (source.children || []).forEach((child, i) => copyRefs(child, clone.children[i]));
  } catch (error) {
    clone.remove();
    throw error;
  }
  return { id: clone.id, name: clone.name, setId: set.id, variantProperties: clone.variantProperties };
}

// Turns a standalone component into a one-variant component set in place. The component keeps
// its id, so existing instances stay linked; its properties move to the set.
async function dsMakeSet(input) {
  const component = await dsNode(input.id);
  if (component.type !== "COMPONENT" || (component.parent && component.parent.type === "COMPONENT_SET")) throw new Error(`${input.id} is not a standalone component.`);
  const parent = component.parent;
  const index = parent.children.indexOf(component);
  const name = input.name || component.name;
  const set = figma.combineAsVariants([component], parent, index);
  set.name = name;
  component.name = input.variantName;
  await dsStyleContainer(set, { layout: input.layout || "H", gap: 20, pad: 24, align: "start", cross: "start", wrap: input.wrap, wrapGap: 20, fill: { hex: "#FFFFFF", opacity: 0 }, stroke: "#9747FF", dash: [10, 5], radius: 5 });
  dsSize(set, { sizeW: input.w ? "fixed" : "hug", sizeH: "hug", w: input.w }, parent);
  if (input.description) set.description = input.description;
  dsState.components.set(name, set.id);
  return { setId: set.id, variantId: component.id, name: set.name };
}

// Swaps nested or top-level instances to another component (overrides on same-named layers carry over).
async function dsSwap(input) {
  const result = [];
  for (const item of input.items) {
    const instance = await dsNode(item.id);
    if (instance.type !== "INSTANCE") throw new Error(`${item.id} is not an instance.`);
    const component = await dsResolveComponent(item.component, item.variant);
    instance.swapComponent(component);
    result.push({ id: instance.id, name: instance.name, main: component.name });
  }
  return { swapped: result };
}

const DS_SETTABLE_FIELDS = new Set([
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "itemSpacing", "counterAxisSpacing",
  "cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius",
  "layoutMode", "layoutWrap", "primaryAxisAlignItems", "counterAxisAlignItems", "primaryAxisSizingMode", "counterAxisSizingMode",
  "layoutSizingHorizontal", "layoutSizingVertical", "layoutGrow", "layoutAlign", "layoutPositioning",
  "strokeWeight", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight", "strokeAlign",
  "clipsContent", "overflowDirection", "opacity", "minWidth", "maxWidth", "minHeight", "maxHeight", "itemReverseZIndex", "textAutoResize",
  "textAlignHorizontal", "textAlignVertical",
]);

// Sets whitelisted layout and geometry fields; {var: "space/8"} binds a number variable,
// "effectStyle" applies a named effect style and "size" resizes.
// Copies nodes from any page into a parent (page, section or frame), optionally at a child index.
async function dsClone(input) {
  const created = [];
  for (const item of input.items) {
    const parent = await dsNode(item.parentId || input.parentId);
    if (parent.type === "PAGE") await parent.loadAsync();
    const source = await dsNode(item.id);
    let page = source.parent;
    while (page && page.type !== "PAGE") page = page.parent;
    if (page) await page.loadAsync();
    const copy = source.clone();
    if (item.index !== undefined) parent.insertChild(Math.min(item.index, parent.children.length), copy);
    else parent.appendChild(copy);
    if (item.name) copy.name = item.name;
    if (item.x !== undefined) copy.x = item.x;
    if (item.y !== undefined) copy.y = item.y;
    created.push({ id: copy.id, name: copy.name, source: source.id, parent: parent.id, x: Math.round(copy.x), y: Math.round(copy.y), w: Math.round(copy.width), h: Math.round(copy.height) });
  }
  return { created };
}

// Finds layers under a root by type, name and/or text, reporting the nearest enclosing instance
// (for example the Button that holds a matched label) so callers can target it.
async function dsFind(input) {
  const root = await dsNode(input.rootId);
  if (root.type === "PAGE") await root.loadAsync();
  const flags = input.flags === undefined ? "" : input.flags;
  const nameRe = input.name ? new RegExp(input.name, flags) : null;
  const textRe = input.text ? new RegExp(input.text, flags) : null;
  const types = input.types ? new Set(input.types) : null;
  const limit = input.limit || 50;
  const found = [];
  const visit = (node, instances, hidden) => {
    if (found.length >= limit) return;
    const isHidden = hidden || node.visible === false;
    if (input.visibleOnly && isHidden) return;
    if (node !== root) {
      const text = node.type === "TEXT" ? node.characters : null;
      if ((!types || types.has(node.type)) && (!nameRe || nameRe.test(node.name)) && (!textRe || (text !== null && textRe.test(text)))) {
        const item = { id: node.id, name: node.name, type: node.type, visible: !isHidden };
        if (text !== null) item.text = text.slice(0, 120);
        if ("absoluteBoundingBox" in node && node.absoluteBoundingBox) {
          const box = node.absoluteBoundingBox;
          item.box = [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)];
        }
        const near = instances[instances.length - 1];
        if (near) item.instance = { id: near.id, name: near.name };
        if (instances[0]) item.topInstance = { id: instances[0].id, name: instances[0].name };
        found.push(item);
      }
    }
    if (!("children" in node)) return;
    const next = node !== root && node.type === "INSTANCE" ? instances.concat([node]) : instances;
    for (const child of node.children) visit(child, next, isHidden);
  };
  visit(root, [], false);
  return { found, truncated: found.length >= limit };
}

// Read-only: ancestor chain (nearest first) with geometry and auto-layout mode.
async function dsParents(input) {
  const result = {};
  for (const id of input.ids) {
    const chain = [];
    let current = (await dsNode(id)).parent;
    while (current && current.type !== "PAGE" && chain.length < (input.depth || 6)) {
      const item = { id: current.id, name: current.name, type: current.type };
      if ("width" in current) { item.w = Math.round(current.width); item.h = Math.round(current.height); item.x = Math.round(current.x); item.y = Math.round(current.y); }
      if ("layoutMode" in current) item.layout = current.layoutMode;
      if ("itemSpacing" in current && current.layoutMode !== "NONE") item.gap = current.itemSpacing;
      if ("primaryAxisSizingMode" in current && current.layoutMode !== "NONE") item.sizing = [current.primaryAxisSizingMode, current.counterAxisSizingMode];
      if ("children" in current) item.children = current.children.length;
      chain.push(item);
      current = current.parent;
    }
    result[id] = chain;
  }
  return result;
}

// Read-only: nodes under rootId whose own fills include an image (id, name, size, image hash).
async function dsImages(input) {
  const root = await dsNode(input.rootId);
  const nameRe = input.name ? new RegExp(input.name, input.flags || "") : null;
  const found = [];
  const visit = (node, hidden) => {
    if (found.length >= (input.limit || 200)) return;
    const isHidden = hidden || node.visible === false;
    if (input.visibleOnly && isHidden) return;
    if ("fills" in node && Array.isArray(node.fills)) {
      const image = node.fills.find((paint) => paint.type === "IMAGE" && paint.visible !== false);
      if (image && (!nameRe || nameRe.test(node.name))) found.push({ id: node.id, name: node.name, type: node.type, w: Math.round(node.width), h: Math.round(node.height), hash: image.imageHash, scaleMode: image.scaleMode });
    }
    if ("children" in node) for (const child of node.children) visit(child, isHidden);
  };
  visit(root, false);
  return { found };
}

// Read-only: a node's image fill (scale mode, crop transform) and the image's pixel size.
async function dsImageInfo(input) {
  const node = await dsNode(input.id);
  const paint = (node.fills || []).find((fill) => fill.type === "IMAGE");
  if (!paint) throw new Error(`${input.id} has no image fill.`);
  const image = figma.getImageByHash(paint.imageHash);
  const size = image ? await image.getSizeAsync() : null;
  return { id: node.id, w: node.width, h: node.height, hash: paint.imageHash, scaleMode: paint.scaleMode, imageTransform: paint.imageTransform || null, imageSize: size };
}

// Sets a section's size directly (dsFitSection counts hidden archive children too).
async function dsSectionSize(input) {
  const section = await dsNode(input.id);
  if (section.type !== "SECTION") throw new Error(`${input.id} is not a section.`);
  section.resizeWithoutConstraints(input.w, input.h);
  if (input.name) section.name = input.name;
  return { id: section.id, name: section.name, w: Math.round(section.width), h: Math.round(section.height) };
}

// Sets prototype interactions. Each link navigates to a frame (or goes back) on click.
async function dsSetReactions(input) {
  const updated = [];
  for (const item of input.items) {
    const node = await dsNode(item.id);
    const reactions = (item.links || []).map((link) => {
      const transition = link.transition === "none" ? null : { type: link.transition || "DISSOLVE", easing: { type: "EASE_OUT" }, duration: (link.duration === undefined ? 200 : link.duration) / 1000 };
      const action = link.back ? { type: "BACK" } : { type: "NODE", destinationId: link.to, navigation: link.navigation || "NAVIGATE", transition, preserveScrollPosition: false };
      const trigger = link.trigger === "AFTER_TIMEOUT" ? { type: "AFTER_TIMEOUT", timeout: (link.timeout === undefined ? 1200 : link.timeout) / 1000 } : { type: link.trigger || "ON_CLICK" };
      return { trigger, actions: [action] };
    });
    await node.setReactionsAsync(item.append ? node.reactions.concat(reactions) : reactions);
    updated.push({ id: node.id, name: node.name, reactions: node.reactions.length });
  }
  return { updated };
}

// Read-only: lists prototype links (reactions) under rootId whose destination is one of
// targetIds, plus the page's flow starting points that start on a target.
async function dsLinksTo(input) {
  const root = await dsNode(input.rootId);
  if (root.type === "PAGE") await root.loadAsync();
  const targets = new Set(input.targetIds);
  const links = [];
  const limit = input.limit || 300;
  const label = (node) => {
    if (node.type === "TEXT") return node.characters;
    if (!("findOne" in node)) return null;
    const text = node.findOne((child) => child.type === "TEXT" && child.visible !== false);
    return text ? text.characters : null;
  };
  const visit = (node, hidden, frame) => {
    if (links.length >= limit) return;
    const isHidden = hidden || node.visible === false;
    if ("reactions" in node && node.reactions) {
      for (const reaction of node.reactions) {
        const actions = reaction.actions || (reaction.action ? [reaction.action] : []);
        for (const action of actions) {
          if (action && action.destinationId && targets.has(action.destinationId)) {
            const text = label(node);
            links.push({ id: node.id, name: node.name, type: node.type, visible: !isHidden, destinationId: action.destinationId, trigger: reaction.trigger && reaction.trigger.type, label: text && text.slice(0, 60), frame });
          }
        }
      }
    }
    const nextFrame = frame || (node !== root && node.type !== "SECTION" && node.parent && (node.parent.type === "SECTION" || node.parent.type === "PAGE") ? node.id + " " + node.name.slice(0, 60) : null);
    if ("children" in node) for (const child of node.children) visit(child, isHidden, nextFrame);
  };
  visit(root, false, null);
  const page = root.type === "PAGE" ? root : null;
  const flows = page ? page.flowStartingPoints.filter((flow) => targets.has(flow.nodeId)) : [];
  return { links, flows };
}

// Rewrites prototype links under rootId: every action whose destinationId is a key of map
// is pointed at map[key]. dryRun only counts. Errors are reported per node, not thrown.
async function dsRepointLinks(input) {
  const root = await dsNode(input.rootId);
  if (root.type === "PAGE") await root.loadAsync();
  const map = input.map;
  const changed = [];
  const failed = [];
  const nodes = [];
  const visit = (node) => {
    if ((!input.ids || input.ids.includes(node.id)) && "reactions" in node && node.reactions && node.reactions.some((reaction) => (reaction.actions || (reaction.action ? [reaction.action] : [])).some((action) => action && action.destinationId && map[action.destinationId]))) nodes.push(node);
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(root);
  for (const node of nodes) {
    const next = node.reactions.map((reaction) => {
      const copy = JSON.parse(JSON.stringify(reaction));
      if (copy.actions) delete copy.action;
      const actions = copy.actions || (copy.action ? [copy.action] : []);
      for (const action of actions) if (action && action.destinationId && map[action.destinationId]) action.destinationId = map[action.destinationId];
      return copy;
    });
    if (input.dryRun) { changed.push({ id: node.id, name: node.name }); continue; }
    try {
      await node.setReactionsAsync(next);
      changed.push({ id: node.id, name: node.name });
    } catch (error) {
      failed.push({ id: node.id, name: node.name, error: String(error && error.message || error).slice(0, 200) });
    }
  }
  return { changed: changed.length, failed, sample: changed.slice(0, 10) };
}

async function dsFlowStarts(input) {
  const page = await dsNode(input.pageId);
  if (page.type !== "PAGE") throw new Error(`${input.pageId} is not a page.`);
  if (input.remove) {
    const drop = new Set(input.remove);
    page.flowStartingPoints = page.flowStartingPoints.filter((flow) => !drop.has(flow.nodeId));
    return { flowStartingPoints: page.flowStartingPoints };
  }
  const next = input.starts.map((start) => ({ nodeId: start.nodeId, name: start.name }));
  // append keeps existing flows, replacing any with the same name.
  page.flowStartingPoints = input.append ? page.flowStartingPoints.filter((flow) => !next.some((n) => n.name === flow.name)).concat(next) : next;
  return { flowStartingPoints: page.flowStartingPoints };
}

function dsHex(color) {
  const channel = (value) => Math.round(value * 255).toString(16).padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

// Reports what in each frame is not taken from the design system: text without a library
// text style, solid paints not bound to a variable, effects without a style, and instances of
// local or missing components. Layers inside instances are reported separately (overrides).
async function dsAuditDS(input) {
  const styles = new Map();
  const styleInfo = async (id) => {
    if (!styles.has(id)) { const style = await figma.getStyleByIdAsync(id); styles.set(id, style ? { remote: style.remote, name: style.name } : null); }
    return styles.get(id);
  };
  const max = input.samples === undefined ? 6 : input.samples;
  const results = [];
  for (const rootId of input.rootIds) {
    const root = await dsNode(rootId);
    const r = { id: root.id, name: root.name, counts: { text: 0, unstyledText: 0, localStyleText: 0, rawPaints: 0, instRawPaints: 0, rawEffects: 0, localInstances: 0, missingMain: 0 }, samples: {} };
    const note = (kind, item) => { r.counts[kind] += 1; const list = r.samples[kind] || (r.samples[kind] = []); if (list.length < max) list.push(item); };
    const visit = async (node, inInstance) => {
      if (node.visible === false && !input.includeHidden) return;
      if (node.type === "INSTANCE") {
        const main = await node.getMainComponentAsync();
        if (!main) note("missingMain", { id: node.id, name: node.name });
        else if (!main.remote) note("localInstances", { id: node.id, name: main.parent && main.parent.type === "COMPONENT_SET" ? main.parent.name : main.name });
      }
      if (node.type === "TEXT") {
        r.counts.text += 1;
        const id = node.textStyleId;
        const unstyled = id === figma.mixed ? node.getStyledTextSegments(["textStyleId"]).some((segment) => !segment.textStyleId) : !id;
        if (unstyled) {
          const font = node.fontName === figma.mixed ? "mixed" : `${node.fontName.family} ${node.fontName.style}`;
          note("unstyledText", { id: node.id, inInstance, chars: node.characters.slice(0, 40), font, size: node.fontSize === figma.mixed ? "mixed" : node.fontSize });
        } else if (id !== figma.mixed) {
          const info = await styleInfo(id);
          if (info && !info.remote) note("localStyleText", { id: node.id, style: info.name });
        }
      }
      for (const field of ["fills", "strokes"]) {
        if (!(field in node)) continue;
        const paints = node[field];
        const styleId = field === "fills" ? node.fillStyleId : node.strokeStyleId;
        if (paints === figma.mixed || (styleId && styleId !== figma.mixed)) continue;
        paints.forEach((paint, index) => {
          if (paint.type !== "SOLID" || paint.visible === false || (paint.boundVariables && paint.boundVariables.color)) return;
          note(inInstance ? "instRawPaints" : "rawPaints", { id: node.id, name: node.name, type: node.type, field, index, hex: dsHex(paint.color), opacity: paint.opacity === undefined ? 1 : Math.round(paint.opacity * 100) / 100 });
        });
      }
      if (!inInstance && "effects" in node && node.effects.length && !node.effectStyleId) note("rawEffects", { id: node.id, name: node.name });
      if ("children" in node) for (const child of node.children) await visit(child, inInstance || node.type === "INSTANCE");
    };
    await visit(root, false);
    results.push(r);
  }
  return { results };
}

// Binds raw solid paints to the library colour variable with exactly the same colour.
// input.vars: [{ name, hex, a }]; input.prefer: name prefixes per role, in order.
async function dsAutoBind(input) {
  const prefer = Object.assign({ text: ["text/", "status/", "action/", "brand/"], fill: ["surface/", "action/", "status/", "brand/", "border/"], stroke: ["border/", "action/", "status/", "brand/"] }, input.prefer || {});
  const byColor = new Map();
  for (const item of input.vars) {
    const key = `${item.hex.toLowerCase()}@${Math.round((item.a === undefined ? 1 : item.a) * 100)}`;
    if (!byColor.has(key)) byColor.set(key, []);
    byColor.get(key).push(item.name);
  }
  const choose = (names, role) => {
    for (const prefix of prefer[role]) { const hit = names.find((name) => name.startsWith(prefix)); if (hit) return hit; }
    return names[0];
  };
  const bound = [];
  const unmatched = new Map();
  const visit = async (node, inInstance) => {
    if (node.visible === false && !input.includeHidden) return;
    if (!inInstance || input.includeInstances) {
      for (const field of ["fills", "strokes"]) {
        if (!(field in node)) continue;
        const paints = node[field];
        const styleId = field === "fills" ? node.fillStyleId : node.strokeStyleId;
        if (paints === figma.mixed || (styleId && styleId !== figma.mixed)) continue;
        let changed = false;
        const next = [];
        for (const paint of paints) {
          if (paint.type !== "SOLID" || paint.visible === false || (paint.boundVariables && paint.boundVariables.color)) { next.push(paint); continue; }
          // A bound variable supplies the alpha, so fold paint opacity into the match.
          const alpha = paint.opacity === undefined ? 1 : paint.opacity;
          const names = byColor.get(`${dsHex(paint.color)}@${Math.round(alpha * 100)}`);
          const role = field === "strokes" ? "stroke" : node.type === "TEXT" ? "text" : "fill";
          if (!names) { const key = `${role} ${dsHex(paint.color)}@${Math.round(alpha * 100)}`; unmatched.set(key, (unmatched.get(key) || 0) + 1); next.push(paint); continue; }
          const name = choose(names, role);
          const variable = await dsVar(name);
          next.push(figma.variables.setBoundVariableForPaint(Object.assign({}, paint, { opacity: 1 }), "color", variable));
          bound.push({ id: node.id, field, name });
          changed = true;
        }
        if (changed && !input.dryRun) node[field] = next;
      }
    }
    if ("children" in node) for (const child of node.children) await visit(child, inInstance || node.type === "INSTANCE");
  };
  for (const rootId of input.rootIds) await visit(await dsNode(rootId), false);
  const byVariable = {};
  for (const item of bound) byVariable[item.name] = (byVariable[item.name] || 0) + 1;
  return { bound: bound.length, byVariable, unmatched: Object.fromEntries(unmatched), dryRun: Boolean(input.dryRun) };
}

// Applies the library text style whose font, size and line height match an unstyled text layer.
// input.styles: [{ name, family, style, size, lh, ls }].
async function dsAutoTextStyles(input) {
  const applied = {};
  const unmatched = new Map();
  let count = 0;
  const pick = (node) => {
    if (node.fontName === figma.mixed || node.fontSize === figma.mixed || node.lineHeight === figma.mixed) return null;
    const lh = node.lineHeight.unit === "PIXELS" ? node.lineHeight.value : null;
    const ls = node.letterSpacing === figma.mixed ? null : node.letterSpacing.unit === "PIXELS" ? node.letterSpacing.value : node.letterSpacing.value * node.fontSize / 100;
    const candidates = input.styles.filter((style) => style.family === node.fontName.family && style.style === node.fontName.style && style.size === node.fontSize);
    const exact = candidates.filter((style) => lh !== null && Math.abs(style.lh - lh) < 0.5 && (ls === null || Math.abs((style.ls || 0) - ls) < 0.2));
    if (exact.length) return exact[0];
    if (input.loose && candidates.length) return candidates[0];
    return null;
  };
  const visit = async (node, inInstance) => {
    if (node.visible === false && !input.includeHidden) return;
    if (node.type === "TEXT" && (!inInstance || input.includeInstances) && !node.textStyleId) {
      const match = pick(node);
      if (!match) {
        const key = node.fontName === figma.mixed ? "mixed" : `${node.fontName.family} ${node.fontName.style} ${String(node.fontSize)}/${node.lineHeight === figma.mixed ? "mixed" : node.lineHeight.unit === "PIXELS" ? Math.round(node.lineHeight.value) : node.lineHeight.unit}`;
        unmatched.set(key, (unmatched.get(key) || []).concat(node.id).slice(0, 5));
      } else {
        if (!input.dryRun) {
          const style = await dsTextStyle(match.name);
          await dsFont(style.fontName);
          await dsLoadTextNodeFonts(node);
          await node.setTextStyleIdAsync(style.id);
        }
        applied[match.name] = (applied[match.name] || 0) + 1;
        count += 1;
      }
    }
    if ("children" in node) for (const child of node.children) await visit(child, inInstance || node.type === "INSTANCE");
  };
  for (const rootId of input.rootIds) await visit(await dsNode(rootId), false);
  return { applied: count, byStyle: applied, unmatched: Object.fromEntries(unmatched), dryRun: Boolean(input.dryRun) };
}

async function dsSetText(input) {
  const updated = [];
  for (const item of input.items) {
    const node = await dsNode(item.id);
    if (node.type !== "TEXT") throw new Error(`${item.id} is not a text layer.`);
    if (item.expect !== undefined && node.characters !== item.expect) throw new Error(`${item.id} changed: expected ${JSON.stringify(item.expect)}, found ${JSON.stringify(node.characters)}.`);
    await dsLoadTextNodeFonts(node);
    node.characters = item.text;
    updated.push({ id: node.id, text: node.characters.slice(0, 60) });
  }
  return { updated };
}

const DS_SEGMENT_FIELDS = ["fontName", "fontSize", "lineHeight", "letterSpacing", "textStyleId", "fills", "textDecoration", "hyperlink"];

function dsSegmentSummary(segment) {
  const fill = segment.fills && segment.fills[0];
  return {
    start: segment.start, end: segment.end, chars: segment.characters.slice(0, 40),
    font: `${segment.fontName.family} ${segment.fontName.style}`, size: segment.fontSize,
    lh: segment.lineHeight.unit === "PIXELS" ? segment.lineHeight.value : segment.lineHeight.unit,
    style: segment.textStyleId || null, decoration: segment.textDecoration,
    fill: fill ? (fill.boundVariables && fill.boundVariables.color ? `var:${fill.boundVariables.color.id}` : fill.type === "SOLID" ? dsHex(fill.color) : fill.type) : null,
    link: segment.hyperlink ? segment.hyperlink.value || segment.hyperlink.type : null,
  };
}

async function dsTextSegments(input) {
  const result = [];
  for (const id of input.ids) {
    const node = await dsNode(id);
    if (node.type !== "TEXT") throw new Error(`${id} is not a text layer.`);
    result.push({ id, characters: node.characters.slice(0, 200), segments: node.getStyledTextSegments(DS_SEGMENT_FIELDS).map(dsSegmentSummary) });
  }
  return { result };
}

// Applies library text styles to each unstyled run of mixed text. A run matches a style with the
// same family, weight and size (and line height when exact). Underlined runs take the style named
// in input.underlineStyles[styleName] when given, so links keep their decoration through a style.
async function dsStyleSegments(input) {
  const applied = {};
  const unmatched = [];
  const pick = (segment) => {
    const lh = segment.lineHeight.unit === "PIXELS" ? segment.lineHeight.value : null;
    const candidates = input.styles.filter((style) => style.family === segment.fontName.family && style.style === segment.fontName.style && style.size === segment.fontSize);
    const exact = candidates.find((style) => lh !== null && Math.abs(style.lh - lh) < 0.5);
    return exact || (input.loose ? candidates[0] : null);
  };
  const handle = async (node) => {
    const segments = node.getStyledTextSegments(DS_SEGMENT_FIELDS);
    if (!segments.some((segment) => !segment.textStyleId)) return;
    await dsLoadTextNodeFonts(node);
    for (const segment of segments) {
      if (segment.textStyleId) continue;
      let match = pick(segment);
      if (match && segment.textDecoration === "UNDERLINE" && input.underlineStyles) {
        const linkName = input.underlineStyles[match.name];
        match = linkName ? input.styles.find((style) => style.name === linkName) || null : null;
      }
      if (!match) { unmatched.push({ id: node.id, ...dsSegmentSummary(segment) }); continue; }
      if (!input.dryRun) {
        const style = await dsTextStyle(match.name);
        await dsFont(style.fontName);
        await node.setRangeTextStyleIdAsync(segment.start, segment.end, style.id);
        // Text styles do not carry colour, so the run keeps its (variable-bound) fills.
        if (segment.fills && segment.fills.length) node.setRangeFills(segment.start, segment.end, segment.fills);
      }
      applied[match.name] = (applied[match.name] || 0) + 1;
    }
  };
  const visit = async (node, inInstance) => {
    if (node.visible === false && !input.includeHidden) return;
    if (node.type === "TEXT" && (!inInstance || input.includeInstances)) await handle(node);
    if ("children" in node) for (const child of node.children) await visit(child, inInstance || node.type === "INSTANCE");
  };
  for (const id of input.ids || []) await handle(await dsNode(id));
  for (const id of input.rootIds || []) await visit(await dsNode(id), false);
  return { applied, unmatched: unmatched.slice(0, input.maxUnmatched || 40), unmatchedCount: unmatched.length, dryRun: Boolean(input.dryRun) };
}

// Replaces instances with a fresh instance of the same component set at the given variant,
// keeping the other variant values, text/boolean/swap properties, position and layout sizing.
// Used to undo scale-tool resizing that leaves fractional text sizes inside instances.
async function dsReplaceInstance(input) {
  const replaced = [];
  for (const item of input.items) {
    const old = await dsNode(item.id);
    if (old.type !== "INSTANCE") throw new Error(`${item.id} is not an instance.`);
    const main = await old.getMainComponentAsync();
    const set = main && main.parent && main.parent.type === "COMPONENT_SET" ? main.parent : null;
    const base = set ? set.defaultVariant : main;
    const fresh = base.createInstance();
    const parent = old.parent;
    parent.insertChild(parent.children.indexOf(old), fresh);
    const values = {};
    for (const [key, prop] of Object.entries(old.componentProperties)) {
      if (prop.type === "VARIANT") values[key] = prop.value;
      else if (prop.type === "INSTANCE_SWAP") { if (prop.value) values[key] = prop.value; }
      else values[key] = prop.value;
    }
    Object.assign(values, item.variant || {});
    fresh.setProperties(values);
    fresh.name = old.name;
    if (!dsIsAutoLayout(parent) || old.layoutPositioning === "ABSOLUTE") {
      fresh.x = old.x + (item.center ? Math.round((old.width - fresh.width) / 2) : 0);
      fresh.y = old.y + (item.center ? Math.round((old.height - fresh.height) / 2) : 0);
      if (old.layoutPositioning === "ABSOLUTE") fresh.layoutPositioning = "ABSOLUTE";
      fresh.constraints = old.constraints;
    }
    if ("layoutAlign" in old) fresh.layoutAlign = old.layoutAlign;
    if (old.visible === false) fresh.visible = false;
    const before = { w: Math.round(old.width), h: Math.round(old.height) };
    old.remove();
    replaced.push({ from: item.id, id: fresh.id, before, after: { w: Math.round(fresh.width), h: Math.round(fresh.height) } });
  }
  return { replaced };
}

async function dsRescale(input) {
  const result = [];
  for (const item of input.items) {
    const node = await dsNode(item.id);
    node.rescale(item.scale);
    result.push({ id: node.id, w: Math.round(node.width), h: Math.round(node.height) });
  }
  return { result };
}

function dsEffectSummary(effect) {
  const out = { type: effect.type, visible: effect.visible !== false };
  if (effect.color) { out.hex = dsHex(effect.color); out.opacity = Math.round(effect.color.a * 1000) / 1000; }
  if (effect.offset) { out.x = effect.offset.x; out.y = effect.offset.y; }
  if (effect.radius !== undefined) out.blur = effect.radius;
  if (effect.spread !== undefined) out.spread = effect.spread;
  return out;
}

// Effect styles with their effects: local ones, or library ones by name in an importing file.
async function dsReadEffectStyles(input) {
  const local = await figma.getLocalEffectStylesAsync();
  const styles = local.length ? local : (await Promise.all((input.names || []).map((name) => dsEffectStyle(name)))).filter(Boolean);
  return { styles: styles.map((style) => ({ name: style.name, description: style.description, effects: style.effects.map(dsEffectSummary) })) };
}

// Describes every component set and standalone component (variables, styles, layout and
// nested parts per variant) so the app's CSS can be checked against the library.
// Bounded: an optional page filter plus time and component budgets, yielding between
// components, so a run in a large screens file stops early instead of freezing Figma.
async function dsComponentSpec(input) {
  const pageFilter = Array.isArray(input.pages) && input.pages.length ? new Set(input.pages) : null;
  const maxMs = Math.min(Math.max(Number(input.maxMs) || 60000, 1000), 170000);
  const maxComponents = Math.min(Math.max(Number(input.maxComponents) || 400, 1), 2000);
  const started = Date.now();
  const names = new Map();
  const nameOf = async (id, kind) => {
    if (!id || id === figma.mixed) return id === figma.mixed ? "mixed" : null;
    if (!names.has(id)) {
      const item = kind === "var" ? await figma.variables.getVariableByIdAsync(id) : await figma.getStyleByIdAsync(id);
      names.set(id, item ? item.name : id);
    }
    return names.get(id);
  };
  const paints = async (list) => {
    if (!list || list === figma.mixed) return list === figma.mixed ? ["mixed"] : [];
    const out = [];
    for (const paint of list) {
      if (paint.visible === false) continue;
      if (paint.type === "SOLID") out.push(paint.boundVariables && paint.boundVariables.color ? await nameOf(paint.boundVariables.color.id, "var") : `${dsHex(paint.color)}${paint.opacity !== undefined && paint.opacity < 1 ? `@${Math.round(paint.opacity * 100)}%` : ""}`);
      else out.push(paint.type);
    }
    return out;
  };
  const bound = async (node, field) => {
    const alias = node.boundVariables && node.boundVariables[field];
    return alias && !Array.isArray(alias) ? nameOf(alias.id, "var") : null;
  };
  const describe = async (node) => {
    const d = { w: Math.round(node.width), h: Math.round(node.height) };
    if ("layoutMode" in node && node.layoutMode !== "NONE") {
      d.layout = node.layoutMode === "HORIZONTAL" ? "row" : "column";
      d.padding = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft];
      d.gap = (await bound(node, "itemSpacing")) || node.itemSpacing;
      d.align = `${node.primaryAxisAlignItems}/${node.counterAxisAlignItems}`;
      d.sizing = `${node.primaryAxisSizingMode}/${node.counterAxisSizingMode}`;
    }
    if ("cornerRadius" in node) d.radius = (await bound(node, "topLeftRadius")) || (node.cornerRadius === figma.mixed ? [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius] : node.cornerRadius);
    if ("fills" in node) { const f = await paints(node.fills); if (f.length) d.fill = f; }
    if ("strokes" in node) { const s = await paints(node.strokes); if (s.length) { d.stroke = s; d.strokeWeight = node.strokeWeight === figma.mixed ? [node.strokeTopWeight, node.strokeRightWeight, node.strokeBottomWeight, node.strokeLeftWeight] : node.strokeWeight; } }
    if ("effectStyleId" in node && node.effectStyleId) d.effect = await nameOf(node.effectStyleId, "style");
    else if ("effects" in node && node.effects.length) d.effects = node.effects.filter((e) => e.visible !== false).map(dsEffectSummary);
    if (node.opacity !== undefined && node.opacity < 1) d.opacity = Math.round(node.opacity * 100) / 100;
    const parts = [];
    const walk = async (parent, depth) => {
      for (const child of parent.children || []) {
        if (child.visible === false) continue;
        if (child.type === "TEXT") {
          parts.push({ layer: child.name, text: child.characters.slice(0, 40), style: await nameOf(child.textStyleId, "style"), color: (await paints(child.fills))[0] || null });
        } else if (child.type === "INSTANCE") {
          const main = await child.getMainComponentAsync();
          parts.push({ layer: child.name, component: main ? (main.parent && main.parent.type === "COMPONENT_SET" ? `${main.parent.name} (${main.name})` : main.name) : null, w: Math.round(child.width), h: Math.round(child.height) });
        } else if (depth < 3) {
          const part = { layer: child.name, type: child.type, w: Math.round(child.width), h: Math.round(child.height) };
          if ("fills" in child) { const f = await paints(child.fills); if (f.length) part.fill = f; }
          if ("strokes" in child) { const s = await paints(child.strokes); if (s.length) part.stroke = s; }
          if ("cornerRadius" in child && child.cornerRadius) part.radius = (await bound(child, "topLeftRadius")) || child.cornerRadius;
          if ("layoutMode" in child && child.layoutMode !== "NONE") { part.padding = [child.paddingTop, child.paddingRight, child.paddingBottom, child.paddingLeft]; part.gap = child.itemSpacing; }
          if ("effectStyleId" in child && child.effectStyleId) part.effect = await nameOf(child.effectStyleId, "style");
          else if ("effects" in child && child.effects.length) part.effects = child.effects.filter((e) => e.visible !== false).map(dsEffectSummary);
          if (part.fill || part.stroke || part.padding || part.effect || part.effects) parts.push(part);
          if ("children" in child) await walk(child, depth + 1);
        }
      }
    };
    await walk(node, 0);
    if (parts.length) d.parts = parts;
    return d;
  };
  const out = [];
  let truncated = null;
  pages: for (const page of figma.root.children) {
    if (pageFilter && !pageFilter.has(page.name) && !pageFilter.has(page.id)) continue;
    if (Date.now() - started > maxMs) { truncated = `Stopped after ${maxMs} ms, before page "${page.name}".`; break; }
    await page.loadAsync();
    for (const node of page.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] })) {
      if (node.type === "COMPONENT" && node.parent && node.parent.type === "COMPONENT_SET") continue;
      if (input.skip && new RegExp(input.skip).test(node.name)) continue;
      if (out.length >= maxComponents) { truncated = `Stopped at ${maxComponents} components, on page "${page.name}".`; break pages; }
      if (Date.now() - started > maxMs) { truncated = `Stopped after ${maxMs} ms, on page "${page.name}".`; break pages; }
      const entry = { name: node.name, page: page.name, description: node.description || "" };
      const defs = node.componentPropertyDefinitions || {};
      entry.properties = Object.fromEntries(Object.entries(defs).map(([key, def]) => [key.split("#")[0], def.type === "VARIANT" ? def.variantOptions : def.type]));
      const variants = node.type === "COMPONENT_SET" ? node.children : [node];
      entry.variants = [];
      for (const variant of variants) entry.variants.push(Object.assign({ name: variant.name }, await describe(variant)));
      out.push(entry);
      if (out.length % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return truncated ? { components: out, truncated } : { components: out };
}

// Sets text with styled runs: base style/fill for the whole layer, then runs located by
// `match` (first occurrence) or start/end, each with a text style, fill variable and underline.
async function dsSetRich(input) {
  const updated = [];
  for (const item of input.items) {
    const node = await dsNode(item.id);
    if (node.type !== "TEXT") throw new Error(`${item.id} is not a text layer.`);
    await dsLoadTextNodeFonts(node);
    if (item.text !== undefined) node.characters = item.text;
    const length = node.characters.length;
    if (item.style) { const style = await dsTextStyle(item.style); await dsFont(style.fontName); await node.setRangeTextStyleIdAsync(0, length, style.id); }
    // Clear first: binding a colour variable over another bound fill can render black.
    if (item.fill) { const paints = await dsPaints(item.fill); node.setRangeFills(0, length, []); node.setRangeFills(0, length, paints); }
    if (item.style || item.fill) node.setRangeTextDecoration(0, length, "NONE");
    for (const run of item.runs || []) {
      const start = run.start !== undefined ? run.start : node.characters.indexOf(run.match);
      if (start < 0) throw new Error(`"${run.match}" was not found in ${item.id}.`);
      const end = run.end !== undefined ? run.end : start + run.match.length;
      if (run.style) { const style = await dsTextStyle(run.style); await dsFont(style.fontName); await node.setRangeTextStyleIdAsync(start, end, style.id); }
      if (run.fill) { const paints = await dsPaints(run.fill); node.setRangeFills(start, end, []); node.setRangeFills(start, end, paints); }
      // from: copy a source text layer's (possibly library-bound) text style and fills.
      if (run.from) {
        const source = await dsNode(run.from);
        if (source.type !== "TEXT") throw new Error(`${run.from} is not a text layer.`);
        if (typeof source.textStyleId === "string" && source.textStyleId) await node.setRangeTextStyleIdAsync(start, end, source.textStyleId);
        if (Array.isArray(source.fills)) { node.setRangeFills(start, end, []); node.setRangeFills(start, end, source.fills); }
      }
      if (run.underline !== undefined) node.setRangeTextDecoration(start, end, run.underline ? "UNDERLINE" : "NONE");
      // link: a node id (frame) or an https URL.
      if (run.link) node.setRangeHyperlink(start, end, /^https?:/.test(run.link) ? { type: "URL", value: run.link } : { type: "NODE", value: run.link });
    }
    updated.push({ id: node.id, text: node.characters.slice(0, 60) });
  }
  return { updated };
}

async function dsSetFields(input) {
  const result = [];
  for (const item of input.items) {
    const node = await dsNode(item.id);
    // Text layout fields can only be written once the layer's fonts are loaded.
    if (node.type === "TEXT") await loadCurrentTextFonts(node);
    for (const [field, value] of Object.entries(item.fields)) {
      if (field === "effectStyle") {
        const style = await dsEffectStyle(value);
        if (!style) throw new Error(`Unknown effect style "${value}".`);
        await node.setEffectStyleIdAsync(style.id);
      } else if (field === "size") {
        node.resize(value[0], value[1]);
      } else if (field === "fills" || field === "strokes") {
        // [] clears; a token name binds that colour variable.
        // Clear first: assigning a bound paint over another bound paint can render black.
        const paints = Array.isArray(value) && value.length === 0 ? [] : await dsPaints(value);
        node[field] = [];
        node[field] = paints;
      } else if (field === "effects") {
        if (!(Array.isArray(value) && value.length === 0)) throw new Error('Only "effects": [] is supported; use effectStyle for styles.');
        if (node.effectStyleId) await node.setEffectStyleIdAsync("");
        node.effects = [];
      } else if (field === "letterSpacingPercent") {
        node.letterSpacing = { unit: "PERCENT", value };
      } else if (field === "constraints" || field === "maxLines" || field === "textTruncation") {
        node[field] = value;
      } else if (DS_SETTABLE_FIELDS.has(field)) {
        if (value && typeof value === "object") await dsNumber(node, field, value);
        else node[field] = value;
      } else throw new Error(`Field "${field}" cannot be set.`);
    }
    result.push({ id: node.id, name: node.name });
  }
  return { updated: result };
}

async function executeDesignSystem(name, input) {
  if (name === "dsFitSection") return dsFitSection(input);
  if (name === "dsAuditInstances") return dsAuditInstances(input);
  if (name === "dsReplaceFont") return dsReplaceFont(input);
  if (name === "dsDeleteStyles") return dsDeleteStyles(input);
  if (name === "dsReadGlyphs") return dsReadGlyphs(input);
  if (name === "dsRecolorGlyphs") return dsRecolorGlyphs(input);
  if (name === "dsColorVars") return dsColorVars(input);
  if (name === "dsPing") return { ok: true, version: DS_VERSION, page: { id: figma.currentPage.id, name: figma.currentPage.name }, indexedComponents: dsState.components.size };
  if (name === "dsRender") return dsRender(input);
  if (name === "dsIndex") return dsIndex(input);
  if (name === "dsTextStyles") return dsTextStyles(input);
  if (name === "dsEffectStyles") return dsEffectStyles(input);
  if (name === "dsNumberVars") return dsNumberVars(input);
  if (name === "dsPages") return dsPages(input);
  if (name === "dsMove") return dsMove(input);
  if (name === "dsDelete") return dsDelete(input);
  if (name === "dsInspect") return dsInspect(input);
  if (name === "dsSetProps") return dsSetProps(input);
  if (name === "dsSetVisible") return dsSetVisible(input);
  if (name === "dsRename") return dsRename(input);
  if (name === "dsAddVariant") return dsAddVariant(input);
  if (name === "dsMakeSet") return dsMakeSet(input);
  if (name === "dsSwap") return dsSwap(input);
  if (name === "dsSetFields") return dsSetFields(input);
  if (name === "dsClone") return dsClone(input);
  if (name === "dsFind") return dsFind(input);
  if (name === "dsLinksTo") return dsLinksTo(input);
  if (name === "dsRepointLinks") return dsRepointLinks(input);
  if (name === "dsParents") return dsParents(input);
  if (name === "dsSectionSize") return dsSectionSize(input);
  if (name === "dsImageInfo") return dsImageInfo(input);
  if (name === "dsImages") return dsImages(input);
  if (name === "dsShiftBelow") return dsShiftBelow(input);
  if (name === "dsUsage") return dsUsage(input);
  if (name === "dsLibAudit") return dsLibAudit(input);
  if (name === "dsContrastScan") return dsContrastScan(input);
  if (name === "dsStaleFills") return dsStaleFills(input);
  if (name === "dsVarModes") return dsVarModes(input);
  if (name === "dsCollectionKeys") return dsCollectionKeys(input);
  if (name === "dsSwapVars") return dsSwapVars(input);
  if (name === "dsRemoveCollection") return dsRemoveCollection(input);
  if (name === "dsModeCollection") return dsModeCollection(input);
  if (name === "dsSetMode") return dsSetMode(input);
  if (name === "dsThemeWalk") return dsThemeWalk(input);
  if (name === "dsStaleVars") return dsStaleVars(input);
  if (name === "dsRebindStale") return dsRebindStale(input);
  if (name === "dsInspectLayout") return dsInspectLayout(input);
  if (name === "dsSetReactions") return dsSetReactions(input);
  if (name === "dsFlowStarts") return dsFlowStarts(input);
  if (name === "dsLibRegister") return dsLibRegister(input);
  if (name === "dsAuditDS") return dsAuditDS(input);
  if (name === "dsAutoBind") return dsAutoBind(input);
  if (name === "dsAutoTextStyles") return dsAutoTextStyles(input);
  if (name === "dsSetText") return dsSetText(input);
  if (name === "dsTextSegments") return dsTextSegments(input);
  if (name === "dsStyleSegments") return dsStyleSegments(input);
  if (name === "dsReplaceInstance") return dsReplaceInstance(input);
  if (name === "dsRescale") return dsRescale(input);
  if (name === "dsReadEffectStyles") return dsReadEffectStyles(input);
  if (name === "dsComponentSpec") return dsComponentSpec(input);
  if (name === "dsSetRich") return dsSetRich(input);
  if (name === "dsAddProps") return dsAddProps(input);
  if (name === "dsRemoveProps") return dsRemoveProps(input);
  if (name === "dsRenameFile") {
    try {
      figma.root.name = input.name;
      return { ok: true, name: figma.root.name };
    } catch (error) {
      return { ok: false, error: errorMessage(error), name: figma.root.name };
    }
  }
  if (name === "dsSetThumbnail") {
    await figma.setFileThumbnailNodeAsync(await dsNode(input.nodeId));
    return { ok: true };
  }
  if (name === "dsSetCurrentPage") {
    const page = await dsNode(input.pageId);
    await figma.setCurrentPageAsync(page);
    return { ok: true, page: { id: page.id, name: page.name } };
  }
  throw new Error(`Unsupported design-system command: ${name}`);
}
// ===== End design-system extension =====
