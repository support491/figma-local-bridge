# Using Claude with Figma

For the marketing team using Claude Desktop on Mac.

Figma Local Bridge lets you ask Claude to read and update designs in Figma. Once it is set up on your computer, you can work in plain English. You do not need to write code for everyday use.

## Before your first session

Ask the person helping with setup to complete the [one-time installation](#one-time-installation-for-the-person-helping-with-setup) below on **your computer**. You will need Claude Desktop, Figma Desktop, and access to the Figma file you want to edit.

Use a regular chat in the Claude desktop app. This local connection is unavailable in Claude's website and Cowork. You do not need a Figma API key or token.

## Each time you work

1. **Open your design in Figma Desktop.** Open the file and choose the page you want Claude to work on from Figma's page list.
2. **Start the bridge.** In Figma, choose **Plugins → Development → Local MCP Bridge**. Leave its small panel open while you work.
3. **Name the connection the first time.** Choose **Expand**, enter a clear name such as **Marketing Campaign**, paste the file's HTTPS link from Figma's Share menu, and click **Save connection details**. The name and link are remembered for that file. If you duplicate the file later, update its link.
4. **Open Claude Desktop and start a regular chat.** Click **+ → Connectors** and check that **figma_local** is available and enabled for the chat.
5. **Ask Claude to check the connection.** Copy the starter message below. Replace **Marketing Campaign** with the name you saved. Confirm that Claude names the correct file and page before asking it to edit.

> Use the figma_local tools. First call figma_bridge_status and confirm the connection named "Marketing Campaign" and its current page. List the artboards on that page. Do not change anything yet. Keep Figma API and comment access disabled.

6. **Give one clear task.** Name the design and provide the exact wording or change you want. An artboard is the frame containing one design, such as an ad or landing page.
7. **Check the result in Figma.** Review the wording and layout before you use or share the design. When Claude asks to use a tool, review the request and approve it if it matches your task.

Keep Figma, the file, and the bridge panel open until Claude finishes. You can close the panel when you are done; run the plugin again for your next session.

## Requests you can copy

**Review a design**

> In Marketing Campaign, review the artboard named "Summer Sale" for typos and text that does not fit. Tell me what you find before making changes.

**Update a headline**

> In Marketing Campaign, on "Summer Sale", change the headline to "Your summer starts here". Keep the existing fonts, colours, and layout. Check that the new headline fits, then tell me what changed.

**Update a button**

> In Marketing Campaign, on "Summer Sale", change the button text from "Learn more" to "Shop the collection". Check that the text fits inside the button.

Start with one artboard and one task. Give Claude the approved wording when a price, offer, or claim must stay exact.

## If something is not working

- **Claude cannot see Figma:** Check that both desktop apps are open. In the correct Figma file, close and run **Local MCP Bridge** again, then ask Claude to check the connection.
- **figma_local is missing in Claude:** Fully quit Claude using **Command Q**, reopen it, and start a new chat. If it is still missing, contact your setup person.
- **Claude names the wrong file or page:** Stop and tell Claude the saved connection name and the page you want. Ask it to confirm both before editing.
- **A change is taking a long time:** Ask Claude to check whether the previous operation finished before repeating your request.

If the connection still fails, send your setup person the exact error and the file name. Keep API/comment access disabled.

## One time installation for the person helping with setup

Complete this once on each Mac. The marketing team can use the steps above after installation.

1. Install **Claude Desktop**, **Figma Desktop**, and **Node.js 20 or newer**. Give the user access to the design files they will edit.
2. Get a copy of this repository. It is private, so the person downloading it needs access. Follow the [README quick start](../README.md#quick-start) to import `plugin/manifest.json` into Figma and install/start the background bridge service.
3. Follow the [Claude Desktop configuration](../README.md#claude-desktop) to connect the local server. Keep API access disabled in both the service and Claude's settings. Preserve any other existing Claude connections.
4. Fully quit and reopen Claude. Run the bridge in a test Figma file, save a connection name, and use the starter message above. Confirm the correct file and page, then try a small text edit in a test design.

The included automatic background setup is for Mac. Windows needs a separate background-process setup. If the bridge is already installed, reuse it rather than installing a second service from another copy.

Setup references: [Claude Desktop local connection help](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop), [manual local server configuration](https://modelcontextprotocol.io/docs/develop/connect-local-servers), and [local versus remote connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
