# Jcode

[Jcode](https://github.com/1jehuang/jcode) is an open-source coding agent. Paseo's bundled `jcode` provider uses its native RPC API instead of ACP. It supports session import and history, models, reasoning effort and swarm choices, commands, subagents, and active-turn steering. Paseo also supplies terminal activity hooks, shared skills, and caller-scoped tools.

## Terminal activity hooks

With **Settings > Terminals > Enable terminal agent hooks** on, Paseo adds activity hooks to Jcode's `[hooks]` table in `~/.jcode/config.toml` (or `$JCODE_HOME/config.toml`):

| Jcode hook      | Terminal activity |
| --------------- | ----------------- |
| `session_start` | running           |
| `post_tool`     | running           |
| `turn_end`      | idle              |
| `session_end`   | idle              |

Jcode has no notification-style event, so Paseo cannot show a needs-input state for it.

Jcode executes hook commands directly, without a shell, so the installed command has no shell gate. It relies on the same guards the other agents use: `paseo hooks` exits immediately when `PASEO_TERMINAL_ID` is unset, so the hooks are inert outside Paseo terminals, and Paseo puts its own `paseo` CLI first on the terminal `PATH`.

Paseo only ever edits lines it wrote itself, matched by exact value. It never overrides a key you have set; a key you claimed stays yours and that event simply goes unreported. It also refuses to touch configurations it cannot safely recognize, including CRLF files, multiline strings, or alternative hooks-table spellings such as `[hooks] # comment`, `["hooks"]`, root `hooks = {…}`, and `hooks.x = …`. Turning the setting off removes exactly Paseo's lines and leaves everything else as it was.

## Skills

Jcode loads global skills from `~/.agents/skills/`, the same cross-tool directory Paseo's skill sync targets (see [skills](skills.md)). Installing Paseo's skills makes them available in Jcode with no Jcode-side setup; Jcode also discovers them on its own at startup.

## What Jcode does not have

Jcode has no plugin system. There is nothing to map onto Paseo plugin surfaces: tool integrations reach Jcode through its native SDK contract instead, and Jcode does not support per-session MCP servers or custom session environment configuration.

## Provider limitations

The `jcode` provider runs Jcode over its native stdio bridge (`jcode --quiet --no-update api-bridge --stdio`), not JSON-RPC or ACP, so what Paseo can offer is bounded by what that bridge exposes:

- **Permissions.** The native bridge does not expose permission responses or exact MCP-tool preapproval. Paseo rejects requests requiring these capabilities, including unattended Hub execution. Jcode's own safety controls still apply.
- **Commands.** Paseo exposes model, effort, compact, rename, cancel-steers, and background as direct bridge calls. The bridge has no generic slash-command catalog.
- **Effort and models.** Read-only `jcode model list --json` discovery preserves available authentication routes. When CLI labels omit custom profile IDs, Paseo briefly attaches to an existing session for native route metadata without changing it or creating a probe session. Unresolved routes stay disabled. Swarm and Deep swarm appear in the effort selector as orchestration choices. The native setter validates each selection, and runtime information supplies the committed value. Effort cannot be cleared back to unset; pick an explicit level.
- **History.** Session history is flattened, with no durable message IDs, so rewind is not available. Importing a session that is mid-turn has no atomic snapshot point, so the merged history can contain duplicated content from the concurrent stream.
- **Imported sessions.** Attaching preserves the native model and effort. Paseo registers its scoped tool callbacks before the next idle foreground prompt, not while another client owns a turn. Paseo's system instructions accompany foreground prompts as a system reminder rather than replacing Jcode's assembled project instructions.
- **Subagents.** Child sessions are discovered by polling and expose list-level metadata only; historical swarm state can be stale and child history is less detailed than the parent's.
- **Steering and follow-ups.** Interleaved input uses native `soft_interrupt` at a safe point. Use Paseo's existing follow-up queue for a separate later turn. Stopping clears undelivered native interleaves before calling `cancel`; admission races remain bounded by the bridge's native guarantees.
- **Env.** Per-session custom environment variables and MCP servers are rejected; only `PASEO_AGENT_ID` and working-directory metadata pass through, and Jcode ignores them.

The provider closes only its owned stdio bridges, never the shared Jcode daemon. A lost connection makes in-flight results uncertain; Paseo does not automatically resend them. Linux is verified locally. Other host platforms and mobile rendering are not verified in that run.
