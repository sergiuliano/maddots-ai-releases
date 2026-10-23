These are synthetic fixtures written against the installed OpenCode 1.19.0 run
serializer, inspected on 2026-10-21. `run --help` verified `--pure`, `--dir`,
`--format json`, `--auto`, `-m provider/model` and `--variant`. Embedded source
verified stdin input, config precedence, project-config and external-skill flags,
the `step_start`, `text`, `reasoning`, `tool_use`, `step_finish`, `error` events,
and the managed configuration merged after the inline overlay.

The fake does not implement OpenCode. Its canary only proves the test harness's
positive/negative logic. Real Ollama execution, staged skill visibility, MCP
startup silence and permission behavior still require The Machine acceptance.
The adapter refuses Folder only pending the actual shell/file confinement probes
and R-02 decision. Generic provider secrets are unavailable in the current core;
OpenRouter and all hosted/custom endpoints remain sync only until an approved
core secret path exists. Round 2 preserves HOME, including during identity
checks, and isolates XDG configuration, data, cache and state only for local
Ollama or LM Studio. No saved auth is read or copied. The installed v1 has no
no-history/ephemeral run flag; its new session stays in run-only XDG data.

The pinned source always enumerates `~/.opencode`, even when project config is
disabled. The adapter refuses when that directory exists rather than reading it
or allowing native dependency setup to write there. Reported MCP inventories
are rejected in addition to unexpected tool events. Completed `skill` events
must name the staged skill and its exact directory to count as loading proof;
their tool output provides separate marker proof. The probe's read-only database
reader obtains provider/model metadata from assistant messages of this exact
stream session under the run-only XDG data folder. It rejects model ambiguity,
session mismatches and linked paths, and never searches personal OpenCode data.
