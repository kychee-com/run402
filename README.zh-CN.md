# run402-mcp

[Run402](https://run402.com) 的 MCP 服务器 — 从任何 MCP 兼容客户端创建和管理 AI 原生 Postgres 数据库。

> **免费试用 7 天完整后端（测试网）。进阶/团队版可用 USDC 或 Stripe 支付。**
> 数据库 + REST API + 鉴权 + 存储 + 静态站点 + 函数。无需云账号。

[English](./README.md) | 简体中文

## 快速开始

```bash
npx run402-mcp
```

## 工具列表

| 工具 | 说明 |
|------|------|
| `provision_postgres_project` | 创建新的 Postgres 数据库（prototype/hobby/team 等级） |
| `run_sql` | 对项目执行 SQL（DDL 或查询） |
| `rest_query` | 通过 PostgREST 查询/修改数据 |
| `renew_project` | 续期数据库租约 |
| `deploy_site` | 部署静态 HTML/CSS/JS 站点 |
| `deploy_function` | 部署 Node 22 Serverless 函数 |
| `invoke_function` | 调用已部署的函数 |
| `get_function_logs` | 获取函数日志 |
| `set_secret` | 设置函数环境变量 |

## 定价

| 等级 | 价格 | 租期 | 存储 | API 调用 |
|------|------|------|------|----------|
| Prototype 原型 | 免费（测试网） | 7 天 | 250 MB | 50 万次 |
| Hobby 进阶 | $5 / ¥36 | 30 天 | 1 GB | 500 万次 |
| Team 团队 | $20 / ¥145 | 30 天 | 10 GB | 5000 万次 |

仅创建和续期需要付款。后续 REST/鉴权/存储请求使用返回的密钥，无需额外付费。

## 客户端配置

### Claude Desktop

添加到 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "run402": {
      "command": "npx",
      "args": ["-y", "run402-mcp"]
    }
  }
}
```

### Cursor

添加到项目中的 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "run402": {
      "command": "npx",
      "args": ["-y", "run402-mcp"]
    }
  }
}
```

### Cline

在 Cline MCP 设置中添加：

```json
{
  "mcpServers": {
    "run402": {
      "command": "npx",
      "args": ["-y", "run402-mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add run402 -- npx -y run402-mcp
```

### OpenClaw

Run402 已发布为 OpenClaw Skill。支持所有 OpenClaw 兼容的模型和平台，包括：

- **豆包 Doubao**（字节跳动 ArkClaw）
- **Kimi**（月之暗面）
- **GLM**（智谱）
- **MiniMax**

## 工作流程

1. **创建项目** — 调用 `provision_postgres_project` 创建数据库。服务器自动处理 x402 支付协商，并在本地保存凭证。
2. **构建应用** — 用 `run_sql` 创建表结构，`rest_query` 插入/查询数据，`blob_put` 管理文件存储。
3. **部署上线** — 用 `deploy_site` 部署前端，`deploy_function` 部署后端函数。
4. **续期维护** — 在租约到期前调用 `renew_project`。

### 支付流程

创建和续期需要 x402 微支付。当需要付款时，工具会返回支付详情（而不是错误），以便 LLM 可以分析并引导用户完成支付。

### 密钥存储

项目凭证保存在 `~/.config/run402/projects.json`（权限 `0600`）。每个项目存储：
- `anon_key` — 公开查询用（遵循行级安全策略）
- `service_key` — 管理操作用（绕过行级安全策略）
- `tier` — prototype、hobby 或 team
- `expires_at` — 租约到期时间

## 智能体额度（Agent Allowance）

> 给智能体一个额度，不是钱包。

Run402 支持预付费、硬限额的智能体额度模式：
- **预付制** — 像充值卡一样预存额度
- **硬限额** — 智能体不会超支
- **可撤销** — 随时暂停或取消
- **可追溯** — 每笔交易都有记录

了解更多：[run402.com/agent-allowance](https://run402.com/agent-allowance)

## 应用模板（一键复制）

Run402 上的公开应用可以一键复制（Fork），每个副本拥有独立的数据库、鉴权、存储和 URL。

- 浏览可用应用：[run402.com/apps](https://run402.com/apps)
- API：`GET https://api.run402.com/v1/apps`
- 复制应用：`POST /v1/fork/:tier` + `{ "version_id": "...", "name": "my-copy" }`

模板发布者可获得下游实例续费的 **20% 持续分成**。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RUN402_API_BASE` | `https://api.run402.com` | API 基础 URL |
| `RUN402_CONFIG_DIR` | `~/.config/run402` | 密钥存储目录 |

## 相关链接

- **中文落地页**：[run402.com/zh-cn](https://run402.com/zh-cn)
- **完整 API 文档**：[run402.com/llms.txt](https://run402.com/llms.txt)
- **OpenAPI 规范**：[run402.com/openapi.json](https://run402.com/openapi.json)
- **应用市场**：[run402.com/apps](https://run402.com/apps)
- **API 状态**：[api.run402.com/health](https://api.run402.com/health)
- **npm**：[npmjs.com/package/run402-mcp](https://www.npmjs.com/package/run402-mcp)
- **GitHub**：[github.com/kychee-com/run402](https://github.com/kychee-com/run402)

## 开发

```bash
npm run build
npm run test:skill
```

## 许可证

MIT
