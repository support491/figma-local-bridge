import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../plugin/code.js", import.meta.url), "utf8");
function fixture() {
  const data = new Map(), nodes = new Map(), messages = [];
  let sequence = 10, failSave = false, failExport = false;
  const page = { id: "0:1", name: "Campaigns", type: "PAGE", children: [], selection: [], appendChild(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = this; this.children.push(node); }, findOne(predicate) { return [...nodes.values()].find(predicate); } };
  const snapshot = (node) => ({ id: node.id, name: node.name, width: node.width, height: node.height, x: node.x, y: node.y, characters: node.characters, fills: node.fills, children: node.children?.map(snapshot) });
  function create(name, type = "FRAME", parent = page, props = {}) {
    const node = { id: `1:${sequence++}`, name, type, x: 20, y: 30, width: 600, height: 600, visible: true, opacity: 1, fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }], children: type === "TEXT" || type === "RECTANGLE" ? undefined : [], ...props,
      get absoluteBoundingBox() { return { x: this.x + (this.parent?.type !== "PAGE" ? this.parent?.x || 0 : 0), y: this.y + (this.parent?.type !== "PAGE" ? this.parent?.y || 0 : 0), width: this.width, height: this.height }; },
      resize(width, height) { this.width = width; this.height = height; },
      appendChild(child) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = this; this.children.push(child); },
      remove() { this.removed = true; if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); nodes.delete(this.id); for (const child of [...(this.children || [])]) child.remove(); },
      clone() {
        const copy = create(this.name, this.type, this.parent, { x: this.x, y: this.y, width: this.width, height: this.height, fills: structuredClone(this.fills), visible: this.visible, fontName: this.fontName, fontSize: this.fontSize, characters: this.characters });
        for (const child of this.children || []) { const childCopy = child.clone(); copy.appendChild(childCopy); }
        return copy;
      },
      async exportAsync() { if (failExport) throw new Error("Export failed"); return new TextEncoder().encode(JSON.stringify(snapshot(this))); },
    };
    parent.appendChild(node); nodes.set(node.id, node); return node;
  }
  const figma = { root: { name: "Marketing", children: [page], getPluginData(key) { return data.get(key) || ""; }, setPluginData(key, value) { if (failSave) throw new Error("Storage rejected"); data.set(key, value); } }, currentPage: page,
    ui: { postMessage(message) { messages.push(message); } }, showUI() {}, on() {}, commitUndo() {}, viewport: { scrollAndZoomIntoView() {} },
    async getNodeByIdAsync(id) { return id === page.id ? page : nodes.get(id) || null; }, getImageByHash() { return { async getSizeAsync() { return { width: 1600, height: 900 }; } }; }, mixed: Symbol("mixed"),
  };
  const context = vm.createContext({ figma, __html__: "", btoa, Date, setTimeout, clearTimeout });
  vm.runInContext(`${source}\nauditTextOverflow = async root => ({complete:true,text:[],frame:{id:root.id}}); loadCurrentTextFonts = async () => {}; globalThis.campaignTest = { execute, executeCampaign, guardCampaignMutation, readCampaignStore, campaignFingerprint, validateBrandKit, waitForCampaignUiAction, setAudit(fn) { auditTextOverflow = fn; }, busy(value) {bridgeCommandInFlight=value;} };`, context);
  const original = create("Offer");
  const headline = create("Headline", "TEXT", original, { width: 450, height: 70, fontSize: 44, fontName: { family: "Inter", style: "Bold" }, characters: "Summer starts here", fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }] });
  const image = create("Image", "RECTANGLE", original, { y: 160, width: 450, height: 280, fills: [{ type: "IMAGE", imageHash: "approved-photo", scaleMode: "FILL" }] });
  page.selection = [original];
  const request = { name: "Summer", pageId: page.id, nodeIds: [original.id], brief: { objective: "Sell the summer collection", audience: "Local customers", offer: "Summer offer", callToAction: "Shop now", formats: [] } };
  const api = context.campaignTest;
  async function start() { return (await api.execute("campaignStart", request)).campaign; }
  async function approve(campaign, variant = campaign.concepts[0]) {
    const review = await api.execute("campaignReview", { campaignId: campaign.id, conceptId: variant.id });
    await api.execute("campaignReviewEvidence", { campaignId: campaign.id, conceptId: variant.id, revision: review.revision });
    await api.execute("campaignRecordReview", { campaignId: campaign.id, conceptId: variant.id, revision: review.revision, reviewed: true, notes: "Inspected composition, copy and crop. Brand warnings reviewed.", issues: [] });
    return (await api.execute("campaignApprove", { campaignId: campaign.id, conceptId: variant.id, revision: review.revision, userConfirmed: true })).campaign;
  }
  return { ...api, figma, page, nodes, data, messages, original, headline, image, create, request, start, approve, failSave(value) { failSave = value; }, failExport(value) { failExport = value; } };
}

test("campaign start persists three protected directions and preserves original artwork", async () => {
  const f = fixture(), campaign = await f.start();
  assert.deepEqual(Array.from(campaign.concepts, item => item.direction), ["product", "bold", "editorial"]);
  assert.equal(f.original.name, "Offer"); assert.equal(f.original.x, 20);
  assert.equal(f.readCampaignStore().activeId, campaign.id);
  assert.equal(f.page.children.length, 4);
  await assert.rejects(f.execute("campaignStart", f.request), /Finish/);
  await assert.rejects(f.execute("updateText", { nodeId: f.headline.id, text: "Wrong" }), /only draft/);
});

test("campaign mutation guard rejects global writes, ambiguous targets and escaping parents", async () => {
  const f = fixture(), campaign = await f.start(), draft = f.nodes.get(campaign.concepts[0].nodeIds[0]);
  for (const [name, input] of [["setVariableValues", {}], ["dsRender", {}], ["createText", {}], ["createFrame", { parentId: f.original.id }], ["moveResizeReparent", { nodeId: draft.children[0].id, parentId: f.original.id }], ["duplicateNode", { nodeId: draft.id }], ["deleteNode", { nodeId: draft.id }]]) {
    await assert.rejects(f.guardCampaignMutation(name, input), /Campaign|campaign/);
  }
  await f.guardCampaignMutation("copyStyleFromNode", { sourceNodeId: f.original.id, targetNodeIds: [draft.children[0].id] });
  await assert.rejects(f.guardCampaignMutation("applyDesignStyle", { targetNodeIds: [draft.children[0].id, f.headline.id] }), /only draft/);
  await f.execute("moveResizeReparent", { nodeId: draft.id, x: 900 });
  assert.equal(draft.x, 900);
});

test("visual review requires rendered evidence, explicit approval and unchanged artwork", async () => {
  const f = fixture(), campaign = await f.start(), concept = campaign.concepts[0], input = { campaignId: campaign.id, conceptId: concept.id };
  const review = await f.execute("campaignReview", input);
  await assert.rejects(f.execute("campaignRecordReview", { ...input, revision: review.revision, reviewed: true, notes: "Looks good" }), /screenshot review/);
  await assert.rejects(f.execute("campaignApprove", { ...input, revision: review.revision }), /explicit confirmation/);
  const approved = await f.approve(campaign);
  const plan = await f.execute("campaignExportPlan", { campaignId: campaign.id, conceptIds: [concept.id] });
  assert.equal(plan.nodeIds[0], concept.nodeIds[0]);
  assert.equal(approved.concepts[0].status, "approved");
  await assert.rejects(f.guardCampaignMutation("styleNode", { nodeId: concept.nodeIds[0] }), /only draft/);
  f.nodes.get(concept.nodeIds[0]).children[0].characters = "Manual Figma edit";
  await assert.rejects(f.execute("campaignExportPlan", { campaignId: campaign.id, conceptIds: [concept.id] }), /changed after/);
});

test("editing a reviewed draft invalidates evidence before the mutation", async () => {
  const f = fixture(), campaign = await f.start(), concept = campaign.concepts[0];
  await f.execute("campaignReview", { campaignId: campaign.id, conceptId: concept.id });
  await f.guardCampaignMutation("styleNode", { nodeId: concept.nodeIds[0] });
  assert.equal(f.readCampaignStore().campaigns[0].concepts[0].review, null);
});

test("checkpoints are protected and restore as new drafts without replacing existing work", async () => {
  const f = fixture(), campaign = await f.start(), concept = campaign.concepts[0];
  const { checkpoint } = await f.execute("campaignCheckpoint", { campaignId: campaign.id, conceptId: concept.id, label: "Before revision" });
  assert.equal(f.nodes.get(checkpoint.nodeIds[0]).visible, false);
  await assert.rejects(f.guardCampaignMutation("styleNode", { nodeId: checkpoint.nodeIds[0] }), /only draft/);
  const result = await f.execute("campaignRestore", { campaignId: campaign.id, checkpointId: checkpoint.id, userConfirmed: true });
  assert.equal(result.campaign.concepts.length, 4);
  assert.equal(f.nodes.get(result.restored.nodeIds[0]).visible, true);
  assert.notEqual(result.restored.nodeIds[0], concept.nodeIds[0]);
  assert.equal(f.nodes.get(concept.nodeIds[0]).removed, undefined);
});

test("approved concept reflows into editable formats and preserves focal crop without auto approval", async () => {
  const f = fixture(), campaign = await f.start(); await f.approve(campaign);
  const result = await f.execute("campaignAdapt", { campaignId: campaign.id, conceptId: campaign.concepts[0].id, formats: [{ name: "Story", width: 1080, height: 1920 }, { name: "Banner", width: 1200, height: 600 }], focalPoint: { x: .8, y: .4 } });
  assert.equal(result.variants.length, 2);
  for (const variant of result.variants) {
    const root = f.nodes.get(variant.nodeIds[0]);
    assert.equal(root.width, variant.dimensions.width); assert.equal(root.height, variant.dimensions.height);
    assert.equal(variant.status, "draft");
    const image = f.nodes.get(variant.roles.image);
    assert.equal(image.fills[0].scaleMode, "CROP");
    assert.ok(image.fills[0].imageTransform[0][2] >= 0);
    await assert.rejects(f.execute("campaignExportPlan", { campaignId: campaign.id, conceptIds: [variant.id] }), /Only approved/);
  }
});

test("failed campaign persistence removes all newly created drafts", async () => {
  const f = fixture(); f.failSave(true);
  await assert.rejects(f.start(), /Storage rejected/);
  assert.equal(f.page.children.length, 1); assert.equal(f.page.children[0], f.original);
});

test("preview failure cannot register visual evidence and UI cannot forge evidence", async () => {
  const f = fixture(), campaign = await f.start(), concept = campaign.concepts[0];
  await f.execute("campaignReview", { campaignId: campaign.id, conceptId: concept.id });
  f.failExport(true);
  await assert.rejects(f.execute("campaignPreview", { campaignId: campaign.id, conceptId: concept.id }), /Export failed/);
  assert.equal(f.readCampaignStore().campaigns[0].concepts[0].review.renderedEvidence, undefined);
  await f.figma.ui.onmessage({ type: "campaign-action", requestId: "fake", action: "campaignReviewEvidence", input: {} });
  assert.equal(f.messages.find(message => message.requestId === "fake").ok, false);
});

test("finish and resume require confirmation and preserve persistent history", async () => {
  const f = fixture(), campaign = await f.start();
  await assert.rejects(f.execute("campaignFinish", { campaignId: campaign.id }), /Confirm/);
  await f.execute("campaignFinish", { campaignId: campaign.id, userConfirmed: true });
  await f.guardCampaignMutation("setVariableValues", {});
  assert.equal(f.readCampaignStore().campaigns.length, 1);
  await f.execute("campaignResume", { campaignId: campaign.id, userConfirmed: true });
  await assert.rejects(f.guardCampaignMutation("setVariableValues", {}), /protection/);
});

test("brand kits validate bounded portable data and snapshot the version into a campaign", async () => {
  const f = fixture();
  const kit = { schemaVersion: 1, id: "summer_brand", name: "Summer", version: "1", fonts: [{ family: "Inter", style: "Bold" }], colors: [{ name: "Ink", hex: "#112233" }], voice: "Warm and clear", rules: [], references: [], templates: [] };
  await f.execute("brandKitSave", { kit });
  const campaign = (await f.execute("campaignStart", { ...f.request, brandKitId: kit.id })).campaign;
  await f.execute("brandKitSave", { kit: { ...kit, version: "2" } });
  assert.equal(f.readCampaignStore().campaigns[0].brandKit.version, "1");
  assert.equal(campaign.brandKit.colors[0].hex, "#112233");
  await assert.rejects(f.execute("brandKitSave", { kit: { ...kit, colors: [{ name: "Bad", hex: "red" }] } }), /hex/);
});


test("measured review rejects artwork changed during an awaited audit", async () => {
  const f = fixture(), campaign = await f.start(), concept = campaign.concepts[0];
  f.setAudit(async () => { f.nodes.get(concept.nodeIds[0]).children[0].characters = "Changed during measurement"; return { complete: true, text: [] }; });
  await assert.rejects(f.execute("campaignReview", { campaignId: campaign.id, conceptId: concept.id }), /changed during measured checks/);
  assert.equal(f.readCampaignStore().campaigns[0].concepts[0].review, null);
});

test("pending polled commands wait for asynchronous campaign UI work", async () => {
  const f = fixture(), campaign = await f.start(), concept = campaign.concepts[0];
  let release, auditStarted;
  const started = new Promise(resolve => { auditStarted = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  f.setAudit(async () => { auditStarted(); await blocked; return { complete: true, text: [] }; });
  const action = f.figma.ui.onmessage({ type: "campaign-action", requestId: "review", action: "campaignReview", input: { campaignId: campaign.id, conceptId: concept.id } });
  await started;
  let dispatched = false;
  const pending = f.waitForCampaignUiAction("session").then(() => { dispatched = true; });
  await Promise.resolve(); assert.equal(dispatched, false);
  release(); await action; await pending;
  assert.equal(dispatched, true);
  assert.equal(f.messages.find(message => message.requestId === "review").ok, true);
});


test("campaign guard retains read-only design system inspection and rejects unreviewed commands", async () => {
  const f = fixture(); await f.start();
  for (const name of ["dsContrastScan", "dsAuditDS", "dsInspectLayout", "dsComponentSpec", "dsUsage", "dsLibAudit", "dsReadGlyphs"]) await f.guardCampaignMutation(name, {});
  for (const name of ["dsRebindStale", "dsUnknownFutureWrite", "dsSetProps"]) await assert.rejects(f.guardCampaignMutation(name, {}), /Campaign protection/);
});


test("renameNode establishes draft role names, invalidates review, and cannot rename protected originals", async () => {
  const f = fixture(), campaign = await f.start(), concept = campaign.concepts[0];
  assert.equal(concept.rootTypes[0], "FRAME");
  const draft = f.nodes.get(concept.nodeIds[0]), headline = draft.children[0];
  await f.execute("campaignReview", { campaignId: campaign.id, conceptId: concept.id });
  const result = await f.execute("renameNode", { nodeId: headline.id, name: "Headline — Summer campaign" });
  assert.equal(result.name, "Headline — Summer campaign");
  assert.equal(headline.name, result.name);
  assert.equal(f.readCampaignStore().campaigns[0].concepts[0].review, null);
  await assert.rejects(f.execute("renameNode", { nodeId: f.headline.id, name: "Do not rename" }), /only draft/);
  assert.equal(f.headline.name, "Headline");
  await assert.rejects(f.execute("renameNode", { nodeId: headline.id, name: "   " }), /nonempty/);
});
