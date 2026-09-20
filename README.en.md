# DeepSeek Harness ACP

`@dumbo-ai/dsh-acp` provides a stable `npx` entry point for the official DeepSeek Harness ACP application. Version 0.4.0 uses DeepSeek Harness `0.1.6-alpha.1` and its maintained `acp` profile by default, while retaining the package's earlier TypeScript adapter API and complete-Cordis configuration mode for existing integrations.

[中文文档](README.md)

## Quick start

Requires Node.js `^22.19.0` or `>=24.0.0`.

```bash
export DEEPSEEK_API_KEY='...'
npx --yes @dumbo-ai/dsh-acp
```

The default command starts the official DeepSeek Harness ACP profile. That profile owns the coding tools, sandbox and permission policy, model catalog, persistent sessions, MCP integration, and ACP lifecycle.

The launcher recognizes these environment variables:

- `DEEPSEEK_API_KEY`: DeepSeek API key.
- `DEEPSEEK_BASE_URL`: optional DeepSeek-compatible endpoint inherited by the Harness process. Custom endpoints are preserved. For the official DeepSeek service, omit this variable or use `https://api.deepseek.com/anthropic`; the old API-root override is no longer appropriate for the default Messages route.
- `DSH_HOME`: optional Harness state, settings, credentials, sessions, and profile directory.
- `DSH_PERMISSION_MODE`: optional Harness permission preset such as `read-only`, `workspace-write`, or `danger-full-access`.

Harness also supports its managed settings and credential files under `DSH_HOME`.

## Customize the official profile

Pass one or more patch-list overlays with `--patch`. Later patches win. The repository includes [examples/acp.patch.yml](examples/acp.patch.yml):

```yaml
- id: acp
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
```

Start with that patch:

```bash
npx --yes @dumbo-ai/dsh-acp --patch /absolute/path/to/acp.patch.yml
```

A patch replaces the targeted row's complete `config`, so include every field that row needs.

## Legacy complete-Cordis mode

For compatibility, an explicit `--config` starts the package's original rich adapter inside a complete Cordis tree:

```bash
npx --yes @dumbo-ai/dsh-acp --config /absolute/path/to/cordis.yml
```

A `cordis.yml` in the launch directory selects the same legacy mode automatically. `--patch` cannot be combined with either legacy path. A legacy file must define the whole Harness composition; it is not an overlay for the official profile.

The adapter's Cordis entry is:

```yaml
- id: rich-acp
  name: '@dumbo-ai/dsh-acp'
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
    reasoningEffort: max
```

The CLI reserves stdout for ACP JSON-RPC frames and sends diagnostics to stderr.

## ACP coverage in the default mode

The default official profile supports:

- ACP v1 initialization and authentication.
- Creating, listing, resuming, prompting, cancelling, and closing persistent sessions.
- Standard model and reasoning-effort configuration options.
- Ordered text and resource links, plus supported raster images when the selected model route accepts images.
- Standard stdio and Streamable HTTP MCP server declarations, MCP protocol negotiation and paginated tool discovery, including servers that expose no tools.
- Shared MCP resource discovery, direct reads, and URI-template completion supplied by the Harness profile.
- Committed message and thought updates, generic tool lifecycle, configuration changes, context usage, and permission requests.
- Prompt and close settlement only after the Harness Agent and ordered update stream become quiescent.

It does not support session load, deletion or fork, additional directories, audio, embedded context, ACP modes or commands, plans, terminals, client filesystem operations, or elicitation. Unsupported capabilities are omitted or rejected according to ACP.

## Zed

Add a custom External Agent:

```json
{
  "agent_servers": {
    "dsh-acp": {
      "type": "custom",
      "command": "npx",
      "args": ["--yes", "@dumbo-ai/dsh-acp"],
      "env": {
        "DEEPSEEK_API_KEY": "..."
      }
    }
  }
}
```

Add `"--patch", "/absolute/path/to/acp.patch.yml"` to `args` when needed. See the current [Zed External Agents documentation](https://zed.dev/docs/ai/external-agents).

## Library API

The package continues to export `DshAcpServer`, `DshAcpAgent`, `CordisHarnessRuntime`, the protocol-neutral `HarnessRuntime` and `RuntimeSession` interfaces, and the Cordis `apply`/`Config` plugin entry points. These exports implement the retained compatibility adapter; the zero-argument CLI uses the official Harness ACP implementation.

```ts
import { DshAcpServer, type HarnessRuntime } from '@dumbo-ai/dsh-acp'

const runtime: HarnessRuntime = createRuntime()
const server = new DshAcpServer(runtime, {
  initialSelection: { provider: 'my-provider', model: 'my-model' },
})

server.connect(stream)
```

The implementation targets [`@agentclientprotocol/sdk` 1.4](https://github.com/agentclientprotocol/typescript-sdk). Architecture and rationale are recorded in the [design](https://github.com/ruixingshi/dsh-acp/blob/main/docs/plans/2026-08-17-acp-adapter-design.md) and [ADR 0001](https://github.com/ruixingshi/dsh-acp/blob/main/docs/adr/0001-protocol-runtime-separation.md).

## Development

```bash
pnpm install --registry=https://registry.npmjs.org/
pnpm check
npx --yes . --help
```

The protocol and Harness integration suites run without an API key.

## License

Apache-2.0
