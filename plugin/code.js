figma.showUI(__html__, { width: 380, height: 250, title: "Local MCP Bridge" });

let bridgeGeneration = 0;
const bridgeUrl = "http://localhost:3846";
const pluginVersion = "0.13.3";
const bridgeClientId = `figma-client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const mutatingCommands = new Set([
  "moveResizeReparent", "updateText", "setTextCase", "deleteNode", "duplicateNode",
  "createSection", "createFrame", "createText", "createRectangle", "createEllipse",
  "importSvg", "styleNode", "createColorTokens", "setAutoLayout",
  "applyCopyUpdates", "setTextFrame", "splitTextBlock",
  "archiveNodes", "composeFrame", "copyStyleFromNode", "copyImageFill", "placeLocalImage",
  "createComponentInstance", "applyDesignStyle",
  "dsRender", "dsTextStyles", "dsEffectStyles", "dsNumberVars", "dsPages", "dsMove", "dsDelete", "dsRenameFile", "dsSetThumbnail",
  "dsColorVars", "dsDeleteStyles", "dsRecolorGlyphs", "dsReplaceFont", "dsFitSection",
  "dsSetProps", "dsSetVisible", "dsRename", "dsAddVariant", "dsMakeSet", "dsSwap", "dsSetFields",
]);

function bridgeStatus(message, kind = "") {
  figma.ui.postMessage({ type: "bridge-status", message, kind });
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

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object") {
    if (typeof error.message === "string") return error.message;
    try { return JSON.stringify(error); } catch { return "Unknown local connection error"; }
  }
  return String(error);
}

async function bridgeRequest(path, options = {}) {
  const response = await fetch(`${bridgeUrl}${path}`, options);
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `Bridge returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function bridgeContext() {
  return {
    pluginVersion,
    editorType: figma.editorType,
    pageId: figma.currentPage.id,
    pageName: figma.currentPage.name,
    fileKey: typeof figma.fileKey === "string" ? figma.fileKey : undefined,
    selectionCount: figma.currentPage.selection.length,
  };
}

function pollQuery(sessionId) {
  const context = bridgeContext();
  const params = {
    sessionId,
    pageId: context.pageId,
    pageName: context.pageName,
    selectionCount: String(context.selectionCount),
  };
  return `?${Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&")}`;
}

function isReplacementError(error) {
  return error?.status === 409 && /replaced|newer figma plugin/i.test(errorMessage(error));
}

async function postHeartbeat(sessionId) {
  return bridgeRequest("/v1/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, info: bridgeContext() }),
  });
}

async function executeWithHeartbeat(sessionId, command) {
  let heartbeatError = null;
  const heartbeat = () => postHeartbeat(sessionId).catch((error) => { heartbeatError = error; });
  await heartbeat();
  const timer = setInterval(heartbeat, 10_000);
  try {
    const result = await execute(command.name, command.input);
    if (isReplacementError(heartbeatError)) throw heartbeatError;
    return result;
  } finally {
    clearInterval(timer);
  }
}

async function startBridge() {
  const generation = ++bridgeGeneration;
  while (generation === bridgeGeneration) {
    try {
      const sessionId = `figma-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      bridgeStatus("Connecting…");
      await bridgeRequest("/v1/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, clientId: bridgeClientId, info: bridgeContext() }),
      });
      figma.ui.postMessage({ type: "bridge-session", sessionId, clientId: bridgeClientId, bridgeUrl });
      bridgeStatus(`Connected to local MCP bridge on “${figma.currentPage.name}”. Keep this plugin open.`, "connected");
      while (generation === bridgeGeneration) {
        const message = await bridgeRequest(`/v1/poll${pollQuery(sessionId)}`);
        if (!message?.command || generation !== bridgeGeneration) continue;
        let result;
        bridgeActivity(message.command, "start");
        try {
          result = await executeWithHeartbeat(sessionId, message.command);
          if (mutatingCommands.has(message.command.name)) figma.commitUndo();
        } catch (error) {
          if (isReplacementError(error)) throw error;
          await bridgeRequest("/v1/result", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId, id: message.command.id, ok: false, error: errorMessage(error), info: bridgeContext() }),
          });
          bridgeActivity(message.command, "finish", false, error);
          continue;
        }
        await bridgeRequest("/v1/result", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, id: message.command.id, ok: true, result, info: bridgeContext() }),
        });
        bridgeActivity(message.command, "finish", true);
      }
    } catch (error) {
      if (generation !== bridgeGeneration) return;
      if (isReplacementError(error)) {
        bridgeStatus("Disconnected because another Figma file took over this bridge. Reload this plugin to reconnect here.", "waiting");
        return;
      }
      bridgeStatus(`Waiting for Codex bridge… (${errorMessage(error)})`, "waiting");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
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
      await figma.loadFontAsync(font);
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

async function applyCopyUpdates(input) {
  const updateResult = await applyTextUpdates(input.updates);
  const audits = [];
  for (const frameId of input.auditFrames) {
    try {
      audits.push({ frameId, result: await auditTextOverflow(sceneNode(frameId), { includeHidden: input.includeHidden }) });
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
    verificationComplete: audits.every((item) => !item.error) && exports.every((item) => !item.error),
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

function textContent(root) {
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

async function auditTextOverflow(root, options = {}) {
  if (!("findAllWithCriteria" in root)) throw new Error("The target node cannot contain text descendants.");
  const rootBounds = root.absoluteBoundingBox;
  const allTexts = textNodesInReadingOrder(root);
  const texts = options.includeHidden ? allTexts : allTexts.filter((node) => visibilityInfo(root, node).effectiveVisible);
  const results = [];
  for (const node of texts) {
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
    results.push({
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
    });
  }
  return {
    frame: serializeNode(root),
    includeHidden: options.includeHidden === true,
    textCount: results.length,
    skippedHiddenTextCount: allTexts.length - texts.length,
    warningCount: results.reduce((count, item) => count + item.warnings.length, 0),
    visibleWarningCount: results.filter((item) => item.effectiveVisible).reduce((count, item) => count + item.warnings.length, 0),
    text: results,
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

function pageNode(nodeId) {
  if (!nodeId) return figma.currentPage;
  const node = figma.currentPage.findOne((candidate) => candidate.id === nodeId);
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
      await figma.loadFontAsync(font);
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

async function composeFrame(input) {
  const keys = new Set();
  for (const element of input.elements) {
    if (keys.has(element.key)) throw new Error(`Duplicate compose element key “${element.key}”.`);
    if (element.parentKey && !keys.has(element.parentKey)) throw new Error(`Element “${element.key}” refers to parentKey “${element.parentKey}” before that parent is created.`);
    keys.add(element.key);
  }
  const preparedArchive = input.archiveNodeIds.length ? validateArchiveNodes(input.archiveNodeIds) : null;
  const root = figma.createFrame();
  const created = [root];
  const byKey = new Map();
  try {
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

    for (const element of input.elements) {
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
      created.push(node);
      byKey.set(element.key, node);
    }

    if (created.length !== input.elements.length + 1 || byKey.size !== input.elements.length) {
      throw new Error(`Composition created ${created.length - 1} of ${input.elements.length} requested native elements.`);
    }

    const audits = input.audit ? [{ frameId: root.id, result: auditSummary(await auditTextOverflow(root, { includeHidden: false })) }] : [];
    const exports = input.export ? [{ frameId: root.id, result: { ...(await screenshotNode(root, input)), nodeName: root.name } }] : [];
    focus(root);
    const result = {
      ok: true,
      createdNodeIds: created.map((node) => node.id),
      frame: serializeNode(root),
      elements: [...byKey].map(([key, node]) => ({ key, id: node.id, name: node.name, type: node.type })),
      placement,
      audits,
      exports,
      verificationComplete: audits.every((item) => !item.error) && exports.every((item) => !item.error),
    };
    if (preparedArchive) {
      const archived = archiveNodes({ nodeIds: input.archiveNodeIds, replacementNodeId: root.id, archiveName: input.archiveName, reason: input.archiveReason }, { ...preparedArchive, replacement: root });
      result.archived = archived.archive;
    }
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
    textStyles: textStyles.slice(0, input.limit).map((style) => ({ id: style.id, name: style.name, fontName: style.fontName, fontSize: style.fontSize, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing })),
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
    componentProperties: cloneValue(component.componentPropertyDefinitions ?? {}),
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
    component = await figma.importComponentByKeyAsync(input.componentKey);
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
  const style = input.styleId ? await figma.getStyleByIdAsync(input.styleId) : await figma.importStyleByKeyAsync(input.styleKey);
  if (!style) throw new Error("The requested Figma style was not found.");
  const targets = input.targetNodeIds.map(sceneNode);
  const styleTypes = { fill: "PAINT", stroke: "PAINT", effect: "EFFECT", text: "TEXT" };
  const methods = { fill: "setFillStyleIdAsync", stroke: "setStrokeStyleIdAsync", effect: "setEffectStyleIdAsync", text: "setTextStyleIdAsync" };
  const method = methods[input.aspect];
  if (!method || style.type !== styleTypes[input.aspect]) throw new Error(`The requested style is incompatible with aspect ${input.aspect}.`);
  for (const target of targets) {
    if (typeof target[method] !== "function" || (input.aspect === "text" && target.type !== "TEXT")) throw new Error(`Node ${target.id} cannot accept a ${input.aspect} style.`);
  }
  if (input.aspect === "text") {
    for (const target of targets) await loadCurrentTextFonts(target);
    await figma.loadFontAsync(style.fontName);
  }
  for (let index = 0; index < targets.length; index++) {
    try { await targets[index][method](style.id); }
    catch (_) { return partialStyleResult(targets, index, true); }
  }
  try {
    if (targets.length) figma.viewport.scrollAndZoomIntoView(targets);
    return { style: styleSummary(style), aspect: input.aspect, mutatedNodeIds: targets.map((target) => target.id), targets: targets.map(serializeNode) };
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

function copyImageFill(input) {
  const source = sceneNode(input.sourceNodeId);
  const target = sceneNode(input.targetNodeId);
  if (!("fills" in target)) throw new Error("Target node cannot accept image fills.");
  const paint = cloneValue(imageFill(source));
  if (input.scaleMode) paint.scaleMode = input.scaleMode;
  if (input.imageTransform) {
    paint.scaleMode = "CROP";
    paint.imageTransform = input.imageTransform;
  } else if (paint.scaleMode !== "CROP") {
    delete paint.imageTransform;
  }
  target.fills = [paint];
  focus(target);
  return { sourceNodeId: source.id, mutatedNodeIds: [target.id], target: serializeNode(target), image: { scaleMode: paint.scaleMode, imageTransform: paint.imageTransform ?? null } };
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

async function execute(name, input) {
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
    return input.detail === "full" ? textContent(root) : compactCopy(root, input.includeHidden);
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
    const frames = input.nodeIds.map((id) => input.detail === "full" ? textContent(sceneNode(id)) : compactCopy(sceneNode(id), input.includeHidden));
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
    const frames = roots.map((root) => input.detail === "full" ? textContent(root) : compactCopy(root, false));
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
        const audit = await auditTextOverflow(root, { includeHidden: false });
        overflowAudits.push(input.detail === "full" ? audit : auditSummary(audit));
      }
    }
    return { content, overflowAudits };
  }

  if (name === "auditTextOverflow") {
    const audit = await auditTextOverflow(sceneNode(input.nodeId), { includeHidden: input.includeHidden });
    return input.detail === "full" ? audit : auditSummary(audit);
  }

  if (name === "applyCopyUpdates") return applyCopyUpdates(input);

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
    if (input.width !== undefined || input.height !== undefined) node.resize(input.width ?? node.width, input.height ?? node.height);
    if (input.x !== undefined) node.x = input.x;
    if (input.y !== undefined) node.y = input.y;
    focus(node);
    return { mutatedNodeIds: [node.id], node: serializeNode(node) };
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

  if (name === "composeFrame") return composeFrame(input);

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

figma.ui.onmessage = async (message) => {
  if (message.type === "start") startBridge();
  if (message.type === "resize" && [250, 540].includes(message.height)) figma.ui.resize(380, message.height);
};

// ===== Design-system extension (branch claude/design-system-commands) =====
// Declarative ds* commands only: every command takes JSON specs; nothing is evaluated as code.
// They create/index components, component sets, text/effect styles, number variables,
// pages and auto-layout node trees, so a design system can be built over the local bridge.
const DS_VERSION = "ds-19";
const dsState = { vars: null, textStyles: null, effectStyles: null, components: new Map(), fonts: new Set() };

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
    const style = (await dsEffectStyleMap()).get(spec.effect);
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
    style = (await dsTextStyleMap()).get(spec.style);
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
      const spanStyle = (await dsTextStyleMap()).get(span.style);
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
  "clipsContent", "opacity", "minWidth", "maxWidth", "minHeight", "maxHeight", "itemReverseZIndex", "textAutoResize",
]);

// Sets whitelisted layout and geometry fields; {var: "space/8"} binds a number variable,
// "effectStyle" applies a named effect style and "size" resizes.
async function dsSetFields(input) {
  const result = [];
  for (const item of input.items) {
    const node = await dsNode(item.id);
    for (const [field, value] of Object.entries(item.fields)) {
      if (field === "effectStyle") {
        const style = (await dsEffectStyleMap()).get(value);
        if (!style) throw new Error(`Unknown effect style "${value}".`);
        await node.setEffectStyleIdAsync(style.id);
      } else if (field === "size") {
        node.resize(value[0], value[1]);
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
