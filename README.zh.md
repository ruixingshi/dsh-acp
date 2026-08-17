# DeepSeek Harness ACP Adapter

一个面向编辑器体验的 DeepSeek Harness ACP v1 适配器。它沿用 Harness 原 ACP 包创建和驱动底层 Agent 的方式，但把协议层按当前 ACP TypeScript SDK 重写，完整展示模型、推理强度、思考过程、工具、计划、用量和权限请求。

## 主要能力

- 在 `session/new` 返回标准 `configOptions`，客户端可以展示按 provider 分组的模型选择器。
- 模型值包含 provider，允许不同 provider 使用相同 model id；provider 未列出当前模型时也不会把当前选择隐藏掉。
- 根据选中模型动态展示 `reasoning_effort`，切换模型后返回完整的新配置选项。
- 流式发送 `agent_message_chunk` 和 `agent_thought_chunk`。
- 映射工具开始、工具结果、计划、上下文用量和会话标题更新。
- 将 ACP 的一次性允许/拒绝选择接入 Harness `approval/request`。
- 每个 ACP session 对应一个由 `ctx.agents.create` 创建的独立 Harness Agent；模型切换通过 `installModelSelection` 在下一步生效。
- 支持单 session 取消、显式关闭和连接级幂等清理。

## 环境要求

- Node.js 22.19 或更高版本
- `DEEPSEEK_API_KEY`
- `@agentclientprotocol/sdk` 1.3.x（本包已直接依赖）

## 快速开始

无需全局安装，也不需要先准备 Cordis 配置：

```bash
export DEEPSEEK_API_KEY='...'
npx --yes @dumbo/dsh-acp
```

无参数启动会使用包内置的 DeepSeek provider、Agent spine、workspace instructions 和 todo/计划配置。为保持跨平台和安全的零配置默认值，内置组合不开放 bash 或文件修改工具；需要完整 coding tools、sandbox 和权限策略时，通过 `--config` 使用自己的 Harness 组合。

## 本地开发

```bash
pnpm install
pnpm check
npx --yes . --help
```

`pnpm check` 依次执行类型检查、lint、构建和测试。协议与 Harness 集成测试不需要 API key。

## 自定义配置

CLI 按以下顺序选择配置：显式 `--config`、当前目录的 `./cordis.yml`、包内置 standalone 配置。仓库还提供了一个最小的模型-only 示例：[examples/cordis.yml](examples/cordis.yml)。

```bash
npx --yes @dumbo/dsh-acp --config /absolute/path/to/cordis.yml
```

CLI 通过 Harness app boot 加载启动目录的 `.env`。stdout 只输出 ACP JSON-RPC 帧，日志写入 stderr。

适配器本身的 Cordis 条目如下：

```yaml
- id: rich-acp
  name: '@dumbo/dsh-acp'
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
    reasoningEffort: max
```

`provider` 和 `model` 是新建 session 的初始路由。它们必须能由部署中的 `ctx.llm` 解析。模型目录是展示信息，不是强制白名单，因此显式配置但暂未出现在目录中的模型仍然可用。

## Zed

在 Zed 的 Agent Settings 中选择 **Add Custom Agent**，或在 `settings.json` 添加：

```json
{
  "agent_servers": {
    "dsh-acp": {
      "type": "custom",
      "command": "npx",
      "args": ["--yes", "@dumbo/dsh-acp"],
      "env": {
        "DEEPSEEK_API_KEY": "..."
      }
    }
  }
}
```

需要自定义组合时，在 `args` 后追加 `"--config", "/absolute/path/to/cordis.yml"`。生产环境建议让命令从安全的环境或 `.env` 读取 key，而不是把 key 写进编辑器设置。Zed 的 ACP 日志可通过命令面板中的 `dev: open acp logs` 查看。当前配置格式见 [Zed External Agents 文档](https://zed.dev/docs/ai/external-agents)。

## ACP 支持范围

| 能力                                           | 状态                                                           |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `initialize` / ACP v1                          | 支持                                                           |
| `session/new`                                  | 支持                                                           |
| `session/set_config_option`                    | 支持 `model` 与 `reasoning_effort`                             |
| `session/prompt`                               | 支持文本与 `resource_link`；resource link 会转为明确的文本标记 |
| `session/cancel`                               | 支持；未知 session 是 no-op                                    |
| `session/close`                                | 支持                                                           |
| 消息、思考、工具、计划、用量、标题更新         | 支持                                                           |
| 一次性工具权限请求                             | 支持                                                           |
| 图片、音频、embedded context                   | 未声明支持                                                     |
| 客户端传入 MCP server / additional directories | 暂不支持，会返回 invalid params                                |
| session list/load/resume/fork/delete           | 暂不支持                                                       |
| 鉴权与 provider 登录                           | 暂不支持；凭据由 Harness 部署管理                              |

未实现的能力不会出现在 `agentCapabilities` 中。持久 session 能力需要明确的日志回放、恢复模型选择和删除所有权规则，计划作为后续阶段实现。

## 程序化使用

包根导出以下主要入口：

- `DshAcpServer`：ACP SDK handler 与 transport 绑定。
- `DshAcpAgent`：可直接测试或嵌入的协议处理器。
- `CordisHarnessRuntime`：通过公开 Harness service/event 驱动真实 Agent。
- `HarnessRuntime`、`RuntimeSession`：协议无关的运行时接口，可用于自定义后端。
- `apply`、`Config`：Cordis 插件入口。

```ts
import { DshAcpServer, type HarnessRuntime } from '@dumbo/dsh-acp'

const runtime: HarnessRuntime = createRuntime()
const server = new DshAcpServer(runtime, {
  initialSelection: { provider: 'my-provider', model: 'my-model' },
})

server.connect(stream)
```

## 设计与协议资料

- [架构设计](docs/plans/2026-08-17-acp-adapter-design.md)
- [协议层与 Harness runtime 分离 ADR](docs/adr/0001-protocol-runtime-separation.md)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [ACP Session Config Options](https://agentclientprotocol.com/rfds/session-config-options)

## License

Apache-2.0
