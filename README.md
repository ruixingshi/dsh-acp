# DeepSeek Harness ACP

`@dumbo-ai/dsh-acp` 为 DeepSeek Harness 官方 ACP 应用提供稳定的 `npx` 启动入口。0.4.0 默认使用 DeepSeek Harness `0.1.6-alpha.1` 维护的 `acp` profile，同时保留本包原有的 TypeScript 适配器 API 和完整 Cordis 配置模式，避免已有集成失效。

[English](README.en.md)

## 快速开始

需要 Node.js `^22.19.0` 或 `>=24.0.0`。

```bash
export DEEPSEEK_API_KEY='...'
npx --yes @dumbo-ai/dsh-acp
```

无参数启动会运行官方 DeepSeek Harness ACP profile。coding tools、sandbox、权限策略、模型目录、持久会话、MCP 接入和 ACP 生命周期都由官方 profile 维护。

启动器识别以下环境变量：

- `DEEPSEEK_API_KEY`：DeepSeek API Key。
- `DEEPSEEK_BASE_URL`：可选，传给 Harness 进程的 DeepSeek 兼容接口地址。自定义接口地址保持原样；使用 DeepSeek 官方服务时应删除该变量，或填写 `https://api.deepseek.com/anthropic`，旧的 API 根地址不再适用于默认 Messages 路由。
- `DSH_HOME`：可选，Harness 的状态、设置、凭据、会话和 profile 目录。
- `DSH_PERMISSION_MODE`：可选，Harness 权限预设，例如 `read-only`、`workspace-write` 或 `danger-full-access`。

Harness 也会使用 `DSH_HOME` 下由它管理的设置和凭据文件。

## 自定义官方 profile

使用 `--patch` 传入一个或多个 patch-list overlay，后面的 patch 优先。仓库提供了 [examples/acp.patch.yml](examples/acp.patch.yml)：

```yaml
- id: acp
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
```

启动命令：

```bash
npx --yes @dumbo-ai/dsh-acp --patch /absolute/path/to/acp.patch.yml
```

patch 会替换目标条目的整个 `config`，所以目标条目需要的字段都应写全。

## 旧版完整 Cordis 模式

为保持兼容，显式传入 `--config` 时，仍会在一棵完整 Cordis 配置树中启动本包原来的 rich adapter：

```bash
npx --yes @dumbo-ai/dsh-acp --config /absolute/path/to/cordis.yml
```

如果启动目录存在 `./cordis.yml`，也会自动进入这个旧版模式。`--patch` 不能和这两种旧版入口同时使用。旧版 `cordis.yml` 必须描述完整的 Harness 组合，它不是官方 profile 的 overlay。

适配器对应的 Cordis 条目是：

```yaml
- id: rich-acp
  name: '@dumbo-ai/dsh-acp'
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
    reasoningEffort: max
```

CLI 会把 stdout 专门留给 ACP JSON-RPC 帧，诊断信息写入 stderr。

## 默认模式的 ACP 支持范围

默认官方 profile 支持：

- ACP v1 初始化和鉴权。
- 创建、列出、恢复、提示、取消和关闭持久会话。
- 标准模型与推理强度配置项。
- 有序文本和 resource link；当选中模型支持图片时，也支持相应的栅格图片输入。
- 标准 stdio 和 Streamable HTTP MCP server 配置、MCP 协议协商与分页工具发现，也支持没有暴露工具的 server。
- Harness profile 提供的共享 MCP resource 发现、直接读取与 URI 模板补全。
- 已提交的消息与思考、通用工具生命周期、配置变化、上下文用量和权限请求。
- 只有在 Harness Agent 和有序更新流完全停稳后，prompt 和 close 才会结束。

当前不支持 session load、删除或 fork、additional directories、音频、embedded context、ACP mode 或 command、plan、terminal、客户端文件操作和 elicitation。未支持的能力会按 ACP 要求不声明或明确拒绝。

## Zed

添加一个自定义 External Agent：

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

需要自定义时，在 `args` 中追加 `"--patch", "/absolute/path/to/acp.patch.yml"`。当前配置格式见 [Zed External Agents 文档](https://zed.dev/docs/ai/external-agents)。

## 程序化使用

包仍然导出 `DshAcpServer`、`DshAcpAgent`、`CordisHarnessRuntime`、协议无关的 `HarnessRuntime` / `RuntimeSession` 接口，以及 Cordis 的 `apply` / `Config` 插件入口。这些导出属于保留的兼容适配器；无参数 CLI 使用的是 Harness 官方 ACP 实现。

```ts
import { DshAcpServer, type HarnessRuntime } from '@dumbo-ai/dsh-acp'

const runtime: HarnessRuntime = createRuntime()
const server = new DshAcpServer(runtime, {
  initialSelection: { provider: 'my-provider', model: 'my-model' },
})

server.connect(stream)
```

当前实现使用 [`@agentclientprotocol/sdk` 1.4](https://github.com/agentclientprotocol/typescript-sdk)。架构与设计理由记录在[设计文档](https://github.com/ruixingshi/dsh-acp/blob/main/docs/plans/2026-08-17-acp-adapter-design.md)和 [ADR 0001](https://github.com/ruixingshi/dsh-acp/blob/main/docs/adr/0001-protocol-runtime-separation.md) 中。

## 本地开发

```bash
pnpm install --registry=https://registry.npmjs.org/
pnpm check
npx --yes . --help
```

协议与 Harness 集成测试不需要 API Key。

## License

Apache-2.0
