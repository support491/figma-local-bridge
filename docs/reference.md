# Detailed workflows and tool reference

The [README](../README.md) has setup and the quickest review path. The bundled [workflow skill](../skills/figma-local-workflow/SKILL.md) gives agents the inspect-first sequence.

## Connections, targeting and service lifecycle

The background owner runs `dist/server.mjs --http-owner`; MCP clients run `dist/server.mjs --proxy-only` and share its loopback endpoint. Closing or restarting a Codex or Claude Code MCP client does not stop the owner or disconnect Figma plugins. On macOS, `scripts/service.mjs` manages the per-user launch agent. When changing its plist or environment, use **stop → install → start**; `restart` only restarts the currently loaded service configuration.

Run Local MCP Bridge in each file you want to use and leave its panel open. `figma_list_connections` lists runtime `targetId` values, labels, pages, health, activity and any supplied file links. Check `figma_bridge_status` and the expected file/page before working. With several connections, pass the chosen runtime ID, `file:<key>` or `name:<saved label>` as `targetId` to every canvas tool. Selection or foreground focus does not choose an agent's target.

A client can set `FIGMA_BRIDGE_TARGET` or a per-call `targetId` to a runtime ID, `file:<key>`, or `name:<saved label>`. File references use supplied HTTPS Figma URLs; names match saved labels/document names exactly, never page names. No match or multiple matches fail before dispatch. Discovery returns `namedTargetRefs` and `stableTargetRef`. Explicit calls override only that request; client defaults remain unchanged. Resolved runtime and session IDs stay pinned for the entire operation.

The plugin's **Connected files** panel lists already-connected files. Choosing a row exposes its target ID and saved link; the assistant still chooses the target explicitly. Opening a saved URL opens the file but does not launch its bridge plugin. This list is not a REST-backed inventory of every accessible Figma file.

Choose **Save connection details** to remember a connection name and HTTPS file URL across plugin restarts. The plugin writes only a small versioned record under its private, namespaced document-root key `figma_local_bridge.connection.v1`; it does not create or change visible canvas nodes. The record belongs to the Figma file, is restored before the first bridge connection and survives normal Figma save/sync. Separate files keep separate records. No REST call, token or private Figma API is used. Clear both fields and save to remove the record.

The panel distinguishes **Saved with this Figma file** from **Restored** details. A successful file save remains saved if bridge publication fails; the panel reports that it is waiting to publish. A storage-write failure does not replace the previous runtime details. Invalid or unsupported saved records are ignored with an actionable message rather than automatically advertising an unsafe link.

Copied or duplicated files can inherit the saved record. Verify and update a copy's URL before using it with a pinned client. A remembered supplied URL is not independently verified file identity, and two operational connections advertising the same file reference still fail the unique-pin check. See [this machine's setup](../LOCAL-SETUP.md) for its configured client pins and existing preference-store location.

### Concurrency and interrupted calls

Logical MCP canvas calls hold a lease on their target connection, keeping a composite read/export operation together while other connections can proceed. A lease covers one plugin runtime. Two windows advertising the same file are flagged as possible duplicates when their supplied identities match; they do not share a document-wide lease. Use one writer per actual file.

Canvas tools accept an `operationId` recovery key. Reuse it only with the same target and inputs. A repeated completed request returns its recorded result without sending the canvas command again. A queued ordinary request that expires is removed before dispatch; a tracked caller timeout retains the original operation for status checks and recovery. Dispatched work is not cancelled by a caller timeout.

An unknown dispatched outcome keeps an execution fence on the target. Inspect operation status and the affected document before recovery. `figma_acknowledge_uncertain_operation` requires explicit user confirmation and a replacement session; it never replays the old operation. A matching late completion can release the fence while the recorded outcome remains unknown. Do not acknowledge automatically or interpret a zero pending count as proof that plugin execution stopped.

Operation history is held in the owner process's memory for up to one hour, with a terminal-record count limit. It survives MCP client restarts, but not an owner restart. If a recovery ID is no longer known, inspect the document before beginning another edit. Automatic plugin reconnection does not restore that history or replay work.

## Workflows

### Campaign Studio

Use `figma_brand_kit_save/list/get` for explicitly approved, versioned document brand packs. Import/export the JSON through the staff panel to share a pack. A template's node references belong to its Figma file and must be verified/relinked when transferred.

1. Confirm target/file/page and read the intended source artboards. Call `figma_campaign_start` with the brief and source IDs to prepare three concept workspaces. It does not call an AI model or produce three finished designs by itself.
2. Use existing local tools to develop each returned draft into a distinct creative direction. Active-campaign guards reject writes outside draft roots and global style/variable changes. Reuse existing styles/tokens, or confirmed brand values inside drafts; do not change shared tokens to bypass scope restrictions.
3. Call `figma_campaign_review` to receive bounded measurable checks and inline screenshots. Inspect every image, identify subjective concerns separately, and refine at most twice before returning remaining issues to the user. Record notes with `figma_campaign_record_review` using the exact returned revision. An interrupted screenshot or a changed draft cannot complete this review.
4. Ask the user to choose and approve a reviewed concept, then use `figma_campaign_approve`. Approval freezes that concept for ordinary bridge edits. Use a named checkpoint and restore it as a new draft for further revisions.
5. `figma_campaign_adapt` produces size variants using semantic role mappings and layout rules. Inspect unfamiliar/nested templates carefully; this is bounded adaptation, not a general-purpose layout solver. Review and approve each output independently.
6. `figma_campaign_export` exports selected, currently approved concepts/variants as local PNGs. It verifies approval again after rendering and reports partial exports when anything fails. Figma retains the editable source and history.
7. Only on explicit user instruction, `figma_campaign_finish` releases the active draft-only boundary. `figma_campaign_resume` restores it. Never finish a campaign to bypass an edit denial.

Campaign metadata and checkpoints persist with the Figma document; manual edits are detected by fresh artwork fingerprints before review/approval/export. Plugin guards apply to bridge commands, not a person's direct canvas editing or another Figma plugin. The local bridge is still for a trusted local machine, and one writer should own a physical document at a time.

Optional `figma_image_provider_status` performs no network request. `figma_generate_campaign_image` requires a configured provider and the user's approval of the specific paid generation/edit request. Reuse its request ID after interruption. Unknown outcomes are never automatically resubmitted. See [image setup](image-provider.md); keys never belong in prompts, brand packs, or Figma document data.

### Design-system preference workflow

`figma_get_user_preferences` returns only choices the user explicitly confirmed. When choosing assets, prefer a matching scoped preference, then a linked component already used in the file, then another verified component/style/token, and construct from raw values only as a fallback. Use `figma_create_component_instance` and `figma_apply_design_style` to preserve linkage.

If multiple systems remain equally plausible, call `figma_resolve_design_choice`. A tie returns `needsClarification: true` with candidate details and must not trigger an edit. Ask the user which system to use; apply that answer once, or save it with `figma_set_user_preference` only after explicit confirmation. Preferences can be queried, updated, deleted, and reverted in ordinary LLM conversation. Revision guards prevent two MCP tasks from silently overwriting each other.

Preferences are private to the local OS user and stored at `~/.figma-local-bridge/preferences.json` by default. Set `FIGMA_PREFERENCES_DIR` to use an existing store. This machine explicitly keeps its existing store at `~/.local/share/figma-local-bridge-state/preferences.json`; moving the repository must not create a replacement preference store. The bridge never infers or saves preferences from the canvas automatically.

### External copy-sync workflow

When the user identifies an external system as the source of truth:

1. Confirm the connection/target, list artboards and call `figma_read_copy` for the exact target frame IDs.
2. Diff external fields against the returned text IDs and `copy`. Omit unchanged nodes.
3. Call `figma_apply_copy_updates` once, passing each prior value as `expectedText`. Include affected `auditFrames` when fit needs checking and `exportFrames` when visual verification is needed; routine copy-only checks do not require PNG exports.
4. Re-read the affected copy and inspect any returned audits/PNGs. Use `figma_set_text_frame` or `figma_split_text_block` only when changed hierarchy or fit requires it, then verify again.

Delete only a clearly stray element identified by the user. Preserve all other nodes, including hidden or superseded content.

### Page re-layout workflow

1. List artboards, read the target in `summary` mode, and export its current PNG.
2. Call `figma_list_design_system_assets` and `figma_list_page_tokens`. Prefer verified linked components, named styles, and variables; use `figma_copy_style_from_node` against an on-brand source node when needed. Do not approximate available assets, fonts, or colours.
3. Call `figma_compose_frame` with one named replacement frame and ordered frame/rectangle/text elements. Use styled spans for mixed emphasis and typographic case inside a single text layer; keep the stored copy in natural case. A frame or rectangle can set `imageSourceNodeId` to reuse an existing image fill and `imageRequired: true` to make an empty image area fail completion verification.
4. For a potentially slow board, call `figma_start_composition`, then poll `figma_operation_status`. Reuse its operation ID after interruption; errors also include the recovery ID. Never start a second composition while the first is queued, running or unknown. If the bridge restarted and lost its history, inspect the document before starting again.
5. Prefer passing explicit `archiveNodeIds` to the composer. Previous sibling content is grouped and hidden only when text/export/image verification is complete; otherwise it is preserved and the result explains why archival was skipped.
6. Inspect the returned compact overflow audit, image audit, and local PNG. Re-read in `full` mode only when hierarchy or hidden variants require diagnosis.

Required images must have a visible image paint with positive opacity on an effectively visible element. Hidden or transparent paints, elements and ancestors fail verification and leave previous content in place. This check does not prove that a visible image is unobscured or appropriately composed; inspect the visual preview when that matters.

Compositions and `figma_copy_image_fill` switch an inherited CROP to centered FILL when source and target proportions differ. They report the adjustment in `imageFillAdjustments` or `image.adjustment`. A supplied crop mode or transform is preserved; review that explicit crop at its final dimensions. `figma_move_resize_reparent` likewise reports crop resets in `imageResizeAdjustments`.

### Colour-token workflow

When a prompt names colours, call `figma_create_color_tokens` before creating artwork. Preserve the supplied names exactly (for example, `Oxford blue`, `SBS orange`, `Lilac`, `White`, and `Black`) and provide their hex values. Use the returned `fillTokenId` or `strokeTokenId` on frames and shapes, and `fillTokenId` on text. This keeps the artwork bound to one reusable source of truth instead of scattering raw hex values across layers.

## Tool reference

The bridge keeps its command surface intentionally narrow. It exposes the following controlled operations rather than arbitrary Plugin API code:

- `figma_list_connections` / `figma_bridge_status` — discover connected targets and verify their current page, health, versions and activity.
- `figma_acknowledge_uncertain_operation` — acknowledge an inspected unknown outcome after session replacement, only with explicit user confirmation; never automatically retry an uncertain edit.
- `figma_create_frame` — exact dimensions, solid fill/stroke, clipping, auto-layout, and optional parent.
- `figma_create_rectangle` / `figma_create_ellipse` — graphic blocks, CTA backgrounds, and simple devices.
- `figma_create_text` — editable text with colour, wrapping, alignment, line height, letter spacing, typographic case, styled spans, opacity, and optional parent.
- `figma_style_node` — apply a constrained visual style to an existing node.
- `figma_create_color_tokens` — create/update local Figma colour variables using the prompt's colour names verbatim, then return token IDs for binding.
- `figma_import_svg` — place a validated SVG string as editable vectors.
- `figma_list_fonts` — discover installed typefaces and style names.
- `figma_list_pages` / `figma_navigate_to_page` — inspect and switch the active page.
- `figma_query_page_nodes` — inspect node IDs, bounds, ancestry, child counts, and concise visual metadata.
- `figma_inspect_canvas_layout` — list native sections and the occupied canvas envelope, or collision-check an existing/proposed placement against visible siblings.
- `figma_screenshot` — return a PNG for a selected node or the visible page.
- `figma_move_resize_reparent`, `figma_set_selection`, `figma_duplicate_node` — controlled structural editing.
- `figma_read_text` / `figma_update_text` — inspect and replace existing editable text with its current fonts loaded first.
- `figma_set_text_case` — display existing natural-case copy as uppercase, lowercase, title case, small caps, or original without rewriting its characters.
- `figma_read_copy` — compact, ordered text IDs/copy/bounds/visibility for external-source diffing.
- `figma_apply_copy_updates` — guarded style-preserving updates plus overflow audits and local PNG verification in one response.
- `figma_set_text_frame` — set text width, height, auto-resize, truncation, and line limits without replacing copy.
- `figma_split_text_block` — split one styled text layer into heading and body while preserving each range's typography.
- `figma_delete_node` — permanently remove one identified node and its descendants; use only on an explicit user request.
- `figma_read_frame_content` / `figma_read_spread_content` — ordered editorial copy with text-node IDs and hierarchy paths.
- `figma_list_artboards` — clean page-level and section-level artboard list, excluding nested implementation frames.
- `figma_create_section` — create a native reference-board/artboard section with collision rejection by default.
- `figma_audit_text_overflow` — bounds and natural-size checks with actionable overflow and clipping warnings.
- `figma_export_frame_png` — write a PNG to `~/Pictures/Figma MCP Exports` and return only its absolute path and dimensions.
- `figma_prepare_review` — read and optionally audit one to eight ordered artboards in one packaged plugin operation, then export them locally in the same MCP call.
- `figma_archive_nodes` / `figma_supersede_layout` — hide explicit prior siblings in a named reversible group and record the replacement relationship.
- `figma_compose_frame` — create a tracked native frame in the page or a section, with root auto-layout, panels/dividers, styled-span text, direct reuse of existing image fills, and required-image verification.
- `figma_start_composition` / `figma_operation_status` — start a long composition without blocking, then inspect its phase, percentage, warnings, error, or completed result before retrying.
- `figma_copy_style_from_node` / `figma_list_page_tokens` — inherit verified on-brand styling and discover local variables/styles plus page usage.
- `figma_list_design_system_assets` — discover components, styles, and variables verified in the current file, including remote assets currently used and enabled linked-library variable collections.
- `figma_create_component_instance` / `figma_apply_design_style` — create a linked instance or apply a named local/library style by verified ID or key.
- `figma_get_user_preferences` / `figma_set_user_preference` / `figma_delete_user_preference` / `figma_revert_user_preferences` — manage explicit, revision-guarded per-user design-system guidance.
- `figma_resolve_design_choice` — score candidates against confirmed scoped preferences and require clarification rather than guessing when they tie.
- `figma_copy_image_fill` / `figma_place_local_image` — reuse/crop an existing Figma image or place an explicitly approved local raster image. `figma_place_local_image` accepts exactly one absolute local path or HTTPS URL, caps transfers at 25 MB, follows at most five redirects, validates every destination as public, and checks image bytes before importing.
- Optional builds with API access enabled also expose `figma_comment_status`, `figma_list_comments`, `figma_post_comment` and `figma_delete_comment`. This installation sets `FIGMA_BRIDGE_API_DISABLED=1`, so those tools are not advertised.

For brand assets, read a trusted SVG file locally and pass its content to `figma_import_svg`; do not redraw logo artwork as text or paths. SVG import is only for approved logos, icons and isolated vector artwork—not boards, UI layouts, panels or editable labels.

## Optional comment setup

**Disabled on this machine.** The owner's and clients' `FIGMA_BRIDGE_API_DISABLED=1` setting hides comment tools, blocks REST and credential-save/test/clear routes, and bypasses credential lookup. Existing blank credentials, memory-only credential storage and the `http://127.0.0.1:9` API blackhole remain in place. Do not add a token, enable private API access or change that endpoint without the user's explicit instruction. The following upstream capability notes are retained as reference for separately authorized installations.

Figma does not expose comments to its Plugin API, so comment tools are the one part of the bridge that needs REST credentials. Open **Figma API access** in the connected plugin, paste a personal access token and the file URL, then choose **Save & test**. Grant `file_comments:read`; add `file_comments:write` if you also want to post, reply, or delete.

The bridge saves the token in macOS Keychain, Windows user-scoped DPAPI encryption, or Linux Secret Service. If secure system storage is unavailable, it says so and keeps the token only for the current bridge session—there is no plaintext fallback. The plugin immediately clears the password field and never puts the token in the Figma document, plugin storage, logs, or MCP output.

**Save & test** safely verifies comment-read access against the chosen file. Figma does not provide scope introspection, so write access remains “not tested” until you intentionally post a comment. As an advanced alternative, set `FIGMA_ACCESS_TOKEN` and `FIGMA_FILE_KEY` privately in the MCP server environment; environment-managed credentials cannot be changed in the plugin.

## Security model

The owner accepts only loopback IP bindings (`127.0.0.1` or `::1`); this machine uses `127.0.0.1:3846`. It rejects unexpected Host headers. Internal command, lease and recovery routes reject browser Origin headers, including `null`, and require JSON where applicable. Canvas commands remain named, validated operations; the bridge does not accept agent-written JavaScript.

The transport relies on a trusted local machine and does not use secret pairing. Other local processes can access the port. Plugin/status routes also accept permitted Figma origins, the matching local endpoint origin and opaque `Origin: null` frames needed by the plugin iframe. A browser frame with access to loopback can therefore reach that surface; Host/CORS checks do not authenticate a plugin connection or make this safe against untrusted local software. Strong plugin authentication is outside this implementation's scope.

In an API-enabled installation, optional comment requests send the stored token to the configured API endpoint in an `X-Figma-Token` header. The UI clears a newly entered token immediately and does not put it in the Figma document. Secure credential storage is macOS Keychain, Windows CurrentUser DPAPI, or Linux Secret Service; when none is usable, the UI reports a session-only fallback. This machine's explicit API-disabled setting takes precedence over configured credentials and prevents those requests. Canvas tools need no Figma REST token.

The preference store is created with user-only file permissions. It contains guidance you explicitly ask the LLM to remember, not Figma document contents. No preference is learned or written automatically.

## Audit batches and compact panel

Overflow audits return bounded batch findings and cumulative `totals` and top-level counts. `text` and `batch` describe only the current batch. Defaults: `maxTextNodes: 40`, `maxTraversalNodes: 400`, `timeBudgetMs: 1000`; maxima: 200, 4000 and 3000 respectively. `complete: false` requires continuing `nextCursor` on the same target, current page, root and `includeHidden`. Cursors are single-use, runtime-local, kept for at most five minutes, and limited to eight outstanding scans. Stop by omitting further continuation calls. Restart after document edits. Time limits are cooperative; they do not interrupt one native Figma API await.

Summary mode retains completion and continuation fields. Packaged reviews/copy updates and compositions must not claim verification or archive a predecessor when audits are incomplete. Continue the audit separately and inspect all batches before another write.

The compact panel retains current file, connection status, activity and error messages. Expand/Compact changes only the panel, preserving active work and the HTTP transport. `figma_local_bridge.panel_compact.v1` stores only a Boolean view preference in per-user Figma client storage; file labels/URLs remain in their existing per-document record.
