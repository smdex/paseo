# Jcode native provider QA

Run on October 7, 2026, against installed Jcode v0.90.0 on Linux x86_64. The implementation is based on upstream `4dd0e50e7`. The logs in this directory are raw command output, not screenshots or mocked provider acceptance.

## Real provider checks

The local acceptance scripts exercised `PluginAgentClientRegistry` with `createJcodeProvider`, so requests passed through Paseo's shared adapter and the real native stdio bridge. They created dedicated test sessions and archived those sessions afterward. They did not edit project files, replace global Jcode configuration, restart either shared daemon, or archive pre-existing sessions.

| Output              | Check                                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-routes.txt`   | Canonical `zai:glm-5.3-flash` route remains selected after Swarm, Deep swarm, and Low effort changes. Exact effort runtime readback, full response, history resume, import discovery, archive. |
| `live-tools.txt`    | Exactly one safe custom tool call, real Zod argument validation, and exact nonce response through the caller-scoped Paseo tool bridge.                                                         |
| `live-steering.txt` | A safe custom tool pauses an active turn. Native interleave is accepted for that turn, and the final response uses the new instruction after the tool returns.                                 |

Commands:

```sh
node --import tsx "$JCODE_SCRATCH_DIR/paseo-jcode-live-acceptance.ts"
node --import tsx "$JCODE_SCRATCH_DIR/paseo-jcode-live-tools.ts"
node --import tsx "$JCODE_SCRATCH_DIR/paseo-jcode-live-steer.ts"
```

The scripts are local acceptance harnesses, not installed test jobs. The existing provider test suite owns repeatable automated regressions.

## Automated checks

`native-regressions.txt` records 17 native-provider cases. A later focused invocation added one canonical custom-route regression, passing with the previous 17 skipped. Independent source review covered the native lifecycle, tool bridge, final-text reducer, and hook editor. No confirmed P1/P2 remained in that review.

Other focused results reported by their owners:

- Shared native tool bridge: 49 tests passed, followed by focused launch-negotiation, scope, and availability regressions.
- Real plugin subprocess IPC: 41 tests passed, including native tool definitions, calls, cancellation, and results. See `plugin-subprocess.txt`.
- Shared assistant final-text reducer: four parameterized cases passed after reproducing truncation before the fix.
- Jcode hooks: 13 tests passed. Existing registry, Codex hooks, and CLI hooks passed 1, 8, and 23 tests respectively.

`build.txt`, `typecheck.txt`, and `lint.txt` record the final rebased checkout checks:

```sh
npm run build:server
npm run typecheck
npm run lint -- --ignore-pattern '.devenv/**'
```

The lint exclusion covers checkout-local generated Nix profile files, not product source. The build also verified that the production distribution includes the Jcode provider and hooks. Formatting excluded the user's pre-existing lockfile and Nix environment files. SHA256 fingerprints confirmed those files were restored unchanged after rebasing.

## Coverage limits

| Platform             | Tested | Notes                                                                  |
| -------------------- | ------ | ---------------------------------------------------------------------- |
| Linux host           | Yes    | Native provider, real tool callbacks, real steering, production build. |
| Linux Electron UI    | No     | No renderer workflow or screenshots.                                   |
| macOS host/Desktop   | No     | No host hardware or runtime-loader verification.                       |
| Windows host/Desktop | No     | Windows plugin runtime loader not exercised.                           |
| Browser web          | No     | No UI workflow.                                                        |
| iOS                  | No     | No device or simulator workflow.                                       |
| Android              | No     | No device or emulator workflow.                                        |

Swarm and Deep swarm setters and readback were verified, not expensive orchestration execution. Child discovery, admission/cancel/close races, and scope isolation have fixture-backed regressions, not a real multi-agent acceptance run. Existing Paseo follow-up queuing is reused and was not exercised end to end in this run. Busy import has no atomic native history snapshot, so concurrent overlap remains a documented limitation. See [the Jcode provider guide](../../../public-docs/jcode.md) for the capability limits.

## Remote delivery

The branch is `feat/jcode-native-rpc`. Push was attempted with the fork owner's active GitHub credentials and rejected because its OAuth token lacks `workflow` scope for upstream workflow changes. The remote fork's main remains `b5b43edd6`; no PR or remote merge exists. Local main was fast-forwarded to upstream `4dd0e50e7`. No credential changes or authorization bypass were attempted.
