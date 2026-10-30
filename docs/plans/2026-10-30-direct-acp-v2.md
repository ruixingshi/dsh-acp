# Direct ACP v1/v2 implementation plan

Status: Completed in 0.7.0. Validation is recorded in [the release verification](../validation/2026-10-30-acp-v2.md).

**Goal:** Serve ACP v1 and the experimental ACP v2 directly from DeepSeek Harness, preserving existing clients without invoking the official Harness ACP server.

**Architecture:** One Harness session runtime owns agent creation, persistence, prompt admission, cancellation and quiescent teardown. Separate SDK v1/v2 handlers negotiate one version per connection and project the same runtime events into that protocol. The packaged Harness profile remains the composition and configuration entrypoint.

**Tech stack:** TypeScript, Node.js 24, ACP TypeScript SDK 2.1.0, pinned Harness 0.2.1-rc.4, Cordis, Vitest.

## Decisions

- Keep both v1 and v2, as requested. Use the SDK protocol router rather than inventing JSON-RPC framing or translating v2 requests into v1 ACP.
- Keep the current Harness release during the protocol migration. Upstream Harness upgrades remain separate compatibility changes.
- Keep existing launch command, environment variables and `--patch` configuration. Disable the official ACP plugin; our plugin invokes public Harness Agent services directly.
- Implement v2 foreground state, identified messages/tool upserts, plan updates, titles, model configuration, permissions, list/resume/close and stdio/HTTP MCP. Advertise only implemented capabilities; v2 alone does not imply experimental MCP-over-ACP.
- Preserve v1 plans, titles, list titles, model selection, MCP, permissions, persistence and cancellation. Remove the relay and its transport decorator.

## Task 1: SDK negotiation and dependencies

Update `package.json` and `pnpm-lock.yaml` to use SDK 2.1.0 and explicit public Harness runtime dependencies. Add wire tests for v1/v2 negotiation, unsupported versions and pre-initialization calls. Retain SDK validation and framing.

## Task 2: Direct Harness runtime

Implement shared configuration, model selection, content admission, MCP mounting, session creation/resume/list and prompt lifecycle modules. Add regressions for failure followed immediately by another prompt, cancellation, active close, EOF and independent sessions. Check original upstream lifecycle behavior before replacing it.

## Task 3: Protocol projections

Implement v1 and v2 output projection from durable Harness events and validated title/todo projections. V2 prompt acceptance and foreground completion are separate. Serialize state, tool, permission and content updates; ensure all work is quiescent before idle/close. Send current state before a successful v2 resume response.

## Task 4: Client compatibility

Preserve existing built-profile tests and add equivalent SDK v2 tests for plans, titles, model/reasoning selection, MCP, permission state, persistence, resume, errors and cancellation. Add protocol conformance checks where available. Verify v2 history replay from the start through public persistence readers; reject unsupported replay cursors. Do not advertise other unimplemented optional features.

## Task 5: Packaging and review

Delete the old presentation relay. Update Chinese/English READMEs and architecture documentation. Run typecheck, lint, build, unit and process tests; exercise a packed artifact outside the source tree. Review changed lifecycle and protocol paths. Keep all changes on `codex/acp-v2`; publication is a separate operation.
