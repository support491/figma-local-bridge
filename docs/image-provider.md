# Optional campaign images

Campaign Studio can ask a separately configured OpenAI image service to create a background or illustration, or edit one selected local image. It saves the result on your Mac for review. It does not place the image in Figma automatically.

This feature is **off by default**. Claude Desktop remains the design assistant. An OpenAI API account and its billing are separate from your Claude subscription. Ordinary Figma editing and campaign workflows do not require this service.

## For staff

1. Tell Claude what image you need and where you plan to use it. For an edit, identify the exact local image file and what should change.
2. Claude checks `figma_image_provider_status`. If it is off, ask your administrator to configure it or use an existing approved image instead.
3. Approve the image request. Your prompt—and the selected image when editing—will be sent to OpenAI. Each request may incur an API charge.
4. Claude calls `figma_generate_campaign_image` with a unique request ID. One call produces one PNG image.
5. Review the saved image. Ask Claude to place the approved result using `figma_place_local_image`. Use your approved logo and editable Figma text for brand marks and campaign copy.

If a request is interrupted, keep its request ID. Asking Claude to recover that same request will not send another paid request. A completed request returns the saved file; an uncertain request explains that its provider activity and generated-image folder need checking before you approve a new request.

## Administrator setup

For the Claude Desktop staff extension, open the installed **Figma Local Bridge** extension's configuration in Claude settings. Enable the optional image service, enter your OpenAI API key in its sensitive key field, and keep the default image model or select a supported model below. Save the configuration and restart the extension if Claude requests it. Ask Claude to check `figma_image_provider_status` before trying a paid request. Leaving the image option off keeps the provider disabled even if a key was previously entered. These credentials belong to the separate OpenAI API account, not your Claude subscription.

For administrators running the bridge through another MCP host, configure these environment values on the MCP process that runs the image tool. Do not put API credentials in a Figma file, brand kit, plugin source, prompt, or shared staff ZIP.

| Environment value | Setting |
| --- | --- |
| `FIGMA_IMAGE_PROVIDER` | `openai` to enable; omit to disable |
| `FIGMA_IMAGE_API_KEY` | Your separately managed OpenAI API key |
| `FIGMA_IMAGE_MODEL` | Optional; defaults to `gpt-image-2.5-flare` |

Use your MCP host's private environment/secret configuration. Values set only in an unrelated Terminal window do not configure an already-running desktop app. The package does not collect keys in the Figma panel or automatically edit desktop settings. Restart the MCP process after administrator configuration, then ask Claude to check provider status. Status returns readiness, never the key. Unresolved configuration placeholders and encrypted host placeholders are rejected instead of being sent as credentials.

The supported model allowlist is `gpt-image-1-mini`, `gpt-image-1.5`, `gpt-image-2`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, `gpt-image-2.6-flare`, and `gpt-image-2.6-sunburst`. Account availability may differ. The adapter uses the documented [image generation endpoint](https://developers.openai.com/api/reference/resources/images/methods/generate) and [image editing endpoint](https://developers.openai.com/api/reference/resources/images/methods/edit). It has no configurable API host and rejects redirects.

No Figma API access, comment tools, Figma tokens, or loopback settings need changing.

## Limits and saved files

- One image per request, with `low`, `medium`, or `high` rendering quality; default `medium`.
- Output sizes: 1024 × 1024, 1536 × 1024, or 1024 × 1536. Output is PNG; an optional transparent background is supported.
- Editing accepts one explicitly approved absolute local PNG, JPEG, or WebP path up to 25 MB. No remote source URL or arbitrary document is uploaded.
- The request prompt is limited to 8,000 characters. Requests time out after three minutes and are not automatically retried.
- Images are saved to `~/Pictures/Figma MCP Exports/Generated Campaign Images` by default with user-only file permissions. A JSON file beside each image records the provider, model, dimensions, creation time, and checksums; it omits the prompt text, source path, and credentials.
- A private `.requests` folder retains request outcomes across restarts. Do not delete it while recovering a request; removing a record also removes duplicate-request protection for that ID.
- The returned file remains a generated draft until a person reviews it. Rendering checks do not establish that a product, logo, or claim is accurate.

Image-service requests run in the local MCP process but image generation itself runs at OpenAI. The complete Figma document is not uploaded by this feature.
