# DeepSeek Harness ACP

`@dumbo-ai/dsh-acp` connects Dumbo, Zed, and other ACP clients to DeepSeek Harness. Installing this package also installs Harness; users do not need to install `dsh` separately or prepare a `cordis.yml`.

[中文](README.md)

Version **0.6.0** uses Harness **0.2.1-rc.4**. Official ACP owns session execution; plans, titles, and tool categories are enabled by default.

## Quick start

Requires Node.js **>=24.9.0**:

```bash
npm install -g @dumbo-ai/dsh-acp@0.6.0
dsh-acp --version
```

Configure your client to run `dsh-acp` with no arguments and set `DEEPSEEK_API_KEY`. Restart the client after upgrading. For temporary use, run `npx --yes @dumbo-ai/dsh-acp@0.6.0`.

| Environment variable  | Purpose                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `DEEPSEEK_API_KEY`    | DeepSeek API key                                                                                         |
| `DEEPSEEK_BASE_URL`   | Optional compatible endpoint; omit for the official service, or use `https://api.deepseek.com/anthropic` |
| `DSH_HOME`            | Optional Harness settings, credentials, and session directory                                            |
| `DSH_PERMISSION_MODE` | Optional permission preset: `read-only`, `workspace-write`, or `danger-full-access`                      |

Custom base URLs pass through unchanged. The old official API root is not compatible with the default Messages route.

## Client configuration

Add this entry to Dumbo's `acp-agent-config.json`, preserving other agents:

```json
{
  "acp_agent_servers": {
    "dsh": {
      "type": "custom",
      "command": "dsh-acp",
      "args": [],
      "env": { "DEEPSEEK_API_KEY": "your API key" }
    }
  }
}
```

If the client cannot find the command, use the absolute path returned by `command -v dsh-acp`. Recruit the agent after adding its configuration. Zed uses the same command under `agent_servers`; see [External Agents](https://zed.dev/docs/ai/external-agents).

## Default presentation

- Model/reasoning selection and permission requests from official ACP.
- Task lists and progress when the agent uses Harness todos; the next turn clears the preceding plan.
- Harness session titles. The default derives a short title from the first prompt without an extra model request. Updates from custom title providers also propagate.
- Read, edit, search, execute, and other tool categories. Unknown and MCP tools remain generic; explicit official classifications take precedence.
- Existing title and current todo state after session resume, plus saved titles in the history list.

Task lists are not Codex Plan mode. Harness and the model decide when to use them, and the client must render the corresponding ACP update types.

## Custom configuration

For a custom default model, supply an overlay such as [examples/acp.patch.yml](examples/acp.patch.yml):

```yaml
- id: dsh-acp
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
```

```bash
dsh-acp --patch /absolute/path/to/acp.patch.yml
```

Repeat `--patch` for additional overlays. Later overlays win; a `config` patch replaces the complete configuration of its target entry.

## Migration from 0.5.x and earlier

Users launching with no arguments can upgrade and restart their client.

- Remove `--config`; complete Cordis configurations are no longer loaded. A working-directory `cordis.yml` is ignored.
- Move required settings into `--patch` overlays. Change ACP model-setting targets from `id: acp` to `id: dsh-acp`; other Harness plugin ids are unchanged.
- Do not re-enable the original `acp` entry. The bundled overlay replaces it with the presentation plugin that calls the same official implementation.
- The previous `DshAcpServer`, `DshAcpAgent`, `CordisHarnessRuntime`, `HarnessRuntime`, and `./runtime` exports are removed. Use the Cordis plugin below for programmatic integration.

## ACP capabilities

Official ACP owns session creation/list/resume/cancel/close, persistence, model settings, usage, permissions, and MCP mounts. Text and resource links are supported; images depend on the model and Harness configuration. Messages and thoughts are sent after commitment, not as token deltas. Stdout contains JSON-RPC only; diagnostics go to stderr.

The protocol remains ACP v1. Transcript replay (`session/load`), fork/delete, additional directories, audio, embedded context, ACP modes/commands, terminal views, client filesystem operations, and elicitation remain unsupported. Resume restores model context and presentation state without replaying historical messages. Official ACP owns list filtering, ordering, and pagination; we only add cached titles. Rows without an available title checkpoint remain untitled.

## Programmatic integration

The package root and `@dumbo-ai/dsh-acp/plugin` export the official-backed Cordis plugin:

```ts
import * as acp from '@dumbo-ai/dsh-acp/plugin'

ctx.plugin(acp, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
```

The context must already provide official ACP's Harness services plus `sessionProjections` and `sessionProjectionCache`. Presentation uses the registered `title` and `todos` projections. Configuration follows official `provider`, `model`, and `sessionListPageSize`, with an optional runtime ACP `stream`. Do not mount a second ACP server.

## Development

```bash
pnpm install --registry=https://registry.npmjs.org/
pnpm check
```

Tests use a deterministic model substitute with real Harness, tools, MCP, and persistence. No API key is required. See [ADR 0002](docs/adr/0002-official-acp-presentation.md).

## License

Apache-2.0
