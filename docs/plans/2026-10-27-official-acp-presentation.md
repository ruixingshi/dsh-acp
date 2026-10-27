# Official ACP presentation implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the official Harness ACP the only implementation and enable plans, titles, and tool categories by default.

**Architecture:** Launch the shipped ACP profile with an internal overlay selecting our Cordis plugin. The plugin calls the official ACP plugin with an ordered transport decorator, reads Harness's registered `title` and `todos` projections, and adds standard ACP notifications only for successfully activated sessions. Official code continues to own all request handlers, agents, prompt settlement, cancellation, persistence, and teardown.

**Tech Stack:** TypeScript, Node.js, Cordis, Harness 0.2.1-rc.4, ACP SDK 1.4.0, Vitest.

## Task 1: Prove the default composition

- Add `assets/acp.patch.yml`, replace `src/plugin.ts`, and simplify `src/bin.ts` to always use the official profile.
- Add direct dependencies only for the official ACP plugin and the Harness services/types the presentation plugin consumes.
- Disable the official `acp` row and insert `dsh-acp` with the same startup dependency and route. Cordis treats patch `name` as a match guard, so custom ACP settings migrate to the `dsh-acp` target; verify subsequent user overlays configure it.
- Reject removed `--config` with migration guidance; ignore an incidental working-directory `cordis.yml`.
- Run `pnpm build` and the focused CLI/profile tests against the built executable.

## Task 2: Add presentation without taking over sessions

- Replace `src/projector.ts` with pure mappings for `title`, `todos`, and tool names.
- Create `src/presentation-stream.ts`: correlate successful session/new, session/resume, and session/close responses; retain exact live Session identity only for display subscriptions; serialize original frames and added notifications through one writer.
- Use `sessionProjections.snapshot()` and `onChanged()` for consistent restore/live values. A cleared todo projection sends an empty ACP plan. New/resume replies precede their initial display updates.
- Preserve all upstream errors, capability declarations, request ids, model controls, permissions, and output content. Unknown or failed activations never publish display updates. Disconnect removes subscriptions and makes transport failure visible to the official connection.
- Unit tests cover ordering under blocked writes, output failures, session isolation, failed activation, close/resume identity changes, and duplicate suppression. Run the focused tests before and after implementation.

## Task 3: Verify the real launcher lifecycle

- Extend `tests/fixtures/official/llm.mjs` to exercise real `todo_write` and `read` tools deterministically.
- Extend `tests/official-profile.e2e.spec.ts` to verify default plans/titles/tool categories, restart/resume snapshots, plan reset, model changes, MCP permissions, cancel then immediate prompt, provider failure then immediate prompt, concurrent sessions, and closing active work.
- Keep stdout exclusively JSON-RPC; verify EOF exits after teardown.
- Add an installed-tarball smoke so the internal overlay and plugin resolve outside the repository.

## Task 4: Remove the previous adapter and document migration

- Delete `src/acp-agent.ts`, `src/server.ts`, `src/harness-runtime.ts`, `src/runtime.ts`, `src/model-options.ts`, `src/codec.ts`, their obsolete tests, and legacy CLI fixtures.
- Replace root exports with the official-backed Cordis plugin and version; remove the `./runtime` export and unused dependencies. Clean `dist` during build so removed modules cannot ship.
- Update README.md, README.zh.md, README.en.md and an architecture decision documenting the single implementation, supported capabilities, title fallback behavior, configuration/API migration, and unchanged first-phase limits.
- Run `pnpm check`, packaging smoke, and `git diff --check`. Review teardown/ordering paths and document exactly what was exercised.

## Task 5: Add history titles and release (follow-up request)

- Decorate only successful official `session/list` responses. Keep the official selection, order, cursor, errors, and any upstream title intact.
- Read metadata through `sessionPersistence.stat` and title hints through `sessionProjectionCache.cachedSnapshot` / `cachedPredecessorTitle`. Never activate an Agent or open full logs for a history list. Missing checkpoints leave the title absent; individual read errors log a warning and preserve the row.
- Reserve the response position in the shared output queue before asynchronous reads. Cancel those reads on disconnect or disposal; retain official lifecycle ownership.
- Cover restart, pagination, cwd filtering, untitled sessions, upstream titles, unavailable metadata, predecessor hints, slow reads, and cancellation with focused and built-process tests.
- Update the READMEs, ADR, and 0.6.0 release notes, review the complete release, verify a freshly installed tarball, then commit, publish npm 0.6.0, and push the commit and release tag to GitHub.
