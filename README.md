# music.dl

纯 Node.js 音乐下载服务：复用洛雪 / lxserver 的 `musicSdk` 做搜索、歌单、榜单、歌手、歌词，用 `vm2` / 原生 VM 执行 `source/` 下的自定义音源脚本解析播放地址。Web UI 和 Telegram Bot 都能下歌。

## 快速开始

需要 Node.js 20+。

```bash
cp .env.example .env
npm install
npm start
# 打开 http://localhost:8000
```

开发热重载：

```bash
npm run dev
```

或 Docker：

```bash
docker compose up -d --build
```

## 功能

- 搜索 / 歌单 URL·ID / 歌手 / 排行榜 批量下载
- 音质比较：曲库已有且不低于目标音质则跳过，更低则覆盖升级
- 自动补齐歌词并内嵌到 FLAC / MP3 标签（不再单独写 `.lrc`）
- 过滤词：歌名、歌手、专辑命中则搜索隐藏并跳过下载
- 音源管理：扫描 `source/`、URL 导入、本地上传
- WebUI 设置：默认音质、并发、超时、过滤词、Telegram
- 曲库可扫描缺词并批量补歌词
- Telegram Bot：搜索、歌单、任务、补歌词、下载通知

## Telegram

建议用独立 Bot（不要和 MoviePilot 等抢同一个 Token）。网页「设置」里填写：

1. **Bot Token**（@BotFather）
2. **Chat ID**：先保存 Token 和代理，私聊 Bot 发 `/id`，把数字填回去
3. **代理**（国内必填）：`http://127.0.0.1:7890` 或 `socks5://127.0.0.1:7890`
4. 勾选 **接收 Bot 命令**

命令：

| 命令 | 说明 |
| --- | --- |
| `/search 晴天` | 全平台搜歌，按钮下载 |
| `/playlist 周杰伦` | 搜歌单，翻页、点歌或整页/全部下载 |
| `/jobs` | 最近任务；进行中的可取消 |
| `/lyrics` | 扫描缺歌词，可一键补 |
| `/id` | 查看当前 Chat ID |

直接发歌名等同 `/search`。下载完成会推通知；单文件超时后失败并换源重试。

一个 Token 同时只能有一个程序 `getUpdates`。若只想发通知、不收命令，关掉「接收 Bot 命令」（`TG_LISTEN=false`）。

## 环境变量

见 `.env.example`，也可在 WebUI 保存后写入 `data/settings.json`。

| 变量 | 说明 |
| --- | --- |
| `PORT` | HTTP 端口，默认 `8000` |
| `PREFERRED_QUALITY` | 默认音质，如 `flac` |
| `DOWNLOAD_CONCURRENCY` | 同时下载数，建议 1–4 |
| `DOWNLOAD_TIMEOUT_MS` | 单文件超时，默认 300000（5 分钟） |
| `FILTER_WORDS` | 过滤词，逗号或换行分隔 |
| `TG_BOT_TOKEN` / `TG_CHAT_ID` | Bot 与通知会话 |
| `TG_PROXY` | 访问 Telegram 的代理 |
| `TG_LISTEN` | 是否收 Bot 命令，默认 `true` |
| `TG_ALLOWED_IDS` | 额外允许的 Chat / User ID |
| `ALLOW_UNSAFE_VM` | 执行自定义音源脚本，默认 `true` |


## 文件命名

下载保存在 `歌手/专辑/` 下，文件名为：

`曲名 - 歌手 - 音质 - 专辑.ext`

歌词内嵌到音频标签（MP3 用 USLT，FLAC 用 Vorbis `LYRICS`），不再生成 sidecar `.lrc`。
