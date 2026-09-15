import { fork } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import { extractMetadata } from './index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workerPath = path.join(__dirname, 'worker.js')

const children = new Map() // id -> { proc, info, pending, sortOrder, enabled }

function makeId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export async function loadSourceInWorker(apiInfo, { timeoutMs = 12000 } = {}) {
  await unloadWorker(apiInfo.id)

  const proc = fork(workerPath, [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, FORCE_COLOR: '0' },
  })

  const pending = new Map()
  const state = {
    proc,
    info: { ...apiInfo, sources: {} },
    pending,
    sortOrder: apiInfo.sortOrder ?? 999,
    enabled: !!apiInfo.enabled,
    ready: false,
  }
  children.set(apiInfo.id, state)

  proc.stdout?.on('data', (buf) => {
    const s = buf.toString().trim()
    if (s) console.log(`[src:${apiInfo.name}]`, s.slice(0, 300))
  })
  proc.stderr?.on('data', (buf) => {
    const s = buf.toString().trim()
    if (s) console.warn(`[src:${apiInfo.name}:err]`, s.slice(0, 300))
  })

  proc.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'inited') {
      state.info.sources = msg.sources || {}
      state.info.name = msg.name || state.info.name
      state.info.version = msg.version || state.info.version
      state.ready = true
      return
    }
    if (msg.type === 'response' && msg.reqId && pending.has(msg.reqId)) {
      const { resolve, reject } = pending.get(msg.reqId)
      pending.delete(msg.reqId)
      if (msg.error) reject(new Error(msg.error))
      else resolve(msg.result)
    }
  })

  proc.on('exit', (code, signal) => {
    for (const [, p] of pending) p.reject(new Error(`source worker exited (${code || signal})`))
    pending.clear()
    if (children.get(apiInfo.id)?.proc === proc) children.delete(apiInfo.id)
  })

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {}
      resolve({ success: false, error: 'worker init timeout' })
    }, timeoutMs)

    const onMsg = (msg) => {
      if (msg?.type === 'inited') {
        clearTimeout(timer)
        proc.off('message', onMsg)
        resolve({ success: true, error: null })
      } else if (msg?.type === 'failed') {
        clearTimeout(timer)
        proc.off('message', onMsg)
        try {
          proc.kill('SIGKILL')
        } catch {}
        resolve({ success: false, error: msg.error || 'init failed' })
      }
    }
    proc.on('message', onMsg)
    proc.on('exit', () => {
      clearTimeout(timer)
      resolve({ success: false, error: 'worker crashed during init' })
    })

    proc.send({
      type: 'load',
      apiInfo: {
        id: apiInfo.id,
        name: apiInfo.name,
        description: apiInfo.description,
        version: apiInfo.version,
        author: apiInfo.author,
        homepage: apiInfo.homepage,
        script: apiInfo.script,
        allowUnsafeVM: !!apiInfo.allowUnsafeVM,
      },
    })
  })

  if (!result.success) {
    children.delete(apiInfo.id)
    return result
  }
  return { success: true, apiInstance: { info: state.info }, error: null }
}

export async function unloadWorker(id) {
  const state = children.get(id)
  if (!state) return
  try {
    state.proc.kill('SIGKILL')
  } catch {}
  children.delete(id)
}

export async function unloadAllWorkers() {
  const ids = [...children.keys()]
  for (const id of ids) await unloadWorker(id)
}

export function getWorkerApis() {
  return [...children.values()].map((s) => ({
    ...s.info,
    enabled: s.enabled,
    sortOrder: s.sortOrder,
  }))
}

export function callWorkerRequest(id, action, source, info, timeoutMs = 20000) {
  const state = children.get(id)
  if (!state?.ready) return Promise.reject(new Error(`source ${id} not ready`))
  const reqId = makeId()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(reqId)
      reject(new Error('request timeout'))
    }, timeoutMs)
    state.pending.set(reqId, {
      resolve: (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      },
    })
    try {
      state.proc.send({ type: 'request', reqId, action, source, info })
    } catch (e) {
      clearTimeout(timer)
      state.pending.delete(reqId)
      reject(e)
    }
  })
}

export async function getMusicUrlViaWorkers(platform, songInfo, quality, { preferredOrder, excludeSourceIds = [] } = {}) {
  const exclude = new Set(excludeSourceIds)
  const list = [...children.values()]
    .filter((s) => s.enabled && s.ready && s.info.sources?.[platform] && !exclude.has(s.info.id))
    .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999))

  if (preferredOrder?.length) {
    list.sort((a, b) => {
      const ia = preferredOrder.indexOf(a.info.id)
      const ib = preferredOrder.indexOf(b.info.id)
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
    })
  }

  if (!list.length) throw new Error(`没有启用的自定义源支持平台 ${platform}`)

  const qualities = buildQualityCandidates(songInfo, quality)
  const errors = []

  for (const q of qualities) {
    for (const s of list) {
      const meta = s.info.sources[platform]
      const supported = meta?.qualitys || meta?.quality || []
      if (supported.length && !supported.map(String).includes(String(q))) continue
      try {
        const url = await callWorkerRequest(s.info.id, 'musicUrl', platform, {
          type: q,
          musicInfo: songInfo,
        })
        if (url && typeof url === 'string' && /^https?:\/\//i.test(url)) {
          return { url, quality: q, sourceId: s.info.id, sourceName: s.info.name }
        }
        errors.push(`${s.info.name}@${q}: invalid url`)
      } catch (e) {
        errors.push(`${s.info.name}@${q}: ${e.message}`)
      }
    }
  }
  throw new Error(`解析播放地址失败: ${errors.slice(0, 8).join('; ')}`)
}

export async function getLyricViaWorkers(platform, songInfo) {
  for (const s of children.values()) {
    if (!s.enabled || !s.ready) continue
    const src = s.info.sources?.[platform]
    if (!src?.actions?.includes('lyric')) continue
    try {
      const result = await callWorkerRequest(s.info.id, 'lyric', platform, { musicInfo: songInfo })
      if (result?.lyric) return result
    } catch {}
  }
  return null
}

function buildQualityCandidates(songInfo, preferred) {
  const fromTypes = []
  if (Array.isArray(songInfo.types)) {
    for (const t of songInfo.types) {
      const type = typeof t === 'string' ? t : t?.type
      if (type) fromTypes.push(type)
    }
  }
  return [...new Set([preferred, 'flac24bit', 'hires', 'flac', '320k', '192k', '128k', ...fromTypes].filter(Boolean).map(String))]
}

export { extractMetadata }
