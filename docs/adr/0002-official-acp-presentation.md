# ADR 0002: Official ACP with default presentation

Status: Shipped in 0.6.0; superseded in 0.7.0 by [ADR 0003](0003-direct-acp-v1-v2.md).

## Decision

The only session implementation is `@deepseek-ai/dsh-acp` pinned to the same release as `@deepseek-ai/dsh`. Our Cordis plugin calls its exported `apply` with its existing runtime `stream` option. It does not import private session classes, fork upstream source, implement request handlers, run Agents, or decide when a prompt has ended.

The launcher starts the official `acp` profile with a packaged overlay. The overlay disables its `acp` entry and inserts `dsh-acp`, retaining the official startup dependency and default route. Cordis patch `name` is a match guard, not a replacement operation, so model-setting overlays migrate to `id: dsh-acp`. Explicit `--config` is rejected with migration guidance and incidental working-directory configuration is ignored. There is no legacy fallback.

## Display ownership and ordering

The transport records only the request ids needed to observe official new/resume/close/list replies. Success establishes ownership of the exact live Harness Session object for display; errors never create ownership. Other sessions and subagents are excluded. An activation response precedes its initial projection snapshot; a successful close response removes display ownership. A stale Session instance never becomes current merely because its id matches.

Initial and restored titles/todos use `sessionProjections.snapshot`; live updates use the same registry's validated change feed. A per-key watermark avoids replaying events already covered by a snapshot. The todo projection resets on Harness turn/start, producing an empty ACP plan. The official title service owns fallback and optional model-generated titles.

Original frames and added notifications share one output queue. Added writes already accepted by this queue drain before a later upstream response reaches the client; original upstream frames retain their own order. This queue does not replace the official per-session queue or prompt lifecycle. Any write failure poisons subsequent writes and closes the official input, so the official connection cancels and disposes its work instead of sending a successful prompt response after lost presentation data.

Cordis cleanup awaits the official quiescence effect before releasing the display transport. Input disconnect removes the display subscription; transport disposal waits for pending writes before releasing locks. The underlying input/output streams remain caller-owned.

## History list titles

Only rows in the official response page are enriched. `sessionPersistence.stat` provides each row's lifecycle metadata; `sessionProjectionCache.cachedSnapshot(header, ['title'])` reads the existing title checkpoint. The official `cachedPredecessorTitle` reader can supply a compatible predecessor title. These reads do not open event logs or activate sessions. Unavailable checkpoints leave the original row untitled; a failed metadata read emits a warning and leaves that row intact. The cache can lag the persisted log, as in Harness's own history list.

The list response reserves its output-queue position before metadata reads begin. Disconnect and transport disposal abort those reads, then the queue drains without creating display ownership. Upstream title fields, errors, and all other response metadata are preserved.

## Compatibility

Standard ACP v1 plans and session-info updates are added; generic tool calls receive an inferred kind, while explicit upstream categories and other content remain intact. Capabilities, model controls, MCP, permission requests, errors, persistence, and cancellation remain official. No v2, transcript replay, forks, terminal protocol, slash commands, or elicitation are added in this phase. Successful session-list responses additionally carry cached title hints; official filtering, sorting, pagination, and existing titles remain intact.

The old server/runtime APIs and their implementations are removed. Root and `./plugin` expose the official-backed Cordis plugin; `./runtime` is removed. Building clears dist so deleted modules cannot survive into the published artifact.

## Validation

Pure mapping and transport tests cover initial replay ordering, blocked writers, write failure, exact-session isolation, failed activation, duplicate resume, stale instances, plan resets, and draining disposal. List tests cover title hints, missing caches, predecessor reads, individual read failures, output ordering, and disposal during reads. Built-process tests cover restart/list titles, pagination, cwd filtering, untitled sessions, default presentation, real todo/read tools, model/reasoning changes, MCP permissions, usage, restart/resume, cancellation, failed/admission-rejected prompts followed immediately by new work, concurrent sessions, active close, and EOF. The packaged artifact is also exercised outside the source directory before release.
