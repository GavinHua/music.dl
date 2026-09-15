# music.dl

纯 Node.js 音乐下载服务：复用洛雪 / lxserver 的 `musicSdk` 做搜索/歌单/榜单/歌手/歌词，用 `vm2`/原生 VM 执行 `source/` 下的自定义音源脚本解析播放地址。

## 快速开始

```bash
cp .env.example .env
npm install
npm start
# 打开 http://localhost:8000
```

或 Docker：

```bash
docker compose up -d --build
```

## 功能

- 搜索 / 歌单 URL·ID / 歌手 / 排行榜 批量下载
- 音质比较：已存在且不低于目标音质则跳过，更低则覆盖
- 自动补齐歌词并内嵌到 FLAC/MP3 标签（不再单独写 `.lrc`）
- 音源管理：扫描 `source/`、URL 导入、本地上传
- WebUI 设置页可配置默认下载音质
- 曲库可扫描缺词并批量补歌词
- Telegram：设置 `TG_BOT_TOKEN` 与 `TG_ALLOWED_IDS`

## 目录

- `src/` 服务端
- `src/vendor/musicSdk` 自 lxserver 抽出的元数据 SDK
- `source/` LX 自定义音源脚本
- `data/music/` 下载目录
- `public/` WebUI

## 文件命名

下载文件保存在 `歌手/专辑/` 下，文件名为：

`曲名 - 歌手 - 音质 - 专辑.ext`

歌词内嵌到音频标签（`lyric_path=embedded`），不再生成 sidecar `.lrc`。
