import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

function envBool(name, def = false) {
  const v = process.env[name]
  if (v == null || v === '') return def
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(v).toLowerCase())
}

export const config = {
  port: Number(process.env.PORT || 8000),
  host: process.env.HOST || '0.0.0.0',
  root,
  dataDir: process.env.DATA_PATH || path.join(root, 'data'),
  musicDir: process.env.MUSIC_PATH || path.join(root, 'data', 'music'),
  sourceDir: process.env.SOURCE_PATH || path.join(root, 'source'),
  dbPath: process.env.DB_PATH || path.join(root, 'data', 'app.db'),
  preferredQuality: process.env.PREFERRED_QUALITY || 'flac',
  downloadConcurrency: Number(process.env.DOWNLOAD_CONCURRENCY || 2),
  /** Per-file download timeout (ms). Default 5 minutes. */
  downloadTimeoutMs: Number(process.env.DOWNLOAD_TIMEOUT_MS || 5 * 60 * 1000),
  /** Title/singer/album filter words — songs containing any are skipped. */
  filterWords: (process.env.FILTER_WORDS || '')
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean),
  tgBotToken: process.env.TG_BOT_TOKEN || '',
  tgChatId: String(process.env.TG_CHAT_ID || '').trim(),
  tgProxy: String(process.env.TG_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY || '').trim(),
  /** 是否 getUpdates 收命令。false 时只发通知，避免和 MoviePilot/NAS 抢同一 Token。 */
  tgListen: envBool('TG_LISTEN', true),
  tgAllowedIds: (process.env.TG_ALLOWED_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => !Number.isNaN(n)),
  allowUnsafeVM: envBool('ALLOW_UNSAFE_VM', true),
}

export const QUALITY_RANK = {
  '128k': 1,
  '192k': 2,
  '320k': 3,
  flac: 4,
  flac24bit: 5,
  hires: 6,
  atmos: 7,
  atmos_plus: 8,
  master: 9,
  '24bit': 5,
}

export const QUALITY_ORDER_DESC = Object.entries(QUALITY_RANK)
  .sort((a, b) => b[1] - a[1])
  .map(([k]) => k)

export function qualityRank(q) {
  if (!q) return 0
  return QUALITY_RANK[String(q).toLowerCase()] || 0
}
