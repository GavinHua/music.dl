import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import needle from 'needle'
import { config } from '../config.js'

const require = createRequire(import.meta.url)
const { VM } = require('vm2')

const inflate = promisify(zlib.inflate)
const deflate = promisify(zlib.deflate)

const loadedApis = new Map()

function decontextify(obj) {
  if (obj === null || obj === undefined) return obj
  if (typeof obj !== 'object') return obj
  try {
    if (Buffer.isBuffer(obj) || obj instanceof Uint8Array) {
      return Buffer.from(Uint8Array.from(obj))
    }
  } catch {}
  if (Array.isArray(obj)) {
    try {
      return obj.map((item) => decontextify(item))
    } catch {
      return []
    }
  }
  if (obj instanceof Error || (obj && obj.constructor && obj.constructor.name === 'Error')) {
    const err = new Error(obj.message)
    err.stack = obj.stack
    return err
  }
  try {
    const newObj = {}
    for (const key of Object.keys(obj)) {
      try {
        newObj[key] = decontextify(obj[key])
      } catch {}
    }
    return newObj
  } catch {
    try {
      return JSON.parse(JSON.stringify(obj))
    } catch {
      return String(obj)
    }
  }
}

export function extractMetadata(script) {
  const meta = {}
  const commentMatch = script.match(/\/\*[*!]([\s\S]*?)\*\//)
  if (!commentMatch) return meta
  const comment = commentMatch[1]
  const nameMatch = comment.match(/@name\s+(.+)/)
  if (nameMatch) meta.name = nameMatch[1].trim()
  const descMatch = comment.match(/@description\s+(.+)/)
  if (descMatch) meta.description = descMatch[1].trim()
  const verMatch = comment.match(/@version\s+(.+)/)
  if (verMatch) meta.version = verMatch[1].trim()
  const authorMatch = comment.match(/@author\s+(.+)/)
  if (authorMatch) meta.author = authorMatch[1].trim()
  const repoMatch = comment.match(/@(?:repository|homepage)\s+(.+)/)
  if (repoMatch) meta.homepage = repoMatch[1].trim()
  return meta
}

function createLxRequest() {
  return (url, options, callback) => {
    const safeOptions = decontextify(options || {})
    const { method = 'get', timeout, headers, body, form, formData } = safeOptions
    const requestOptions = {
      headers,
      follow_max: 5,
      response_timeout: typeof timeout === 'number' && timeout > 0 ? Math.min(timeout, 60000) : 60000,
    }
    let data = body
    if (form) {
      data = form
      requestOptions.json = false
    } else if (formData) {
      data = formData
      requestOptions.json = false
    }
    const request = needle.request(method, url, data, requestOptions, (err, resp, body) => {
      try {
        if (err) {
          callback.call(null, decontextify(err), null, null)
          return
        }
        let parsedBody = body
        if (typeof body === 'string') {
          try {
            parsedBody = JSON.parse(body)
          } catch {}
        }
        const safeResp = {
          statusCode: resp.statusCode,
          statusMessage: resp.statusMessage,
          headers: resp.headers,
          body: decontextify(parsedBody),
        }
        callback.call(null, null, safeResp, safeResp.body)
      } catch (error) {
        callback.call(null, decontextify(error), null, null)
      }
    })
    return () => {
      const reqObj = request?.request
      if (reqObj && !reqObj.aborted) reqObj.abort()
    }
  }
}

export async function loadUserApi(apiInfo) {
  const metadata = extractMetadata(apiInfo.script)
  const fullApiInfo = { ...apiInfo, ...metadata }
  const eventHandlers = new Map()
  let registeredSources = {}

  let initResolve
  let initReject
  const initPromise = new Promise((resolve, reject) => {
    initResolve = resolve
    initReject = reject
  })

  const lxUtils = {
    buffer: {
      from: (d, e) => Buffer.from(decontextify(d), decontextify(e)),
      bufToString: (b, f) => (Buffer.isBuffer(b) ? b.toString(f) : Buffer.from(b, 'binary').toString(f)),
    },
    crypto: {
      md5: (str) => crypto.createHash('md5').update(decontextify(str) || '').digest('hex'),
      aesEncrypt: (buffer, mode, key, iv) => {
        const dKey = decontextify(key)
        const dIv = decontextify(iv)
        const dBuffer = decontextify(buffer)
        const algorithm = `aes-${dKey.length * 8}-${mode}`
        const cipher = crypto.createCipheriv(algorithm, dKey, dIv)
        return Buffer.concat([cipher.update(dBuffer), cipher.final()])
      },
      rsaEncrypt: (buffer, key) => crypto.publicEncrypt(decontextify(key), decontextify(buffer)),
      randomBytes: (size) => crypto.randomBytes(size),
    },
    zlib: {
      inflate: (buffer) => inflate(decontextify(buffer)),
      deflate: (buffer) => deflate(decontextify(buffer)),
    },
  }

  const lxObject = {
    version: '2.0.0',
    env: 'desktop',
    platform: 'web',
    currentScriptInfo: {
      name: fullApiInfo.name,
      description: fullApiInfo.description,
      version: fullApiInfo.version,
      author: fullApiInfo.author,
      homepage: fullApiInfo.homepage,
      rawScript: fullApiInfo.script,
    },
    EVENT_NAMES: {
      request: 'request',
      inited: 'inited',
      updateAlert: 'updateAlert',
    },
    utils: lxUtils,
    request: createLxRequest(),
    send: (eventName, data) => {
      const dData = decontextify(data)
      if (eventName === 'inited') {
        if (dData?.sources) {
          registeredSources = dData.sources
          console.log(`[UserApi-${fullApiInfo.name}] sources:`, Object.keys(registeredSources).join(', '))
        }
        if (initResolve) initResolve()
      } else if (eventName === 'updateAlert') {
        console.log(`[UserApi-${fullApiInfo.name}] updateAlert:`, dData)
      }
    },
    on: (eventName, handler) => {
      if (eventName === 'request') eventHandlers.set(eventName, handler)
    },
  }

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    process: {
      nextTick: (fn, ...args) => setTimeout(() => fn(...args), 0),
      env: { NODE_ENV: process.env.NODE_ENV || 'production' },
    },
    lx: lxObject,
    global: null,
    window: null,
    globalThis: null,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    crypto,
  }
  sandbox.global = sandbox
  sandbox.window = sandbox
  sandbox.globalThis = sandbox

  const useUnsafe = !!(apiInfo.allowUnsafeVM && config.allowUnsafeVM)

  try {
    if (useUnsafe) {
      const vm = await import('node:vm')
      const context = vm.createContext(sandbox)
      vm.runInContext(apiInfo.script, context, {
        filename: `custom_source_${fullApiInfo.id}.js`,
        timeout: 15000,
      })
    } else {
      try {
        const vmInstance = new VM({
          timeout: 15000,
          sandbox,
          eval: true,
          wasm: false,
        })
        await vmInstance.run(apiInfo.script)
      } catch (e) {
        const isContextError =
          e.message?.includes('contextified object') ||
          e.message?.includes('Operation not allowed') ||
          e.message?.includes('timeout')
        if (isContextError && config.allowUnsafeVM) {
          console.warn(`[UserApi] ${fullApiInfo.name} vm2 failed, retry native vm`)
          return loadUserApi({ ...apiInfo, allowUnsafeVM: true })
        }
        throw e
      }
    }

    await Promise.race([
      initPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('初始化超时，请确保脚本调用了 lx.send("inited", ...)')), 5000)
      ),
    ])

    const apiInstance = {
      info: { ...fullApiInfo, sources: registeredSources },
      handlers: eventHandlers,
      callRequest: async (action, source, info) => {
        const handler = eventHandlers.get('request')
        if (!handler) throw new Error(`源 ${fullApiInfo.name} 未注册 request 处理器`)
        const result = await handler({ action, source, info })
        return decontextify(result)
      },
    }

    loadedApis.set(apiInfo.id, apiInstance)
    console.log(`[UserApi] ✓ ${fullApiInfo.name} v${fullApiInfo.version}`)
    return { success: true, apiInstance, error: null }
  } catch (error) {
    console.error(`[UserApi] ✗ ${fullApiInfo.name}:`, error.message)
    return { success: false, apiInstance: null, error: error.message }
  }
}

export function unloadAll() {
  loadedApis.clear()
}

export function getLoadedApis() {
  return [...loadedApis.values()].map((a) => a.info)
}

export function getApiInstance(id) {
  return loadedApis.get(id)
}

function normalizeSongInfo(songInfo) {
  const normalized = { ...songInfo }
  if (songInfo.meta) {
    Object.assign(normalized, songInfo.meta)
    if (songInfo.meta.songId && !normalized.songmid) normalized.songmid = songInfo.meta.songId
    if (songInfo.meta.picUrl && !normalized.img) normalized.img = songInfo.meta.picUrl
    if (songInfo.meta.qualitys && !normalized.types) normalized.types = songInfo.meta.qualitys
    if (songInfo.meta._qualitys && !normalized._types) normalized._types = songInfo.meta._qualitys
  }
  return normalized
}

/**
 * Resolve music URL via enabled custom sources in sort order, with quality fallback.
 */
export async function getMusicUrl(platform, songInfo, quality, { sourceIds } = {}) {
  const normalized = normalizeSongInfo(songInfo)
  const candidates = [...loadedApis.values()].filter((api) => {
    if (!api.info.enabled) return false
    if (!api.info.sources?.[platform]) return false
    if (sourceIds?.length && !sourceIds.includes(api.info.id)) return false
    return true
  })

  // Prefer preferred source order from info.sortOrder if present
  candidates.sort((a, b) => (a.info.sortOrder ?? 999) - (b.info.sortOrder ?? 999))

  if (!candidates.length) {
    throw new Error(`没有启用的自定义源支持平台 ${platform}`)
  }

  const qualities = buildQualityCandidates(platform, normalized, quality)
  const errors = []

  for (const q of qualities) {
    for (const api of candidates) {
      const sourceMeta = api.info.sources[platform]
      const supported = sourceMeta?.qualitys || sourceMeta?.quality || []
      if (supported.length && !supported.includes(q) && !supported.includes(String(q))) {
        continue
      }
      try {
        const url = await api.callRequest('musicUrl', platform, {
          type: q,
          musicInfo: normalized,
        })
        if (url && typeof url === 'string' && /^https?:\/\//i.test(url)) {
          return { url, quality: q, sourceId: api.info.id, sourceName: api.info.name }
        }
        errors.push(`${api.info.name}@${q}: invalid url`)
      } catch (e) {
        errors.push(`${api.info.name}@${q}: ${e.message}`)
      }
    }
  }

  throw new Error(`解析播放地址失败: ${errors.slice(0, 8).join('; ')}`)
}

export async function getLyricFromSources(platform, songInfo) {
  const normalized = normalizeSongInfo(songInfo)
  for (const api of loadedApis.values()) {
    if (!api.info.enabled) continue
    const src = api.info.sources?.[platform]
    if (!src) continue
    const actions = src.actions || []
    if (!actions.includes('lyric')) continue
    try {
      const result = await api.callRequest('lyric', platform, { musicInfo: normalized })
      if (result?.lyric) return result
    } catch {}
  }
  return null
}

function buildQualityCandidates(platform, songInfo, preferred) {
  const fromTypes = []
  if (Array.isArray(songInfo.types)) {
    for (const t of songInfo.types) {
      const type = typeof t === 'string' ? t : t?.type
      if (type) fromTypes.push(type)
    }
  }
  const order = [
    preferred,
    'flac24bit',
    'hires',
    'flac',
    '320k',
    '192k',
    '128k',
    ...fromTypes,
  ].filter(Boolean)
  return [...new Set(order.map((q) => String(q)))]
}

export function sourceIdFromFilename(filename) {
  return path
    .basename(filename, path.extname(filename))
    .replace(/[^\w\u4e00-\u9fff.-]+/g, '_')
    .slice(0, 80)
}

export async function downloadScript(url) {
  const resp = await needle('get', url, null, {
    follow_max: 5,
    response_timeout: 30000,
    parse_response: false,
  })
  if (resp.statusCode >= 400) throw new Error(`下载脚本失败 HTTP ${resp.statusCode}`)
  const body = Buffer.isBuffer(resp.body) ? resp.body.toString('utf8') : String(resp.raw || resp.body)
  if (!body.includes('EVENT_NAMES') && !body.includes('globalThis.lx') && !body.includes('window.lx')) {
    // obfuscated scripts may not contain plain markers; still accept .js
    if (!/\.js(\?|$)/i.test(url) && body.length < 50) throw new Error('不是有效的音源脚本')
  }
  return body
}

export function writeSourceFile(filename, content) {
  fs.mkdirSync(config.sourceDir, { recursive: true })
  const safe = path.basename(filename).replace(/[\\/]/g, '')
  const full = path.join(config.sourceDir, safe.endsWith('.js') ? safe : `${safe}.js`)
  fs.writeFileSync(full, content, 'utf8')
  return full
}
