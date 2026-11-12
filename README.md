# ReplyAPI · 假接口，真回复

一个"人工回复"的假 API 网站：

- 站点首页是一个像模像样的 API 平台（文档 + 在线调试台）；
- 任何发到 `/v1/*`、`/api/*`、`/mock/*` 的请求都会被 **挂起**，进入 `/admin` 控制台的队列；
- 你在控制台里手写 **状态码 / Content-Type / 响应体 / 额外响应头**，点发送，调用方立刻收到你写的内容；
- 兼容 OpenAI 的 `chat/completions` 格式（`stream: true` 时会把你的内容按 SSE 分块回放），所以现有 SDK 改个 `base_url` 就能用。

零依赖，只有一个 Node 进程。

## 启动

```powershell
cd D:\deepseek发挥\fake-api
node server.js
```

或双击 `start.ps1`。启动后终端会打印：

- 站点：`http://127.0.0.1:8787/`
- 控制台：`http://127.0.0.1:8787/admin`
- API Key：`sk-reply-...`
- 控制台密码：8 位随机串

两者都保存在 `data/config.json`，也可以在控制台「设置」里改。

## 怎么用

1. 浏览器打开控制台，输入密码登录。
2. 别人（或你的客户端）调用：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer <你的 key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"reply-1","messages":[{"role":"user","content":"在吗"}]}'
```

3. 控制台左侧出现一条「等待中」的请求，点开 → 右边写回复 → `Ctrl+Enter` 发送。
4. 上面那条 curl 会立刻返回你写的内容。

控制台快捷键：`j` / `k` 切换请求，`Ctrl+Enter` 发送回复，`Esc` 关弹窗。

## 两种调用模式

| 模式 | 怎么发 | 行为 |
| --- | --- | --- |
| 长连接（默认） | 直接发 | 连接挂起最多 `waitSeconds` 秒（默认 180），人回复后立刻返回；超时返回 `504` + `human_timeout` |
| 回执 + 轮询 | 加 `?nowait=1`（或请求头 `X-Wait: 0`） | 立即返回 `202 {id, poll_url}`，再 `GET /public/requests/<id>` 取结果 |

还可以用 `?wait=30` 或 `X-Wait-Seconds: 30` 单次指定等待秒数（上限 900）。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/chat/completions` · `/chat/completions` | OpenAI 兼容，人工回复；支持 `stream: true` |
| GET | `/models` · `/v1/models` | 模型清单（免鉴权，baseURL 带不带 `/v1` 都行） |
| ANY | `/api/*`、`/mock/*` | 任意路径方法，原样进队列 |
| GET | `/public/requests/<id>` | 查询人工回复结果 |
| GET | `/public/stats` | 请求数、平均人工响应耗时 |
| GET | `/public/config` | 首页展示用（是否公开 key 可在设置里关） |
| GET | `/admin` | 控制台 |
| GET | `/health` | 健康检查 |

响应头里有 `X-Human-Reply: 1`、`X-Reply-Id`、`X-Reply-Wait-Ms`，方便客户端识别。

## 接进 DSH（自定义 Provider）

DSH 的「获取可用模型」请求的是 `{baseURL}/models`，聊天请求是 `{baseURL}/chat/completions`，所以 **baseURL 带不带 `/v1` 都要能通** —— 这两个地址本站都支持。

1. DSH 里打开 设置 → 模型 → 添加自定义 Provider
2. 路由 id：`replyapi`（小写字母/数字/连字符，不能以数字开头）
3. baseURL：`http://127.0.0.1:8787/v1`（也可以写 `http://127.0.0.1:8787`，一样能用）
4. 协议：OpenAI Completions（`openai-completions`）
5. API Key：填控制台里那个 `sk-reply-...`（留空也能获取模型清单，但发消息会被 401）
6. 点「获取可用模型」，勾上 `reply-1` / `human-pro`，创建
7. 会话里选 `reply-1` 发消息 → 控制台队列出现请求 → 用「OpenAI 回复」模板回，DSH 那边就会像正常模型一样流式吐出来

注意 DSH 发请求时固定带 `stream: true`，回复内容要用 JSON（模板已内置）：
`{"choices":[{"message":{"role":"assistant","content":"你想让它说的话"}}]}`

## 设置项（控制台右上角 ⚙）

- 默认等待时长
- API Key（可换）
- 是否在首页公开 Key
- 管理员密码
- 无人值守自动回复（开启后新请求立刻返回固定内容，不等人）

## 接到公网（可选）

```powershell
# 临时隧道，Cloudflare
cloudflared tunnel --url http://127.0.0.1:8787
```

拿到公网域名后，把首页里的 base URL 换成它即可（页面会自动用当前域名，直接访问公网域名就行）。
内网穿透同理可用 ngrok / frp。**注意**：公开后任何拿到 key 的人都能往队列里塞请求，不想被刷就把「公开 Key」关掉，并在设置里换一个新 key。

## 回复控制台的小功能

- **摘要卡**：详情顶部直接显示「最新一条用户消息」，外加消息条数 / 工具数 / 报文体积，不用翻整段 JSON 才知道该回什么。
- **队列预览**：每条显示最后一条用户消息（新请求排最上面）；顶部搜索框按路径、内容、请求 id 过滤。
- **请求体折叠**：默认只占 180px，点「展开全文」看完整原文；「复制」始终复制完整内容。
- **窄屏优先回复**：窗口窄于 1180px 时回复列自动排到最前面，不会被几十 KB 的请求体挤到下面。
- **大请求不拖慢页面**：状态接口每个请求最多带 64KB 正文，超出部分点开原文时再单独向 `/admin/api/request/<id>` 取。

## 目录

```
fake-api/
├─ server.js          # 全部后端逻辑（零依赖）
├─ public/
│  ├─ index.html      # 站点首页（文档 + 调试台）
│  └─ admin.html      # 人工回复控制台
├─ data/config.json   # 自动生成：key、密码、等待时长等
├─ package.json
└─ start.ps1
```

## 限制

- 不是模型，响应全靠人写；队列里的请求超过等待时间会 504。
- 记录只放内存（历史最多 300 条），重启即清空；配置落盘。
- `stream: true` 只会把你写的 JSON 里的 `choices[0].message.content` 抽出来分块回放，不是真的逐 token 推理。
