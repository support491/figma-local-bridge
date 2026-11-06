# Changelog

## 0.14.2-local.4 — 2026-11-05

- Added a staff view with the current file/page, guided marketing tasks, ready-to-copy Claude instructions, connection checks, version mismatch guidance, and support details that omit file content and identifiers.
- Added Work on a copy for selected whole artboards or sections, with a separate Figma undo step, rollback on failed copying, and prompts scoped to the selected copies. Selection and page changes refresh the prompt context.
- New installations open the staff view; a compact view remains available and existing view preferences are preserved. Technical connection controls live under Advanced settings.
- Added coordinated release validation, automated checks and tagged release packaging, paired archive metadata/checksums, deployment instructions for Claude Personal and Figma Professional, and a two-person staff pilot checklist.
- Kept the desktop package local, Mac-only, and API/comment access disabled. Private file updates remain manual; organization publishing and signing require the corresponding accounts and credentials.

## 0.14.2-local.3 — 2026-11-03

- Added a Claude Desktop `.mcpb` staff extension that includes the compiled bridge, uses Claude's Node runtime, and starts or reuses the local owner without a separate service installation.
- Added a companion Figma plugin ZIP and a staff-kit ZIP with both parts and an HTML installation guide. Builds use explicit file lists, fixed archive timestamps, dependency license notices, and SHA-256 checksums.
- The extension launcher enforces disabled API/comment access, clears process-local token settings, and retains the existing disabled API endpoint and memory-only credential backend. It does not change installed services or manual client configuration.
- Updated the SDK, Zod, and locked transitive dependencies to address the previously reported advisories; the dependency audit is clean at build time.
- Added extracted-package integration checks for owner startup, simulated Figma reads, credential/REST blocking, client shutdown, and reuse of an independently managed owner.

## 0.14.2-local.2 — 2026-10-29

- Canvas calls can target saved file names (`name:Hims Design`) or stable supplied file references as well as runtime IDs. Exact unique matches are required; per-call switching preserves each assistant’s default and session lease.
- Text-overflow audits use bounded, yielding batches with resumable cursors, progress and explicit incomplete results. Packaged audits preserve incomplete verification and prevent premature archiving.
- A compact status panel keeps file identity, connection status and activity visible while the bridge runs. Expand restores connection controls; panel size is remembered locally without changing saved file details.

## 0.14.2-local.1 — 2026-10-29

- Connection names and supplied file URLs now persist in private document plugin metadata, load before connecting, and remain separate between files. Saving reports storage failures separately from temporary bridge publication failures; clearing both fields removes the saved record.
- Preserved the local design-system, font, page-creation, layout, variable and prototype extensions while merging upstream 0.14.2.
- Added a persistent macOS HTTP owner and proxy-only MCP clients so assistant restarts do not own the plugin listener lifecycle.
- Added independent plugin targets, explicit per-call routing, pinned composite calls and per-target queues/leases. Connections no longer displace unrelated files.
- Added connection listing, per-proxy file defaults, runtime labels/file links, and a connected-files picker with explicit target IDs and file opening.
- Moved plugin transport to bounded browser-iframe requests, with single-flight heartbeats, generation guards, phase-aware recovery and command-result deduplication.
- Made expensive text-read layout and paint diagnostics opt-in.
- Added an explicit local switch that disables optional API/comment tools and credential/REST routes; the installed service enables this switch.
- Added isolated multi-target, client-restart, routing, operation-recovery and service-configuration checks. Figma runtime failures can still require a plugin restart; file opening does not auto-launch a plugin.

## 0.14.2 — 2026-10-29

- Required image areas now check paint visibility and opacity, plus element and ancestor visibility. Invisible images no longer pass verification or allow previous content to be archived. Reload the updated plugin: compositions require the new image-audit capability.
- Composition recovery IDs are assigned before dispatch and retained in errors, including when the owner accepts a request but its reply is lost. Retrying the same ID retrieves the original operation rather than creating another.
- A plugin whose initial heartbeat confirms session replacement stops before executing the command. Long compositions also check that replacement signal at progress boundaries.
- Composition and image-copy tools switch inherited CROP fills to centered FILL when source and target proportions differ, and report the adjustment. Explicit crop modes/transforms and proportional copies are preserved.
- Updated the shared workflow with clearer delegation timing, source-neutral copy reconciliation, native renaming, and crop/recovery guidance. Routine copy checks no longer request PNGs by default in MCP instructions. Personal source-system policies remain outside the published skill.
- Added regression coverage for invisible images, lost replies, displaced sessions and inherited/explicit crops.

## 0.14.1 — 2026-10-01

- Resizing a CROP-filled node to a different aspect ratio switches that image fill to centered FILL before resizing, preventing image distortion; the resize result reports the adjustment.
- Crop correction supports mixed image/pattern fill stacks and detects proportional changes in very narrow or tall images. Failed resizes restore the original fills; custom crop positions are reset on successful aspect changes.
- Added regression coverage for crop correction, proportional resizing, mixed fills, and failure recovery.

## 0.14.0 — 2026-10-01

- Added tracked compositions with retained operation IDs, phase/percentage updates, idempotent resume, and `figma_operation_status`. A caller timeout no longer discards a later composition result.
- Added `figma_start_composition` for non-blocking board creation. The plugin status panel now shows composition progress while Figma works.
- Composed frames and rectangles can copy an existing image fill directly with `imageSourceNodeId`, including scale mode and crop transform controls.
- Added `imageRequired` and a structured image audit. Empty required image areas leave `verificationComplete` false and preserve any previous layout instead of archiving it.
- Composition checks plugin and bridge-owner capabilities before dispatch, preventing older processes from bypassing image verification or operation tracking. Missing or inconsistent completion evidence requires document inspection.
- A lost final progress update preserves the committed replacement and archive. Session replacement cancels queued work and marks dispatched work as unknown until the document is inspected.

## 0.13.4 — 2026-09-30

- `figma_place_local_image` now accepts an approved HTTPS image URL as well as an absolute local image path. Provide exactly one source; PNG, JPEG, GIF, and WebP remain supported.
- URL downloads are capped at 25 MB, reject embedded credentials and non-public destinations, and recheck each destination across up to five redirects. The bridge checks image signatures before sending bytes to Figma and omits URL query strings from returned source metadata.
- Added offline checks for source validation, DNS and redirect restrictions, image signatures, transfer limits, and Node's DNS lookup callback modes.
- Updated the tool reference and workflow guidance for approved URL images. Reload the MCP server and Figma development plugin after updating.

## 0.13.3 — 2026-09-23

- Replaced the temporary mark with the supplied icon in the Codex plugin listing, composer, README, and Figma plugin status panel. All placements use the same unmodified PNG.
- Canvas commands and MCP tool behavior are unchanged.

## 0.13.2 — 2026-09-23

- Added a matching icon to the Codex plugin listing, composer, README, and Figma plugin status panel. The vector master and square PNG exports are in `assets/`.
- Aligned the Codex and Claude package versions with the bridge and Figma plugin. Canvas commands and MCP tool behavior are unchanged.

## 0.13.1 — 2026-09-23

- `figma_prepare_review` now reads ordered copy and runs optional overflow audits in one packaged plugin command, then exports one PNG per artboard. With two artboards and audits, the plugin handles three commands instead of five.
- The public MCP tool name, inputs, and output shape stay the same. The plugin runs only its built-in JavaScript; it does not accept agent-written code.
- Upgrade both parts: restart the MCP server and reload the Figma development plugin. Check that `figma_bridge_status` reports bridge and plugin version `0.13.1` before a live review.

## 0.13.0 — September 2026

- Added native section and frame composition safeguards, including collision checks and verified replacement before archiving prior layouts.
- Repaired design-system asset discovery and tightened timeout, rollback, credential-removal, instance-cleanup, and style-batch failure reporting.
