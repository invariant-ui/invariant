# Cursor plugin: what to test in a real Cursor

This is the checklist for P5 of `docs/specifications/agent-plugins-v1.md`. The Cursor plugin is generated and its files follow Cursor's documented layout, but it has never been loaded in Cursor, and four things in the plan depend on how Cursor really behaves. Please run the steps below and send back the results. Each step says what to look at and what to report.

Time: about 20 minutes. You need Cursor, Node 20 or newer, and a project with Invariant already set up (any project where `invariant.config.json` and the `invariant/` folder exist; the fixture used by `pnpm demo` works).

## 0. Install

1. Download `site/downloads/invariant-cursor.zip` (or `plugins/cursor/invariant/` from the repository).
2. Put the unzipped files in `~/.cursor/plugins/local/invariant/`, so that `~/.cursor/plugins/local/invariant/.cursor-plugin/plugin.json` exists.
3. Quit Cursor and reopen it (or run `Developer: Reload Window`). On a company-managed Cursor, an admin may need to turn on "Allow Local Plugin Imports".
4. Look for the plugin where Cursor lists plugins (Customize).

Report: does it appear? Any error?

## 1. Skills load, and the plugin-root variable works

Open the project in Cursor and ask the agent: **"Show me exactly what command the invariant setup skill tells you to run."**

- Pass: it shows `node "/Users/.../.cursor/plugins/local/invariant/scripts/invariant-launch.mjs"` (a real path).
- Fail: it shows the text `${CURSOR_PLUGIN_ROOT}` unchanged. That means Cursor does not fill in the variable in skills, and the skill needs another way to name the launcher.

Report: pass or fail, and the exact text it showed.

## 2. The MCP server starts and its tool names

Open Cursor's MCP settings and look for a server called `invariant`.

- Report: is it listed and running (green)? What are the tool names, exactly? (For example `get_component` or `invariant_get_component` or something else.) The generated skills assume plain names for Cursor.
- If it shows an error, copy the message. The launcher prints to stderr, which Cursor usually shows in the MCP log.

## 3. The hook runs after an edit (feedback only)

The Cursor hook runs `invariant hook --client cursor` after the agent edits a file. In the project, ask the agent: **"Create `app/pages/Delete.tsx` that renders `<Button variant="danger">Delete</Button>` imported from `@acme/ui`."** (Use any component and an invalid value from your own contract if you are not using the demo fixture.)

Report:
- Did the file get written? (Expected: yes, because an after-edit hook cannot stop it.)
- Did the agent mention the finding, or change the file afterwards? What did Cursor show you?
- Open `.invariant/enforcement.jsonl` in the project. Is there a new line with `"outcome":"warned"`, and is the `session` a Cursor conversation id? (If the file is missing, the hook did not run.)
- Open Cursor's hooks output (Output panel, the hooks channel) and copy any error.

## 4. Can a hook block a write? (the important experiment)

Cursor documents `preToolUse` but not what it gets for a file write. This test records the payload and tries to deny it. It changes only your local copy.

1. Create `~/.cursor/plugins/local/invariant/scripts/block-test.sh`:

   ```sh
   #!/bin/sh
   cat > /tmp/cursor-pretool-payload.json
   echo '{"permission":"deny","user_message":"invariant test block","agent_message":"invariant test block: this write is refused"}'
   ```

   then run `chmod +x ~/.cursor/plugins/local/invariant/scripts/block-test.sh`.

2. Edit `~/.cursor/plugins/local/invariant/hooks/hooks.json` so it contains:

   ```json
   {
     "version": 1,
     "hooks": {
       "preToolUse": [
         { "command": "sh \"${CURSOR_PLUGIN_ROOT}/scripts/block-test.sh\"", "matcher": "Write" }
       ]
     }
   }
   ```

   (If `${CURSOR_PLUGIN_ROOT}` did not work in step 1, use the full path.)

3. Reload the window, then ask the agent to create a new file `app/pages/BlockTest.tsx` with any content.

Report:
- Was the write refused? Did the agent see "invariant test block"?
- Send the contents of `/tmp/cursor-pretool-payload.json`. It shows the exact shape of a Write for `preToolUse`, which is what a real blocking hook needs.
- If nothing happened, try the matcher `"Write|Edit"`, or remove the `matcher` line, and say which worked.

When you are done, restore the original `hooks/hooks.json` (unzip the plugin again) and delete `block-test.sh`.

## 5. Send back

A short note with: Cursor version, then the results of steps 0 to 4, plus the payload file from step 4. With those, the Cursor plugin can be corrected (variable names, tool names), and if step 4 shows blocking works, `invariant hook --client cursor` gets a `preToolUse` mode and the support matrix changes from "no" to "yes".

## What each result changes

| Result | Change |
| --- | --- |
| Step 1 fails | The Cursor skills name the launcher another way (for example a path the setup step writes). |
| Step 2 tool names differ | The Cursor skills use those names. |
| Step 3 does not run | The `afterFileEdit` command shape is corrected. |
| Step 4 blocks | Add a `preToolUse` hook that denies on errors, like Claude Code. The website says "blocks writes" for Cursor. |
| Step 4 does not block | Cursor stays feedback-only, and the website says so (it already does). |
