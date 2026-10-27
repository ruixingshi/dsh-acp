# DeepSeek Harness ACP

`@dumbo-ai/dsh-acp` 让 Dumbo、Zed 等 ACP 客户端使用 DeepSeek Harness。安装本包会自动安装 Harness，不需要单独安装 `dsh`，也不需要准备 `cordis.yml`。

[English](README.en.md)

本文对应 **0.6.0**，依赖 Harness **0.2.1-rc.4**。会话运行使用官方 ACP，默认增加计划进度、会话标题和工具分类。

## 快速开始

需要 Node.js **>=24.9.0**。全局安装后，客户端可以直接启动，无需每次等待下载：

```bash
npm install -g @dumbo-ai/dsh-acp@0.6.0
dsh-acp --version
```

在客户端填写启动命令 `dsh-acp`，参数留空，并配置 `DEEPSEEK_API_KEY`。升级后重启客户端即可。临时体验也可以运行 `npx --yes @dumbo-ai/dsh-acp@0.6.0`。

| 环境变量              | 用途                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `DEEPSEEK_API_KEY`    | DeepSeek API Key                                                                                |
| `DEEPSEEK_BASE_URL`   | 可选，自定义 DeepSeek 兼容接口地址；官方服务可不填，或使用 `https://api.deepseek.com/anthropic` |
| `DSH_HOME`            | 可选，Harness 的设置、凭据和会话目录                                                            |
| `DSH_PERMISSION_MODE` | 可选，权限预设，如 `read-only`、`workspace-write` 或 `danger-full-access`                       |

自定义 Base URL 会保持原样。使用官方服务时，旧的 API 根地址不适用于默认的 Messages 路由。

## Dumbo / 飞象配置

在本地 `acp-agent-config.json` 的 `acp_agent_servers` 中添加以下条目，保留其他 Agent：

```json
{
  "acp_agent_servers": {
    "dsh": {
      "type": "custom",
      "command": "dsh-acp",
      "args": [],
      "env": {
        "DEEPSEEK_API_KEY": "替换成你的 API Key"
      }
    }
  }
}
```

如果客户端找不到命令，运行 `command -v dsh-acp`，把输出的绝对路径填入 `command`。首次添加配置后招募该 Agent。

Zed 使用同样的启动命令，在其 `agent_servers` 中配置；详见 [External Agents 文档](https://zed.dev/docs/ai/external-agents)。

## 默认能看到什么

- 模型和思考强度选择，以及权限确认。
- Agent 使用任务清单时，显示计划及完成进度；下一轮开始时清除上一轮清单。
- 使用 Harness 已有的会话标题。默认从首条消息截取简短标题，不额外调用模型；自定义标题插件生成的新标题也会同步。
- 区分读取、编辑、搜索、执行命令等工具。未知工具和 MCP 工具保留通用分类，官方明确提供的分类优先。
- 恢复会话时同步已有标题和当前清单；历史会话列表也显示已保存的标题。

计划清单不是 Codex 的 Plan 模式；是否生成清单由 Harness 和模型决定。客户端需要支持对应 ACP 展示类型。

## 自定义模型或其他 Harness 配置

普通使用不需要配置文件。如需指定默认模型，创建一个补丁文件：

```yaml
- id: dsh-acp
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
```

```bash
dsh-acp --patch /absolute/path/to/acp.patch.yml
```

`--patch` 可重复传入，后面的补丁优先。补丁替换目标条目的整个 `config`，所需字段应写全。示例见 [examples/acp.patch.yml](examples/acp.patch.yml)。

## 从 0.5.x 及更早版本升级

无参数启动的用户直接升级并重启客户端。

- 移除启动参数中的 `--config`，旧的完整 `cordis.yml` 不再加载；工作目录中的同名文件也不再自动生效。
- 需要自定义的设置改为上述 `--patch`。原来修改 ACP 模型的补丁，把目标 `id: acp` 改成 `id: dsh-acp`。其他 Harness 插件的条目 ID 不变。
- 不要在补丁中重新启用官方 `acp` 条目，它已由内置补丁替换为调用同一官方实现的增强入口。
- 移除了旧的 `DshAcpServer`、`DshAcpAgent`、`CordisHarnessRuntime`、`HarnessRuntime` 以及 `./runtime` 导出。程序化接入使用下述 Cordis 插件。

## 协议能力与限制

会话创建、列表、恢复、取消、关闭、持久化、模型设置、上下文用量、权限确认和 MCP 挂载由官方 ACP 负责。支持文本和 resource link；图片取决于模型和 Harness 配置。消息和思考在提交后发送，不逐 token 输出。stdout 只包含 ACP JSON-RPC，诊断写入 stderr。

当前使用 ACP v1。暂不提供历史消息重放（`session/load`）、会话分叉或删除、额外工作目录、音频、embedded context、ACP mode/command、终端视图、客户端文件操作或结构化提问。恢复会话会恢复模型上下文和展示状态，但不会重放历史消息；列表的筛选、排序和分页由官方负责，我们只补充标题；没有可用标题缓存的条目保持无标题。

## 程序化接入

根入口和 `@dumbo-ai/dsh-acp/plugin` 都导出官方实现支持的 Cordis 插件：

```ts
import * as acp from '@dumbo-ai/dsh-acp/plugin'

ctx.plugin(acp, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
```

`ctx` 必须已经组合好官方 ACP 所需的 Harness 服务，以及 `sessionProjections` 和 `sessionProjectionCache`。标题和计划使用 Harness 注册的 `title`、`todos` 投影。配置沿用官方的 `provider`、`model` 和 `sessionListPageSize`，运行时还可传入 ACP `stream`。不要同时挂载另一个 ACP 服务器。

## 本地开发

```bash
pnpm install --registry=https://registry.npmjs.org/
pnpm check
```

测试使用确定性的模型替身，实际启动官方 Harness、工具、MCP 和持久化，不需要 API Key。架构见 [ADR 0002](docs/adr/0002-official-acp-presentation.md)。

## License

Apache-2.0
