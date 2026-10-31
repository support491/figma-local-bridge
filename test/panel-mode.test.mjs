import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../plugin/code.js", import.meta.url), "utf8");
function loadPanel(clientStorage) {
  const sizes = [], messages = [];
  const figma = { showUI() {}, clientStorage, ui: { resize: (...size) => sizes.push(size), postMessage: (message) => messages.push(message) } };
  const context = vm.createContext({ figma, __html__: "" });
  vm.runInContext(`${source}\nglobalThis.panel = { restorePanelView, setPanelView, resizeBridgePanel, settle: () => panelSaveQueue };`, context);
  return { ...context.panel, sizes, messages };
}

test("panel restores a local expanded preference without connection or document writes", async () => {
  const panel = loadPanel({ getAsync: async (key) => { assert.equal(key, "figma_local_bridge.panel_compact.v1"); return false; } });
  await panel.restorePanelView();
  assert.deepEqual(panel.sizes, [[420, 360]]);
  assert.equal(panel.messages[0].type, "bridge-view");
  assert.equal(panel.messages[0].compact, false);
});

test("late preference loading cannot override a fresh toggle", async () => {
  let resolve;
  const values = [];
  const panel = loadPanel({ getAsync: () => new Promise((done) => { resolve = done; }), setAsync: async (_, value) => values.push(value) });
  const restore = panel.restorePanelView();
  panel.setPanelView({ compact: false, height: 760 });
  resolve(true);
  await restore;
  await panel.settle();
  assert.deepEqual(panel.sizes, [[420, 760]]);
  assert.deepEqual(values, [false]);
  assert.equal(panel.messages.length, 0);
});

test("rapid toggles persist in order and compact mode ignores expanded resize requests", async () => {
  const values = [];
  const panel = loadPanel({ setAsync: async (_, value) => { await Promise.resolve(); values.push(value); } });
  panel.setPanelView({ compact: false, height: 760 });
  panel.setPanelView({ compact: true });
  panel.resizeBridgePanel(900);
  panel.setPanelView({ compact: "false", height: 1 });
  await panel.settle();
  assert.deepEqual(values, [false, true]);
  assert.deepEqual(panel.sizes, [[420, 760], [360, 190], [360, 190]]);
});

test("storage failure keeps panel usable and malformed sizes stay bounded", async () => {
  const panel = loadPanel({ getAsync: async () => { throw Error("unavailable"); }, setAsync: async () => { throw Error("unavailable"); } });
  await panel.restorePanelView();
  assert.equal(panel.messages[0].compact, true);
  panel.setPanelView({ compact: false, height: 100000 });
  panel.resizeBridgePanel(-1);
  panel.resizeBridgePanel(400.5);
  await panel.settle();
  assert.deepEqual(panel.sizes, [[360, 190], [420, 360]]);
});
