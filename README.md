# DeepSeek Harness ACP Adapter

An editor-oriented ACP v1 adapter for DeepSeek Harness. It keeps the original Harness pattern for creating and driving agents, while rebuilding the protocol layer on the current ACP TypeScript SDK so clients can render models, reasoning effort, thoughts, tools, plans, usage, and permission requests.

[中文文档](README.zh.md)

## Features

- Provider-grouped model and model-specific reasoning selectors through standard ACP session config options.
- Provider-qualified model values, including a configured current model that is absent from an advisory catalog.
- Streamed assistant and thought chunks, correlated tool cards and results, plan snapshots, context usage, and session title updates.
- One-shot Harness approval requests projected to ACP permission choices.
- One exact Harness Agent per ACP session, created through `ctx.agents.create` and configured with `installModelSelection`.
- Per-session cancellation and close plus idempotent connection teardown.

## Development

Requires Node.js 22.19 or newer and pnpm.

```bash
pnpm install
pnpm check
```

The protocol and Harness integration suites run without an API key.

## Run

Use the minimal composition in [examples/cordis.yml](examples/cordis.yml), or add the plugin to an existing Harness Cordis tree:

```yaml
- id: rich-acp
  name: 'deepseek-harness-acp'
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
    reasoningEffort: max
```

Then start the stdio server:

```bash
export DEEPSEEK_API_KEY='...'
pnpm exec dsh-acp --config /absolute/path/to/cordis.yml
```

The CLI defaults to `./cordis.yml`, loads the Harness environment setup, and reserves stdout for ACP JSON-RPC frames.

For Zed, add a custom External Agent:

```json
{
  "agent_servers": {
    "deepseek-harness": {
      "type": "custom",
      "command": "/absolute/path/to/node_modules/.bin/dsh-acp",
      "args": ["--config", "/absolute/path/to/cordis.yml"],
      "env": {}
    }
  }
}
```

See the current [Zed External Agents documentation](https://zed.dev/docs/ai/external-agents) for its custom-agent settings.

## ACP coverage

Supported methods are `initialize`, `session/new`, `session/set_config_option`, `session/prompt`, `session/cancel`, and `session/close`. Prompt input currently accepts text and `resource_link`; image, audio, embedded context, client-provided MCP servers, and additional directories are not advertised or accepted.

The first release creates fresh sessions only. Session list/load/resume/fork/delete and agent-managed authentication remain future work. Unsupported capabilities are omitted from `agentCapabilities`.

## Library API

The package exports `DshAcpServer`, `DshAcpAgent`, `CordisHarnessRuntime`, the protocol-neutral `HarnessRuntime` and `RuntimeSession` interfaces, and the Cordis `apply`/`Config` plugin entry points.

Architecture and rationale are recorded in the [design](docs/plans/2026-08-17-acp-adapter-design.md) and [ADR 0001](docs/adr/0001-protocol-runtime-separation.md). The implementation targets the official [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) and its standardized [session config options](https://agentclientprotocol.com/rfds/session-config-options).

## License

Apache-2.0
