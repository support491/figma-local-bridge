import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const ui = await readFile(new URL("../plugin/ui.html", import.meta.url), "utf8");
const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
const context = { type: "staff-context", targetId: "own-file", pageId: "own-page", pageName: "Campaigns", documentName: "Marketing", pluginVersion: version, selection: [{ id: "source-1", name: "Reference", type: "FRAME" }] };
const campaignFixture = () => ({ id: "job-1", name: "Summer", pageId: "own-page", status: "active", brief: { objective: "Promote our service", audience: "New customers", offer: "Approved message", callToAction: "Book now", formats: [{ name: "Square", width: 1080, height: 1080 }] }, concepts: [
  { id: "product", name: "Product focused", direction: "product", nodeIds: ["draft-1"], rootTypes: ["FRAME"], status: "draft", revision: "revision-1" },
  { id: "bold", name: "Bold promotion", direction: "bold", nodeIds: ["draft-2"], rootTypes: ["FRAME"], status: "draft", revision: "revision-2" },
  { id: "editorial", name: "Editorial", direction: "editorial", nodeIds: ["draft-3"], rootTypes: ["FRAME"], status: "draft", revision: "revision-3" },
], checkpoints: [] });
function harness({ clipboard } = {}) {
  const nodes = new Map(), sent = [], copied = [], timers = new Map(); let timerId = 0;
  const element = () => ({ value: "", textContent: "", className: "", disabled: false, hidden: false, children: [], attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; }, appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; }, select() { this.selected = true; } });
  const document = { body: element(), getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, createElement: element };
  const parent = { postMessage(message) { sent.push(message.pluginMessage); } }; const window = {};
  const sandbox = vm.createContext({ document, parent, window, Date, AbortController, navigator: { clipboard: { writeText: clipboard || (async (text) => copied.push(text)) } },
    fetch: async (url) => ({ status: 200, ok: true, json: async () => url.endsWith("/v1/status") ? { bridge: { version } } : url.includes("api-credentials") ? { disabled: true } : { targets: [{ targetId: "own-file", sessionId: "session-1", connected: true }] } }),
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); }, setInterval() {} });
  vm.runInContext(ui.match(/<script>([\s\S]*?)<\/script>/)[1], sandbox);
  const get = (id) => document.getElementById(id);
  get("format-square").checked = true; get("format-story").checked = true;
  get("campaign-focal-x").value = "50"; get("campaign-focal-y").value = "50";
  const message = (value) => window.onmessage({ data: { pluginMessage: value }, source: parent });
  const request = () => sent.filter((item) => item.type === "campaign-action").at(-1);
  return { get, sent, copied, message, request, async connect() { await message(context); await message({ type: "bridge-session", sessionId: "session-1", clientId: "own-file" }); await message({ type: "bridge-status", kind: "connected", phase: "connected", message: "Connected" }); await new Promise(setImmediate); }, async reply(data, additional = {}) { const last = request(); await message({ type: "campaign-result", requestId: last.requestId, action: last.action, ok: true, data, ...additional }); }, async load(campaign = campaignFixture()) { get("campaign-refresh").onclick(); await this.reply({ campaign }); }, fillBrief() { for (const [id, value] of [["campaign-name", "Summer"], ["campaign-objective", "Promote care"], ["campaign-audience", "New customers"], ["campaign-offer", "Approved message"], ["campaign-cta", "Book now"]]) { get(id).value = value; get(id).oninput(); } } };
}

test("campaign preparation requires a brief and captures the current selected originals once", async () => {
  const h = harness(); await h.connect();
  assert.equal(h.get("campaign-prepare").disabled, true);
  h.fillBrief(); assert.equal(h.get("campaign-prepare").disabled, false);
  h.get("campaign-prepare").onclick();
  assert.equal(h.request().action, "campaignStart");
  assert.deepEqual(JSON.parse(JSON.stringify(h.request().input.nodeIds)), ["source-1"]);
  assert.equal(h.request().input.pageId, "own-page");
  assert.equal(h.get("campaign-prepare").disabled, true);
  const count = h.sent.length; h.get("campaign-prepare").onclick(); assert.equal(h.sent.length, count);
  await h.reply({ campaign: campaignFixture() });
  assert.equal(h.get("campaign-concepts").children.length, 3);
  assert.match(h.get("campaign-message").textContent, /Copy the brief into Claude/);
  assert.equal(h.get("campaign-prepare").disabled, true);
});

test("a late campaign response cannot restore controls or concepts from a previous page", async () => {
  const h = harness(); await h.connect(); h.fillBrief(); h.get("campaign-prepare").onclick(); const pending = h.request();
  await h.message({ ...context, pageId: "another-page", pageName: "Different", selection: [] });
  await h.message({ type: "campaign-result", requestId: pending.requestId, action: pending.action, ok: true, data: { campaign: campaignFixture() } });
  assert.equal(h.get("campaign-concepts").children.length, 0);
  assert.equal(h.get("campaign-copy").disabled, true);
  assert.equal(h.get("campaign-prepare").disabled, true);
});

test("campaign results must match both request and action before changing the UI", async () => {
  const h = harness(); await h.connect(); h.get("campaign-refresh").onclick(); const pending = h.request();
  await h.message({ type: "campaign-result", requestId: pending.requestId, action: "campaignStart", ok: true, data: { campaign: campaignFixture() } });
  assert.equal(h.get("campaign-concepts").children.length, 0);
  assert.equal(h.get("campaign-refresh").disabled, true);
  await h.reply({ campaign: campaignFixture() }); assert.equal(h.get("campaign-concepts").children.length, 3);
});

test("creative brief asks for distinct editable directions, rendered review, bounded refinements and human approval", async () => {
  const h = harness(); await h.connect(); await h.load();
  h.get("targets").value = "wrong-file";
  await h.get("campaign-copy").onclick(); const prompt = h.copied.at(-1);
  assert.match(prompt, /targetId "own-file"/); assert.doesNotMatch(prompt, /wrong-file/);
  assert.match(prompt, /product-focused, bold promotional, and editorial/);
  assert.match(prompt, /figma_campaign_review/); assert.match(prompt, /ALL returned rendered images/);
  assert.match(prompt, /at most two refinement passes/); assert.match(prompt, /Never approve a concept on my behalf/);
  assert.match(prompt, /Keep Figma REST API and comments disabled/);
});

test("approval is enabled only for the reviewed current revision and sends explicit confirmation", async () => {
  const h = harness(); await h.connect(); const campaign = campaignFixture(); await h.load(campaign);
  assert.equal(h.get("campaign-approve").disabled, true);
  campaign.concepts[0].review = { revision: "revision-old", checks: { complete: true, errors: [], warnings: [], unknown: [] }, visual: { reviewed: true, notes: "Clear hierarchy" } };
  await h.load(campaign); assert.equal(h.get("campaign-approve").disabled, true);
  campaign.concepts[0].review.revision = "revision-1"; campaign.concepts[0].review.checks.errors.push("Headline clipped");
  await h.load(campaign); assert.equal(h.get("campaign-approve").disabled, true);
  campaign.concepts[0].review.checks.errors = []; await h.load(campaign); assert.equal(h.get("campaign-approve").disabled, false);
  h.get("campaign-approve").onclick(); assert.equal(h.request().action, "campaignApprove"); assert.equal(h.request().input.userConfirmed, true); assert.equal(h.request().input.revision, "revision-1");
});

test("delayed campaign clipboard failure cannot reveal instructions for a previous file or page", async () => {
  let rejectCopy; const h = harness({ clipboard: () => new Promise((_, reject) => { rejectCopy = reject; }) }); await h.connect(); await h.load();
  const pending = h.get("campaign-copy").onclick(); await h.message({ ...context, pageId: "other", selection: [] }); rejectCopy(new Error("clipboard denied")); await pending;
  assert.equal(h.get("campaign-prompt").hidden, true); assert.equal(h.get("campaign-prompt").value, "");
});

test("preview requests are serialized and render original then selected concept without HTML injection", async () => {
  const h = harness(); await h.connect(); const campaign = campaignFixture(); campaign.concepts[0].name = "<script>alert(1)</script>"; await h.load(campaign);
  assert.equal(h.get("campaign-concepts").children[0].children[0].textContent, "<script>alert(1)</script>");
  h.get("campaign-preview").onclick(); assert.equal(h.request().input.original, true);
  await h.reply({ images: [{ imageBase64: "YWJj", mimeType: "image/png" }] });
  assert.equal(h.request().action, "campaignPreview"); assert.equal(h.request().input.original, undefined);
  assert.equal(h.get("campaign-preview").disabled, true);
  await h.reply({ images: [{ imageBase64: "ZGVm", mimeType: "image/png" }] });
  assert.equal(h.get("campaign-original-image").src, "data:image/png;base64,YWJj"); assert.equal(h.get("campaign-draft-image").src, "data:image/png;base64,ZGVm"); assert.equal(h.get("campaign-previews").hidden, false);
});

test("format adaptation requires approval and rejects invalid focal point input", async () => {
  const h = harness(); await h.connect(); const campaign = campaignFixture(); await h.load(campaign); assert.equal(h.get("campaign-adapt").disabled, true);
  campaign.concepts[0].status = "approved"; campaign.concepts[0].approvedRevision = "revision-1"; campaign.concepts[0].review = { revision: "revision-1", checks: { complete: true, errors: [] }, visual: { reviewed: true, issues: [] } }; await h.load(campaign); h.get("campaign-focal-x").value = "101"; const count = h.sent.length; h.get("campaign-adapt").onclick(); assert.equal(h.sent.length, count); assert.match(h.get("campaign-message").textContent, /between 0 and 100/);
  h.get("campaign-focal-x").value = "25"; h.get("campaign-adapt").onclick(); assert.equal(h.request().action, "campaignAdapt"); assert.equal(h.request().input.focalPoint.x, .25); assert.equal(h.request().input.formats.length, 2);
});

test("brand import retains its portable metadata and native errors remain visible", async () => {
  const h = harness(); await h.connect();
  const kit = { schemaVersion: 1, id: "brand", name: "Care", version: "1", colors: [{ name: "Navy", hex: "#123456" }], fonts: [{ family: "Inter", style: "Bold" }], voice: "Clear", rules: ["Keep logo"], references: ["Approved campaign"], templates: [] };
  h.get("brand-json").value = JSON.stringify(kit); h.get("brand-import").onclick(); assert.equal(h.request().action, "brandKitSave"); assert.equal(h.request().input.kit.rules[0], "Keep logo");
  await h.reply({ kit }); assert.equal(h.get("campaign-brand").value, "brand"); assert.equal(h.get("brand-name").value, "Care");
  h.get("brand-colors").value = "Navy: not-a-color"; const count = h.sent.length; h.get("brand-save").onclick(); assert.equal(h.sent.length, count); assert.match(h.get("campaign-message").textContent, /each colour/);
  h.get("campaign-refresh").onclick(); await h.reply({}, { ok: false, error: "Current page changed. Refresh your selection." }); assert.match(h.get("campaign-message").textContent, /Current page changed/); assert.equal(h.get("campaign-refresh").disabled, false);
});

test("optional image prompt checks provider availability and asks before paid requests", async () => {
  const h = harness(); await h.connect(); await h.load(); h.get("campaign-image-brief").value = "A soft botanical illustration"; h.get("campaign-image-brief").oninput();
  await h.get("campaign-image-copy").onclick(); const prompt = h.copied.at(-1);
  assert.match(prompt, /figma_image_provider_status/); assert.match(prompt, /ask for my approval/); assert.match(prompt, /reuse that ID for recovery/); assert.match(prompt, /Do not request or store any provider key/); assert.match(prompt, /figma_place_local_image/);
});

test("finish and resume make the editing restriction explicit while preserving saved history", async () => {
  const h = harness(); await h.connect(); const campaign = campaignFixture(); campaign.checkpoints = [{ id: "saved-1", label: "Before copy changes", conceptId: "product" }]; await h.load(campaign);
  assert.equal(h.get("campaign-restore").disabled, false); h.get("campaign-finish").onclick(); assert.equal(h.request().input.userConfirmed, true);
  campaign.status = "finished"; await h.reply({ campaign }); assert.equal(h.get("campaign-resume").disabled, false); assert.equal(h.get("campaign-copy").disabled, true); assert.equal(h.get("campaign-checkpoints").children.length, 1);
  h.get("campaign-resume").onclick(); assert.equal(h.request().action, "campaignResume");
});


test("adapted formats are selectable and use their own revision for review and approval", async () => {
  const h = harness(); await h.connect(); const campaign = campaignFixture();
  campaign.formats = [{ id: "story", name: "Story", dimensions: { width: 1080, height: 1920 }, nodeIds: ["story-1"], status: "draft", revision: "story-revision", review: { revision: "story-revision", checks: { complete: true, errors: [], warnings: [], unknown: [] }, visual: { reviewed: true, notes: "Readable", issues: [] } } }];
  await h.load(campaign); assert.equal(h.get("campaign-concepts").children.length, 4); h.get("campaign-concepts").children[3].onclick();
  await h.get("campaign-review").onclick(); assert.match(h.copied.at(-1), /conceptId "story"/);
  h.get("campaign-approve").onclick(); assert.equal(h.request().input.conceptId, "story"); assert.equal(h.request().input.revision, "story-revision");
});

test("saved finished campaigns can be reopened after plugin restart without losing history", async () => {
  const h = harness(); await h.connect(); h.get("campaign-refresh").onclick();
  await h.reply({ campaign: null, campaigns: [{ id: "job-1", name: "Summer", pageId: "own-page", status: "finished" }, { id: "other", name: "Other page", pageId: "other-page", status: "finished" }] });
  assert.equal(h.get("campaign-saved").children.length, 2); h.get("campaign-saved").value = "job-1"; h.get("campaign-saved").onchange();
  h.get("campaign-open").onclick(); assert.equal(h.request().input.campaignId, "job-1");
  const campaign = campaignFixture(); campaign.status = "finished"; await h.reply({ campaign });
  assert.equal(h.get("campaign-resume").disabled, false); assert.equal(h.get("campaign-review").disabled, true);
});

test("unresolved visual findings keep approval disabled even when measurable checks pass", async () => {
  const h = harness(); await h.connect(); const campaign = campaignFixture(); campaign.concepts[0].review = { revision: "revision-1", checks: { complete: true, errors: [] }, visual: { reviewed: true, notes: "Needs refinement", issues: ["Logo is obscured"] } }; await h.load(campaign);
  assert.equal(h.get("campaign-approve").disabled, true); assert.match(h.get("campaign-checks").textContent, /Logo is obscured/);
});


test("active campaigns disable legacy copying and mutating quick prompts but retain read-only checks", async () => {
  const h = harness(); await h.connect(); await h.load();
  assert.equal(h.get("staff-copy-design").disabled, true);
  h.get("staff-task").value = "headline"; h.get("staff-task").onchange(); assert.equal(h.get("staff-copy-prompt").disabled, true);
  h.get("staff-task").value = "check"; h.get("staff-task").onchange(); assert.equal(h.get("staff-copy-prompt").disabled, false);
  assert.match(h.get("staff-next").textContent, /Use Campaign Studio/);
});

test("campaign prompts use the pinned brand snapshot and prepare role names before approval", async () => {
  const h = harness(); await h.connect(); const campaign = campaignFixture(); campaign.brandKitId = "brand-1"; await h.load(campaign);
  await h.get("campaign-copy").onclick(); const prompt = h.copied.at(-1);
  assert.match(prompt, /immutable brandKit snapshot/); assert.match(prompt, /do not replace the campaign snapshot/); assert.match(prompt, /BEFORE review and approval/); assert.match(prompt, /direct children named Headline/); assert.match(prompt, /figma_rename_node/);
});

test("size handoff carries selected format IDs and maps roles without changing approved designs", async () => {
  const h = harness(); await h.connect(); const campaign = campaignFixture(); campaign.concepts[0].nodeIds = ["draft-a", "draft-b"]; campaign.concepts[0].status = "approved"; await h.load(campaign);
  assert.equal(h.get("campaign-adapt").disabled, true); assert.equal(h.get("campaign-size-copy").disabled, false);
  await h.get("campaign-size-copy").onclick(); const prompt = h.copied.at(-1);
  assert.match(prompt, /conceptId "product"/); assert.match(prompt, /"width":1080,"height":1920/); assert.match(prompt, /Verify the exact current IDs/); assert.match(prompt, /restore it as a new draft/);
});

test("remote mutation activity invalidates approval controls until campaign state is refreshed", async () => {
  const h = harness(); await h.connect(); const campaign = campaignFixture(); campaign.concepts[0].review = { revision: "revision-1", checks: { complete: true, errors: [] }, visual: { reviewed: true, issues: [] } }; await h.load(campaign);
  assert.equal(h.get("campaign-approve").disabled, false);
  await h.message({ type: "bridge-activity", phase: "start", mutating: true, label: "Update headline" }); await h.message({ type: "bridge-activity", phase: "end", mutating: true, ok: true, label: "Update headline" });
  assert.equal(h.get("campaign-approve").disabled, true); assert.match(h.get("campaign-checks").textContent, /Refresh the campaign/);
  campaign.concepts[0].review = null; await h.load(campaign); assert.equal(h.get("campaign-approve").disabled, true);
});


test("a campaign on another page blocks starting duplicate work and gives a useful next step", async () => {
  const h = harness(); await h.connect(); h.fillBrief(); h.get("campaign-refresh").onclick();
  await h.reply({ campaign: null, campaigns: [{ id: "other-job", name: "Other campaign", pageId: "other-page", status: "active" }], activePageId: "other-page" });
  assert.equal(h.get("campaign-prepare").disabled, true); assert.match(h.get("campaign-message").textContent, /different page/);
});

test("approved component or instance roots cannot use direct size adaptation", async () => {
  const h = harness(); await h.connect(); const campaign = campaignFixture(); campaign.concepts[0].status = "approved"; campaign.concepts[0].rootTypes = ["INSTANCE"]; campaign.concepts[0].approvedRevision = "revision-1"; campaign.concepts[0].review = { revision: "revision-1", checks: { complete: true, errors: [] }, visual: { reviewed: true, issues: [] } }; await h.load(campaign);
  assert.equal(h.get("campaign-adapt").disabled, true); assert.equal(h.get("campaign-size-copy").disabled, false);
});
