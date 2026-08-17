# DeepSeek Harness ACP Adapter Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a TypeScript/Node ACP v1 package that drives DeepSeek Harness agents and faithfully exposes model selection, reasoning, messages, tools, plans, permissions, and cancellation.

**Architecture:** A protocol-facing `DshAcpAgent` owns ACP handlers and delegates all Harness operations to a narrow `HarnessRuntime`. `CordisHarnessRuntime` creates real agents through `ctx.agents`, installs scoped model selection, and projects authoritative Harness events into typed adapter events. A plugin binds the server to stdio, while a CLI boots a deployment-owned Cordis configuration.

**Tech Stack:** Node.js 22+, TypeScript strict ESM, pnpm, `@agentclientprotocol/sdk` 1.3.x, DeepSeek Harness 0.1.0 release candidates, Vitest, ESLint, Prettier.

---

### Task 1: Scaffold the package and quality gates

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `eslint.config.js`
- Create: `.prettierrc.json`
- Create: `.gitignore`
- Create: `src/index.ts`

**Steps:**

1. Declare the `@dumbo/dsh-acp` package and `dsh-acp` bin, ESM exports, Node 22 engine, ACP SDK dependency, Harness dependencies, and test/build scripts.
2. Configure strict TypeScript with NodeNext resolution and declaration output.
3. Install dependencies with `pnpm install`.
4. Run `pnpm typecheck`; expect a successful empty-project baseline.

### Task 2: Define runtime and session contracts

**Files:**

- Create: `src/runtime.ts`
- Create: `src/session.ts`
- Test: `tests/session.spec.ts`

**Steps:**

1. Write failing tests for exact session ownership, one prompt slot, stale-turn rejection, and idempotent settlement.
2. Define provider/model/reasoning metadata, runtime event unions, agent handles, prompt tickets, and the `HarnessRuntime` interface.
3. Implement the session record and controller with exact identity and prompt correlation.
4. Run `pnpm test tests/session.spec.ts`; expect all session tests to pass.

### Task 3: Implement model config options

**Files:**

- Create: `src/model-options.ts`
- Test: `tests/model-options.spec.ts`

**Steps:**

1. Write failing tests for provider groups, duplicate model ids across providers, an out-of-catalog current route, model changes, and reasoning fallback.
2. Encode model values as provider-qualified opaque ids and build the ACP `model` select with provider groups.
3. Build the `reasoning_effort` select from exact-model metadata.
4. Return the complete replacement `configOptions` list after every accepted change.
5. Run `pnpm test tests/model-options.spec.ts`; expect all model tests to pass.

### Task 4: Implement ACP content and update projection

**Files:**

- Create: `src/codec.ts`
- Create: `src/projector.ts`
- Test: `tests/codec.spec.ts`
- Test: `tests/projector.spec.ts`

**Steps:**

1. Write failing tests for text/resource prompts, empty and unsupported content, assistant text, reasoning, tool start/result, malformed arguments, plan snapshots, usage, and terminal reasons.
2. Convert supported ACP prompt blocks into one Harness user message without protocol metadata.
3. Map Harness stream and durable events to ACP session updates without duplicating text.
4. Preserve malformed tool input as raw text and always emit a terminal tool update.
5. Run the focused codec and projector tests; expect all cases to pass.

### Task 5: Implement the protocol agent

**Files:**

- Create: `src/acp-agent.ts`
- Test: `tests/acp-agent.spec.ts`

**Steps:**

1. Write failing handler tests for `initialize`, `session/new`, `session/set_config_option`, `session/prompt`, `session/cancel`, permission callbacks, and unknown sessions.
2. Advertise ACP v1 prompt and session-config capabilities with accurate unsupported surfaces omitted.
3. Create sessions through `HarnessRuntime`, return config options from `session/new`, and apply model/reasoning changes through the session selection.
4. Drive one prompt per session and settle it from correlated runtime events.
5. Forward one-shot permission choices and contain update failures.
6. Run `pnpm test tests/acp-agent.spec.ts`; expect all handler tests to pass.

### Task 6: Bind the real Harness runtime

**Files:**

- Create: `src/harness-runtime.ts`
- Test: `tests/harness-runtime.spec.ts`

**Steps:**

1. Write failing integration tests using a real Cordis context, Agent registry/loop testkit, and scripted LLM.
2. Discover providers with `ctx.llm.listProviders`, models with `listModels`, and exact reasoning metadata with `resolveModelInfo`.
3. Create each agent with `ctx.agents.create` and install `installModelSelection` in its unpublished scoped setup.
4. Subscribe to `session/event`, `agent/inbox/claimed`, `agent/status`, `agent/error`, and `approval/request`, routing only exact owned agents.
5. Verify that a model config change affects the next request header and prompt variable together.
6. Run `pnpm test tests/harness-runtime.spec.ts`; expect all integration tests to pass.

### Task 7: Add plugin, stdio server, and CLI

**Files:**

- Create: `src/plugin.ts`
- Create: `src/server.ts`
- Create: `src/bin.ts`
- Create: `examples/cordis.yml`
- Test: `tests/protocol.spec.ts`
- Test: `tests/cli.e2e.spec.ts`

**Steps:**

1. Write an in-memory ACP SDK test covering real JSON-RPC initialize, session creation, model rendering, prompt updates, and cancellation.
2. Register ACP SDK 1.x request and notification handlers and connect them to the SDK NDJSON stream.
3. Export a Cordis plugin whose configuration supplies the initial provider/model and optional test stream.
4. Add a `dsh-acp --config` executable using Harness app boot; reserve stdout for protocol frames.
5. Add a complete example composition and a built-bin smoke test.
6. Run the protocol and CLI tests; expect valid ACP responses and clean EOF teardown.

### Task 8: Document and verify the release surface

**Files:**

- Create: `README.md`
- Create: `README.zh.md`
- Modify: `package.json`

**Steps:**

1. Document installation, Zed/client configuration, Cordis composition, exported APIs, supported ACP methods and updates, model selection semantics, and phase-two limitations.
2. Run `pnpm format` and inspect the diff.
3. Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`.
4. Run `git diff --check` and verify no generated build output is tracked.
