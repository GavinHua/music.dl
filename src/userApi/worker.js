import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import needle from 'needle'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const { VM } = require('vm2')
const inflate = promisify(zlib.inflate)
const deflate = promisify(zlib.deflate)

let handler = null
let apiMeta = {}

function decontextify(obj) {
  if (obj === null || obj === undefined) return obj
  if (typeof obj !== 'object') return obj
  try {
    if (Buffer.isBuffer(obj) || obj instanceof Uint8Array) return Buffer.from(Uint8Array.from(obj))
  } catch {}
  if (Array.isArray(obj)) {
    try {
      return obj.map((i) => decontextify(i))
    } catch {
      return []
    }
  }
  if (obj instanceof Error || obj?.constructor?.name === 'Error') {
    const err = new Error(obj.message)
    err.stack = obj.stack
    return err
  }
  try {
    const out = {}
    for (const k of Object.keys(obj)) {
      try {
        out[k] = decontextify(obj[k])
      } catch {}
    }
    return out
  } catch {
    try {
      return JSON.parse(JSON.stringify(obj))
    } catch {
      return String(obj)
    }
  }
}

function extractMetadata(script) {
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
        if (err) return callback(decontextify(err), null, null)
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
        callback(null, safeResp, safeResp.body)
      } catch (e) {
        callback(decontextify(e), null, null)
      }
    })
    return () => {
      try {
        request?.request?.abort?.()
      } catch {}
    }
  }
}

async function loadScript(apiInfo) {
  const metadata = extractMetadata(apiInfo.script)
  apiMeta = { ...apiInfo, ...metadata }
  let registeredSources = {}
  let initResolve
  let initReject
  const initPromise = new Promise((resolve, reject) => {
    initResolve = resolve
    initReject = reject
  })

  const lxObject = {
    version: '2.0.0',
    env: 'desktop',
    platform: 'web',
    currentScriptInfo: {
      name: apiMeta.name,
      description: apiMeta.description,
      version: apiMeta.version,
      author: apiMeta.author,
      homepage: apiMeta.homepage,
      rawScript: apiInfo.script,
    },
    EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
    utils: {
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
    },
    request: createLxRequest(),
    send: (eventName, data) => {
      const dData = decontextify(data)
      if (eventName === 'inited') {
        registeredSources = dData?.sources || {}
        if (initResolve) initResolve()
      }
    },
    on: (eventName, fn) => {
      if (eventName === 'request') handler = fn
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
      exit: () => {},
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

  const useUnsafe = !!apiInfo.allowUnsafeVM
  try {
    if (useUnsafe) {
      const context = vm.createContext(sandbox)
      vm.runInContext(apiInfo.script, context, { filename: `src_${apiInfo.id}.js`, timeout: 15000 })
    } else {
      const vmInstance = new VM({ timeout: 15000, sandbox, eval: true, wasm: false })
      await vmInstance.run(apiInfo.script)
    }
  } catch (e) {
    // fallback native if vm2 blocked
    if (!useUnsafe && /contextified|Operation not allowed|timeout/i.test(e.message || '')) {
      const context = vm.createContext(sandbox)
      vm.runInContext(apiInfo.script, context, { filename: `src_${apiInfo.id}.js`, timeout: 15000 })
    } else {
      throw e
    }
  }

  await Promise.race([
    initPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('初始化超时')), 8000)),
  ])

  return { sources: registeredSources, name: apiMeta.name, version: apiMeta.version }
}

process.on('message', async (msg) => {
  try {
    if (msg?.type === 'load') {
      const info = await loadScript(msg.apiInfo)
      process.send({ type: 'inited', ...info })
      return
    }
    if (msg?.type === 'request') {
      if (!handler) {
        process.send({ type: 'response', reqId: msg.reqId, error: 'no handler' })
        return
      }
      try {
        const result = await handler({
          action: msg.action,
          source: msg.source,
          info: msg.info,
        })
        process.send({ type: 'response', reqId: msg.reqId, result: decontextify(result) })
      } catch (e) {
        process.send({ type: 'response', reqId: msg.reqId, error: e.message || String(e) })
      }
    }
  } catch (e) {
    if (msg?.type === 'load') process.send({ type: 'failed', error: e.message || String(e) })
    else if (msg?.reqId) process.send({ type: 'response', reqId: msg.reqId, error: e.message || String(e) })
  }
})

process.on('uncaughtException', (e) => {
  try {
    process.send({ type: 'failed', error: e.message || String(e) })
  } catch {}
})
process.on('unhandledRejection', () => {})
