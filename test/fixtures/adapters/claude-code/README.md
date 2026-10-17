# Claude Code adapter fixtures

These are synthetic, documented-format fixtures for TLS-26, not real Claude Code captures. They follow `data/tools-run.json` (checked 2026-10-14), `jsonOutput`, and BRIEF-C2 sections 4.7 and 11. The brief selects `stream-json` with `--verbose` so each line is a JSON event, the `system/init` lists servers and tools, and the final `result` supplies the answer. Claude must replace these with real captures during the TLS-36 acceptance run.

`success.ndjson`, `failure.ndjson`, `empty.ndjson` and `mcp.ndjson` describe success, an execution error, an empty answer and a forbidden server/tool list. `fake-cli.mjs` is a local executable fixture used for `--version` identity checks and the real runner process path. It reads only its temporary test prompt and staged plugin, with no network or installed AI tool.

The adapter uses a final argument pointing to `prompt.md`. Its interface declares `promptVia: file`, because `RunSpec` does not contain prompt text and `build()` performs no I/O. This also avoids the core's inline-prompt replacement path rejecting prompts above 64 KiB.

TLS-25's `stageSkills` must create `{runDir}/plugin/.claude-plugin/plugin.json` containing `{"name":"maddots-run"}` and place verified skills under `{runDir}/plugin/skills` before `startTool`. The plugin carries no MCP config, hooks or commands. Current core `files` are restricted to `config/`, and project staging rejects `.maddots/`, so the adapter does not try either route to write the plugin. The integration test stages this contract explicitly; it does not prove that TLS-25 or a real Claude CLI loads the plugin.

Real-tool checks remain required for plugin skill discovery and decoy isolation, no-MCP canaries (including installed plugin servers and claude.ai connectors), Folder only writes through Bash and file tools, standalone installation identity, and unchanged Git status. `--setting-sources project,local` is not emitted without the R-05 canary evidence required by the brief. These fixtures do not permit offering the adapter in the production matrix.
