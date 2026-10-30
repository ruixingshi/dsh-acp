# DeepSeek Harness ACP

`@dumbo-ai/dsh-acp` connects ACP clients such as Dumbo and Zed to DeepSeek Harness. Installing the package also installs Harness; users do not need a separate `dsh` installation or a `cordis.yml` file.

[简体中文](README.md)

**0.7.0 supports ACP v1 and experimental v2.** The adapter calls Harness directly, with one session runtime shared by both protocols. Harness is pinned to **0.2.1-rc.4**.

## Install or upgrade

Use Node.js **>=24.9.0**:

```bash
npm install -g @dumbo-ai/dsh-acp@0.7.0
dsh-acp --version
```

Set the client launch command to `dsh-acp`, leave arguments empty, and configure `DEEPSEEK_API_KEY` in its environment. Restart the client after upgrading. The client starts the process and communicates over stdio.

Protocol negotiation preserves existing v1 clients. Experimental v2 clients request version 2 using the same entrypoint; no extra command-line flag is necessary.

For a temporary install, use `npx --yes @dumbo-ai/dsh-acp@0.7.0`. For daily use, install globally first so the client does not wait for a download on startup.

| Environment variable  | Purpose                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `DEEPSEEK_API_KEY`    | DeepSeek API key                                                                                         |
| `DEEPSEEK_BASE_URL`   | Optional compatible endpoint; omit for the official service, or use `https://api.deepseek.com/anthropic` |
| `DSH_HOME`            | Optional Harness settings, credentials and session directory                                             |
| `DSH_PERMISSION_MODE` | Optional Harness preset, such as `read-only`, `workspace-write` or `danger-full-access`                  |

Custom base URLs pass through unchanged. The old official API root is incompatible with the default Messages route.

For Dumbo, retain the existing `acp_agent_servers.dsh` entry with `type: "custom"`, `command: "dsh-acp"`, `args: []`, and `env: { "DEEPSEEK_API_KEY": "your-key" }`. If necessary, use the absolute path from `command -v dsh-acp`. Upgrading from 0.6.0 requires no changes to this entry.

## Features

Both protocols share one Harness runtime for model/reasoning selection, permission decisions, stdio/HTTP MCP, session listing, resuming, cancellation and closing. Plans, titles, tool categories and context usage are enabled by default. Titles and task lists use Harness data; the adapter does not make extra model requests to invent them. A new turn clears the previous task list. History listings include cached titles when available.

| Behavior           | ACP v1                            | Experimental ACP v2                                 |
| ------------------ | --------------------------------- | --------------------------------------------------- |
| Prompt response    | Waits for turn completion         | Returns a message ID after insertion                |
| Foreground state   | Completion is the prompt response | Separate running, requires_action and idle updates  |
| Prompts while busy | Rejected                          | Queued; acknowledged only when inserted             |
| Resume             | Restores context, title and plan  | Synchronizes current state; optional history replay |
| Messages/tools     | Existing v1 updates               | Identified message and tool upserts                 |

V2 clients request retained history using `replayFrom: { "type": "start" }`. Omission restores context without replaying history. Completion, errors and cancellation wait for the Harness driver to retire before allowing the next turn.

Work started by Harness itself also keeps the session busy. Cancelling a queued message leaves existing work running; closing the session reports the cancelled idle state after that work stops.

## Configuration

No configuration file is required. To select a default model, create an overlay:

```yaml
- id: dsh-acp
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
```

Launch with `dsh-acp --patch /absolute/path/to/acp.patch.yml`. Harness owns `--patch`; repeated overlays apply in order and replace the matched entry's entire `config`. Keep all required fields. Do not re-enable the original `acp` entry: two servers would compete for stdio.

`--config` and complete custom `cordis.yml` files were removed in 0.6.0. Existing no-argument and `--patch` usage remains compatible.

## Limits

The v2 implementation uses the experimental entrypoint in ACP TypeScript SDK **2.1.0**. Its draft protocol may change. Standard stdio/HTTP MCP is supported; MCP-over-ACP, forks, deletion, additional directories, audio, embedded context, ACP modes/commands, terminal views, client filesystem operations and elicitation are not advertised or implemented.

Messages and thoughts are sent after Harness commits them, without token-by-token streaming. Image admission depends on the selected model and Harness configuration. Resuming requires the same working directory. Replacing an active session's MCP configuration waits for its foreground work to finish. stdout contains only ACP JSON-RPC; diagnostics use stderr.

## Embedding and development

The root and `./plugin` exports provide a Cordis plugin with `apply`, `Config`, and `inject`. Compose the Harness services named in `inject` first. Settings are `provider`, `model`, `sessionListPageSize`, and an optional runtime `stream`. Do not mount another ACP server.

For source development, run `pnpm install` and `pnpm check`, then configure the client to launch the absolute Node executable with the absolute path to the project's `dist/bin.js` as its argument.

`pnpm check` runs typechecking, lint, build and tests. Process tests use a deterministic model with real Harness, tools, MCP and persistence; no API key is required. See [ADR 0003](docs/adr/0003-direct-acp-v1-v2.md) and the [0.7.0 release notes](docs/releases/0.7.0.md).

## License

Apache-2.0. Some integration helpers are adapted from MIT-licensed Harness code; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
