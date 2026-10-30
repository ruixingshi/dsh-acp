# DeepSeek Harness ACP

`@dumbo-ai/dsh-acp` 让 Dumbo、Zed 等 ACP 客户端使用 DeepSeek Harness。安装本包会自动安装 Harness，不需要单独安装 `dsh`，也不需要准备 `cordis.yml`。

[English](README.en.md)

**0.7.0 支持 ACP v1 和实验性 v2。** 适配器直接调用 Harness，两种协议共用一套会话实现。Harness 依赖固定为 **0.2.1-rc.4**。

## 安装与升级

需要 Node.js **>=24.9.0**：

```bash
npm install -g @dumbo-ai/dsh-acp@0.7.0
dsh-acp --version
```

在 ACP 客户端中填写启动命令 `dsh-acp`，参数留空，并配置 `DEEPSEEK_API_KEY`。升级后重启客户端即可。这个入口由客户端启动，通过标准输入输出通信。

客户端会自动协商协议：现有客户端继续使用 v1；支持实验性 v2 的客户端可以选择 v2，不需要额外启动参数。

临时体验可以运行 `npx --yes @dumbo-ai/dsh-acp@0.7.0`；日常使用建议先全局安装，避免客户端启动时等待下载。

| 环境变量              | 用途                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `DEEPSEEK_API_KEY`    | DeepSeek API Key                                                                            |
| `DEEPSEEK_BASE_URL`   | 可选，自定义 DeepSeek 兼容地址；官方服务可不填，或使用 `https://api.deepseek.com/anthropic` |
| `DSH_HOME`            | 可选，Harness 的设置、凭据和会话目录                                                        |
| `DSH_PERMISSION_MODE` | 可选，权限预设，例如 `read-only`、`workspace-write` 或 `danger-full-access`                 |

自定义 Base URL 保持原样。旧的官方 API 根地址不适用于默认的 Messages 路由。

## Dumbo / 飞象配置

`acp-agent-config.json` 的配置示例：

```json
{
  "acp_agent_servers": {
    "dsh": {
      "type": "custom",
      "command": "dsh-acp",
      "args": [],
      "env": { "DEEPSEEK_API_KEY": "替换成你的 API Key" }
    }
  }
}
```

如果客户端找不到命令，运行 `command -v dsh-acp`，将输出填入 `command`。保留其他 Agent 配置；从 0.6.0 升级不需要修改这个条目。

## 支持什么

两种协议共用同一套 Harness 会话执行代码，支持模型与思考强度选择、权限确认、stdio/HTTP MCP、会话列表、恢复、取消和关闭。

默认展示任务清单及进度、会话标题、工具分类和上下文用量。标题使用 Harness 自己的数据，不额外调用模型；清单由模型使用 Harness 的任务工具产生。下一轮开始会清除上一轮清单。历史列表也显示已保存的标题。

| 行为           | ACP v1                 | 实验性 ACP v2                            |
| -------------- | ---------------------- | ---------------------------------------- |
| 发送消息的响应 | 本轮结束后返回         | 消息进入会话后返回消息 ID                |
| 执行状态       | 由本轮响应表示完成     | 单独通知运行中、等待确认、空闲及结束原因 |
| 忙碌时的新消息 | 返回忙碌错误           | 排队，进入会话后才确认                   |
| 恢复会话       | 恢复上下文、标题和清单 | 同步当前状态；客户端可请求历史回放       |
| 消息与工具展示 | 保持原有更新方式       | 使用带 ID 的消息和工具更新               |

v2 的历史回放由客户端传入 `replayFrom: { "type": "start" }` 请求。没有这个参数就只恢复上下文和当前状态。取消、失败和关闭均等待 Harness 本轮执行退出；不会在第一轮尚未关闭时放行下一轮。

Harness 自己继续执行的任务也视为忙碌。取消排队中的消息不会中断已有任务；关闭会话会在任务停止后通知已取消、已空闲。

## 自定义 Harness 配置

普通使用不需要配置文件。指定默认模型时，可以创建补丁：

```yaml
- id: dsh-acp
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
```

使用 `dsh-acp --patch /absolute/path/to/acp.patch.yml`。`--patch` 是 Harness 的配置方式，可重复传入。补丁替换目标条目的整个 `config`，所需字段应写全。不要重新启用官方 `acp` 条目，否则会有两个服务器争用标准输入输出。

## 能力边界

v2 使用 ACP TypeScript SDK **2.1.0** 的实验性入口，协议仍可能变化。当前支持标准 stdio/HTTP MCP，尚未实现 MCP-over-ACP、会话分叉或删除、额外工作目录、音频、embedded context、ACP mode/command、终端视图、客户端文件操作和结构化提问。这些能力不会被宣告为可用。

消息和思考在 Harness 提交后发送，不逐 token 输出。图片取决于模型和 Harness 配置。恢复会话必须使用同一个工作目录；更换已激活会话的 MCP 配置会等待当前任务结束。stdout 只包含 ACP JSON-RPC，诊断写入 stderr。

`--config` 和旧的完整 `cordis.yml` 从 0.6.0 起已移除。现有无参数启动及 `--patch` 用法保持不变。标题缓存暂不可用时，历史条目可能没有标题。

## 程序化接入与开发

根入口和 `@dumbo-ai/dsh-acp/plugin` 导出 Cordis 插件 `apply`、`Config` 和 `inject`。上下文需已提供 `inject` 声明的 Harness 服务；配置为 `provider`、`model`、`sessionListPageSize`，测试或嵌入时可提供 `stream`。不要同时挂载另一个 ACP 服务器。

源码开发先运行 `pnpm install`、`pnpm check`。在客户端中使用 Node 的绝对路径作为启动命令，以项目 `dist/bin.js` 的绝对路径作为参数。

`pnpm check` 执行类型检查、代码检查、构建和测试。进程测试使用确定性模型替身，实际运行 Harness、工具、MCP 和持久化，不需要 API Key。架构见 [ADR 0003](docs/adr/0003-direct-acp-v1-v2.md)，发布变化见 [0.7.0 说明](docs/releases/0.7.0.md)。

## License

Apache-2.0。部分 Harness 接入辅助代码改编自 MIT 许可的官方实现，见 [第三方许可](THIRD_PARTY_NOTICES.md)。
