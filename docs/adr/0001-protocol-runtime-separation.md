# ADR 0001: Separate ACP protocol handling from the Harness runtime adapter

- Status: Accepted
- Date: 2026-08-17

## Context

The existing Harness ACP plugin directly mixes ACP handlers, Harness session ownership, event translation, permission callbacks, and stdio lifecycle. It intentionally exposes only committed text for automation and uses ACP SDK 0.25.1, so clients cannot render the model selector and other modern ACP surfaces. A replacement must track ACP 1.x without forcing protocol-specific concepts into the Harness agent loop.

## Decision

Implement three layers:

1. An ACP protocol server built on `@agentclientprotocol/sdk` 1.3.x.
2. A session controller expressed against a narrow runtime interface.
3. A Cordis/Harness adapter that implements that interface through `ctx.agents`, `ctx.llm`, session events, agent events, and the approval waterfall.

Model selection is installed per Agent with Harness `installModelSelection`. ACP session config options expose provider-qualified models and the selected model's reasoning efforts. The package exports the Cordis plugin and the lower-level protocol types, while a CLI boots a deployment-owned Cordis configuration.

## Consequences

Protocol behavior can be tested without a live model or complete Harness composition. Harness upgrades are isolated to the runtime adapter, while ACP SDK changes are isolated to protocol registration and update projection. The extra interface layer adds several small modules, but prevents a second monolithic bridge and makes event ordering explicit.

The first release does not implement persisted session operations. Adding them requires a separate ADR covering session query, replay ordering, resume-time model selection, and deletion ownership.

## Alternatives considered

- Enhance the existing automation plugin: rejected because its documented policy deliberately omits presentation surfaces and it remains tied to the Harness monorepo release cadence.
- Proxy the existing ACP process: rejected because committed-text output has already discarded reasoning, tool, plan, and model-selection information.
- Modify the Harness agent loop: rejected because public registries, scoped model selection, and session events already provide the required extension points.
