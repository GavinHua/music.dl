import crypto from 'node:crypto'
import needle from 'needle'
import { config } from '../config.js'
import { getMusicUrl } from './sources.js'
import { searchMusic } from './music.js'

const previewStore = new Map() // token -> { url, expires, meta }
const PREVIEW_TTL_MS = 10 * 60 * 1000

/** Well-known-ish probe songs per platform for source connectivity tests. */
const PROBE_KEYWORDS = {
  kw: '周杰伦 晴天',
  kg: '周杰伦 晴天',
  tx: '周杰伦 晴天',
  wy: '周杰伦 晴天',
  mg: '周杰伦 晴天',
}

export async function resolvePreview(musicInfo, quality) {
  const platform = musicInfo?.source || musicInfo?.platform
  if (!platform) throw new Error('缺少平台 source')
  const resolved = await getMusicUrl(platform, musicInfo, quality || config.preferredQuality)
  const token = crypto.randomBytes(12).toString('hex')
  previewStore.set(token, {
    url: resolved.url,
    expires: Date.now() + PREVIEW_TTL_MS,
    meta: {
      name: musicInfo.name,
      singer: musicInfo.singer,
      quality: resolved.quality,
      sourceName: resolved.sourceName,
    },
  })
  prunePreviewStore()
  return {
    token,
    streamPath: `/api/preview/stream/${token}`,
    quality: resolved.quality,
    sourceId: resolved.sourceId,
    sourceName: resolved.sourceName,
    name: musicInfo.name,
    singer: musicInfo.singer,
  }
}

export function getPreviewEntry(token) {
  const entry = previewStore.get(token)
  if (!entry) return null
  if (Date.now() > entry.expires) {
    previewStore.delete(token)
    return null
  }
  return entry
}

export function pipePreviewStream(token, res) {
  const entry = getPreviewEntry(token)
  if (!entry) {
    res.status(404).json({ error: 'preview expired or not found' })
    return
  }
  const timeout = Math.min(config.downloadTimeoutMs || 300000, 5 * 60 * 1000)
  const req = needle.get(entry.url, {
    follow_max: 5,
    open_timeout: 20_000,
    response_timeout: timeout,
    read_timeout: timeout,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: 'https://www.google.com/',
    },
  })
  req.on('header', (statusCode, headers) => {
    if (statusCode >= 400) {
      if (!res.headersSent) res.status(statusCode).end(`upstream ${statusCode}`)
      req.destroy()
      return
    }
    const ct = headers['content-type'] || 'audio/mpeg'
    res.setHeader('Content-Type', ct)
    if (headers['content-length']) res.setHeader('Content-Length', headers['content-length'])
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Accept-Ranges', headers['accept-ranges'] || 'none')
  })
  req.on('error', (e) => {
    if (!res.headersSent) res.status(502).json({ error: e.message })
    else res.destroy(e)
  })
  req.pipe(res)
}

function prunePreviewStore() {
  const now = Date.now()
  for (const [k, v] of previewStore) {
    if (now > v.expires) previewStore.delete(k)
  }
}

/**
 * Test a single source by searching a probe song and resolving musicUrl via that source only.
 */
export async function testSourceConnection(sourceId, { platform, quality } = {}) {
  const { getWorkerApis, getMusicUrlViaWorkers } = await import('../userApi/pool.js')
  const loaded = getWorkerApis().find((a) => a.id === sourceId)
  if (!loaded) throw new Error('音源未加载或未启用')

  const platforms = Object.keys(loaded.sources || {})
  const plat = platform && platforms.includes(platform) ? platform : platforms[0]
  if (!plat) throw new Error('该音源未声明支持的平台')

  const started = Date.now()
  const keyword = PROBE_KEYWORDS[plat] || '周杰伦'
  let song
  try {
    const data = await searchMusic({ keyword, source: plat, page: 1, limit: 5 })
    song = (data?.list || [])[0]
  } catch (e) {
    throw new Error(`搜索探测曲失败(${plat}): ${e.message}`)
  }
  if (!song) throw new Error(`平台 ${plat} 未搜到探测曲目`)

  const musicInfo = {
    ...song,
    source: song.source || plat,
  }
  const resolved = await getMusicUrlViaWorkers(plat, musicInfo, quality || '128k', {
    onlySourceId: sourceId,
  })
  return {
    ok: true,
    ms: Date.now() - started,
    platform: plat,
    song: { name: musicInfo.name, singer: musicInfo.singer },
    quality: resolved.quality,
    sourceId: resolved.sourceId,
    sourceName: resolved.sourceName,
    urlHost: safeHost(resolved.url),
  }
}

function safeHost(url) {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}
