import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../plugin/code.js", import.meta.url), "utf8");
function fixture() {
  const messages = [], events = {}, copies = [];
  const page = { id: "page-a", name: "Campaign", type: "PAGE", selection: [] };
  let undoPoints = 0;
  const figma = {
    showUI() {}, root: { name: "Marketing" }, currentPage: page,
    ui: { postMessage(message) { messages.push(message); } },
    on(event, callback) { events[event] = callback; },
    commitUndo() { undoPoints++; }, viewport: { scrollAndZoomIntoView() {} },
  };
  const context = vm.createContext({ figma, __html__: "" });
  vm.runInContext(`${source}\nglobalThis.staffTest = { copyStaffSelection, publishStaffContext, pollQuery, ready() { bridgePhase = "connected"; bridgeSessionId = "session"; }, busy(value) { bridgeCommandInFlight = value; } };`, context);
  function node(id, x, fail = false) {
    return { id, name: id, type: "FRAME", x, y: 50, width: 200, parent: page,
      clone() {
        if (fail) throw new Error("Copy rejected");
        const copy = { ...this, id: `${id}-copy`, remove() { this.removed = true; } };
        copies.push(copy); return copy;
      },
    };
  }
  page.selection = [node("banner", 10), node("square", 300)];
  return { ...context.staffTest, figma, page, copies, messages, events, node, undo: () => undoPoints,
    request: () => ({ type: "staff-copy-selection", pageId: page.id, nodeIds: page.selection.map((node) => node.id) }),
  };
}
const plain = (value) => JSON.parse(JSON.stringify(value));

test("staff copies keep source designs unchanged and create a distinct undo step and selected scope", () => {
  const f = fixture(); f.ready();
  const originals = [...f.page.selection];
  const result = f.copyStaffSelection(f.request());
  assert.deepEqual(originals.map((node) => [node.name, node.x, node.y]), [["banner", 10, 50], ["square", 300, 50]]);
  assert.deepEqual(f.copies.map((node) => [node.name, node.x, node.y]), [["banner — Working copy", 580, 50], ["square — Working copy", 870, 50]]);
  assert.deepEqual(plain(result.createdNodes.map((node) => node.id)), ["banner-copy", "square-copy"]);
  assert.deepEqual(plain(f.page.selection.map((node) => node.id)), ["banner-copy", "square-copy"]);
  assert.deepEqual(plain(f.messages.at(-1).workingCopyIds), ["banner-copy", "square-copy"]);
  assert.equal(f.undo(), 2);
});

test("staff copy refuses stale page/selection, disconnected or busy state before any mutation", () => {
  const f = fixture();
  assert.throws(() => f.copyStaffSelection(f.request()), /connection is ready/);
  f.ready(); f.busy(true);
  assert.throws(() => f.copyStaffSelection(f.request()), /task has finished/);
  f.busy(false);
  assert.throws(() => f.copyStaffSelection({ ...f.request(), pageId: "other" }), /selection changed/);
  assert.throws(() => f.copyStaffSelection({ ...f.request(), nodeIds: ["other", "square"] }), /selection changed/);
  assert.equal(f.copies.length, 0);
  assert.equal(f.undo(), 0);
});

test("copying nested layers cannot change the original auto layout; empty and large selections are explained", () => {
  const f = fixture(); f.ready();
  f.page.selection[0].parent = { type: "FRAME", layoutMode: "HORIZONTAL" };
  assert.throws(() => f.copyStaffSelection(f.request()), /whole artboards or sections/);
  f.page.selection = [];
  assert.throws(() => f.copyStaffSelection(f.request()), /Select one or more/);
  f.page.selection = Array.from({ length: 21 }, (_, i) => f.node(String(i), i * 200));
  assert.throws(() => f.copyStaffSelection(f.request()), /no more than 20/);
  assert.equal(f.copies.length, 0);
});

test("a failed multi-design copy removes created copies and restores the original selection", async () => {
  const f = fixture(); f.ready();
  f.page.selection.push(f.node("broken", 600, true));
  const originals = [...f.page.selection];
  await f.figma.ui.onmessage(f.request());
  assert.ok(f.copies.every((copy) => copy.removed));
  assert.equal(f.page.selection.length, originals.length);
  assert.ok(originals.every((node, index) => f.page.selection[index] === node));
  assert.match(f.messages.find((message) => message.type === "staff-error").error, /No working copy was kept/);
  assert.deepEqual(plain(f.messages.at(-1).workingCopyIds), []);
  assert.ok(!f.messages.some((message) => message.type === "staff-copy-result"));
});

test("page or selection changes invalidate working-copy prompts and publish the fresh context", () => {
  const f = fixture(); f.ready(); f.copyStaffSelection(f.request());
  f.page.selection = [f.node("original", 0)];
  f.events.selectionchange();
  assert.deepEqual(plain(f.messages.at(-1).workingCopyIds), []);
  assert.equal(f.messages.at(-1).selection[0].id, "original");
  f.figma.currentPage = { id: "page-b", name: "Other", selection: [] };
  f.events.currentpagechange();
  assert.equal(f.messages.at(-1).pageId, "page-b");
  assert.deepEqual(plain(f.messages.at(-1).selection), []);
});

test("a viewport failure cannot turn a completed copy into an error or remove it", () => {
  const f = fixture(); f.ready(); f.figma.viewport.scrollAndZoomIntoView = () => { throw Error("Unavailable"); };
  assert.equal(f.copyStaffSelection(f.request()).type, "staff-copy-result");
  assert.ok(f.copies.every((copy) => !copy.removed));
});

test("routine polling refreshes renamed files and designs without repeatedly invalidating an unchanged prompt", () => {
  const f = fixture(); f.pollQuery("session");
  const count = f.messages.length;
  f.pollQuery("session");
  assert.equal(f.messages.length, count);
  f.figma.root.name = "Renamed campaign";
  f.page.selection[0].name = "Renamed artboard";
  f.pollQuery("session");
  assert.equal(f.messages.at(-1).documentName, "Renamed campaign");
  assert.equal(f.messages.at(-1).selection[0].name, "Renamed artboard");
});
