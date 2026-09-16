import { Bot, InlineKeyboard, GrammyError, HttpError } from 'grammy'
import tunnel from 'tunnel'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { config } from '../config.js'
import * as music from '../services/music.js'
import * as download from '../services/download.js'
import { setTelegramNotify } from './notify.js'
import * as settings from '../services/settings.js'
import { findMissingLyrics } from '../services/librarySync.js'

const PLATFORMS = new Set(['kw', 'kg', 'tx', 'wy', 'mg'])
const PLATFORM_LABEL = {
  kw: '酷我',
  kg: '酷狗',
  tx: 'QQ',
  wy: '网易',
  mg: '咪咕',
}

function platformLabel(source) {
  const id = String(source || '').toLowerCase()
  return PLATFORM_LABEL[id] || source || ''
}
const BOT_COMMANDS = [
  { command: 'start', description: '使用说明' },
  { command: 'search', description: '搜索歌曲，例 /search 晴天' },
  { command: 'id', description: '查看当前 Chat ID' },
  { command: 'jobs', description: '最近下载任务' },
  { command: 'lyrics', description: '扫描缺少歌词的歌曲' },
  { command: 'playlist', description: '搜索歌单，例 /playlist 周杰伦' },
]

const songCache = new Map()
const plCache = new Map()
let currentBot = null
let botReady = false
let lastTgError = ''

setInterval(() => {
  const now = Date.now()
  for (const [k, v] of songCache) {
    if (v.exp < now) songCache.delete(k)
  }
  for (const [k, v] of plCache) {
    if (v.exp < now) plCache.delete(k)
  }
}, 10 * 60 * 1000).unref?.()

function sanitizeTgError(err) {
  return String(err?.message || err || 'unknown')
    .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot<token>')
    .replace(/\d{8,}:[A-Za-z0-9_-]{20,}/g, '<token>')
}

function normalizeProxyUrl(raw) {
  let url = String(raw || '').trim()
  if (!url) return ''
  if (!url.includes('://')) url = `http://${url}`
  // 国内 DNS 常污染 api.telegram.org；socks5h 由代理解析域名
  if (/^socks5:\/\//i.test(url)) url = url.replace(/^socks5:/i, 'socks5h:')
  else if (/^socks:\/\//i.test(url)) url = `socks5h://${url.slice('socks://'.length)}`
  return url
}

function telegramAgent() {
  const url = normalizeProxyUrl(config.tgProxy || process.env.TG_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY || '')
  if (!url) return undefined
  const u = new URL(url)
  console.log(`[tg] proxy ${u.protocol}//${u.hostname}:${u.port || (u.protocol.startsWith('socks') ? '1080' : '80')}`)
  if (u.protocol.startsWith('socks')) {
    return new SocksProxyAgent(url)
  }
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
  const proxyAuth = u.username
    ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`
    : undefined
  return tunnel.httpsOverHttp({
    proxy: { host: u.hostname, port, proxyAuth },
  })
}

function putSong(song) {
  const id = Math.random().toString(36).slice(2, 10)
  songCache.set(id, { song, exp: Date.now() + 45 * 60 * 1000 })
  return id
}

function takeSong(id) {
  const row = songCache.get(id)
  if (!row) return null
  if (row.exp < Date.now()) {
    songCache.delete(id)
    return null
  }
  return row.song
}

function putPl(pl) {
  const id = Math.random().toString(36).slice(2, 10)
  plCache.set(id, { pl, exp: Date.now() + 45 * 60 * 1000 })
  return id
}

function getPl(id) {
  const row = plCache.get(id)
  if (!row) return null
  if (row.exp < Date.now()) {
    plCache.delete(id)
    return null
  }
  return row.pl
}

function looksLikePlaylistRef(input) {
  const s = String(input || '').trim()
  if (!s) return false
  if (/^https?:\/\//i.test(s)) return true
  if (/music\.163\.com|163cn\.tv|y\.qq\.com|kugou\.com|kuwo\.cn|migu\.cn/i.test(s)) return true
  return /^(kw|kg|tx|wy|mg)[:/]/i.test(s)
}

function parseSearchInput(text) {
  const parts = String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!parts.length) return ''
  const last = parts[parts.length - 1].toLowerCase()
  if (PLATFORMS.has(last) && parts.length > 1) return parts.slice(0, -1).join(' ')
  return parts.join(' ')
}

function isAllowed(ctx) {
  const chatId = String(config.tgChatId || '').trim()
  if (chatId) {
    return String(ctx.chat?.id) === chatId || String(ctx.from?.id) === chatId
  }
  if (config.tgAllowedIds.length) {
    const uid = ctx.from?.id
    const cid = ctx.chat?.id
    return config.tgAllowedIds.includes(uid) || config.tgAllowedIds.includes(cid)
  }
  return true
}

async function replySearch(ctx, raw) {
  const keyword = parseSearchInput(raw)
  if (!keyword) {
    return ctx.reply('用法: /search 关键词\n直接发歌名也可以搜。')
  }
  try {
    await ctx.reply(`正在搜索「${keyword}」…`)
    const data = await music.searchMerged({ keyword, page: 1, limit: 8 })
    const list = data?.list || []
    if (!list.length) return ctx.reply(`没有结果：${keyword}`)
    const lines = list.map((s, i) => {
      const album = s.albumName || s.album || ''
      const from = platformLabel(s.source)
      const title = `${s.name || ''} — ${s.singer || ''}`.trim()
      const head = from ? `${title}（${from}）` : title
      return `${i + 1}. ${head}${album ? `\n   ${album}` : ''}`
    })
    const keyboard = new InlineKeyboard()
    list.forEach((s, i) => {
      const id = putSong(s)
      keyboard.text(`下载 ${i + 1}`, `dl:${id}`)
      if (i % 2 === 1 || i === list.length - 1) keyboard.row()
    })
    await ctx.reply(`「${keyword}」${list.length} 条\n\n${lines.join('\n\n')}\n\n点按钮下载`, {
      reply_markup: keyboard,
    })
  } catch (e) {
    await ctx.reply(`搜索失败: ${e.message}`)
  }
}

const PL_PAGE = 8

async function loadPlaylistSongs(pl, needCount = Infinity) {
  pl.songs = pl.songs || []
  pl.sdkPage = pl.sdkPage || 0
  while (pl.songs.length < needCount && !pl.sdkEnd && pl.sdkPage < 20) {
    pl.sdkPage += 1
    const data = await music.getSongListDetail({ source: pl.source, id: pl.id, page: pl.sdkPage })
    const list = settings.applyFilterWords(data?.list || []).map((s) => ({
      ...s,
      source: s.source || pl.source,
    }))
    if (data?.name && !pl.name) pl.name = data.name
    pl.songs.push(...list)
    if (!list.length || data?.isEnd) pl.sdkEnd = true
  }
  return pl
}

function playlistSongLine(s, i) {
  const from = platformLabel(s.source)
  const title = `${s.name || ''} — ${s.singer || ''}`.trim()
  const album = s.albumName || s.album || ''
  const head = from ? `${title}（${from}）` : title
  return `${i}. ${head}${album ? `\n   ${album}` : ''}`
}

async function replyPlaylistPage(ctx, pid, page, { edit = false } = {}) {
  const pl = getPl(pid)
  if (!pl) {
    const msg = '歌单已过期，请重新搜索。'
    if (edit) {
      try {
        await ctx.editMessageText(msg)
        return
      } catch {}
    }
    return ctx.reply(msg)
  }
  const p = Math.max(1, page)
  await loadPlaylistSongs(pl, p * PL_PAGE + 1)
  const songs = pl.songs || []
  const hasPrev = p > 1
  const hasNext = songs.length > p * PL_PAGE
  const slice = songs.slice((p - 1) * PL_PAGE, p * PL_PAGE)
  const from = platformLabel(pl.source)
  const title = pl.name || '歌单'
  const count = pl.sdkEnd ? `${songs.length} 首` : `${songs.length}+ 首`
  const head = `${title}${from ? `（${from}）` : ''}\n第 ${p} 页 · ${count}`
  const lines = slice.map((s, i) => playlistSongLine(s, (p - 1) * PL_PAGE + i + 1))
  const keyboard = new InlineKeyboard()
  slice.forEach((s, i) => {
    const id = putSong(s)
    keyboard.text(`下载 ${(p - 1) * PL_PAGE + i + 1}`, `dl:${id}`)
    if (i % 2 === 1 || i === slice.length - 1) keyboard.row()
  })
  if (hasPrev || hasNext) {
    if (hasPrev) keyboard.text('上一页', `pp:${pid}:${p - 1}`)
    if (hasNext) keyboard.text('下一页', `pp:${pid}:${p + 1}`)
    keyboard.row()
  }
  keyboard.text('下载本页', `pw:${pid}:${p}`).text('下载全部', `pa:${pid}`)
  const text = `${head}\n\n${lines.join('\n\n') || '这个歌单是空的'}`
  if (edit) {
    try {
      await ctx.editMessageText(text, { reply_markup: keyboard })
      return
    } catch {}
  }
  await ctx.reply(text, { reply_markup: keyboard })
}

function jobTypeLabel(type) {
  if (type === 'lyric_fill') return '补歌词'
  if (type === 'playlist') return '歌单'
  return '下载'
}

function formatJobItemLine(job, it) {
  const title = `${it.name || ''} — ${it.singer || ''}`.trim() || String(it.songmid || '')
  if (job.type === 'lyric_fill') {
    if (it.status === 'done') return `✅ ${title}`
    if (/lyric not found/i.test(it.message || '')) return `· ${title}`
    if (it.status === 'skipped') return `⏭ ${title}`
    if (it.status === 'failed') return `❌ ${title}`
    return `· ${title}`
  }
  if (it.status === 'done') return `✅ ${title}`
  if (it.status === 'running') return `⏳ ${title}`
  if (it.status === 'pending') return `· ${title}`
  if (it.status === 'cancelled') return `⏹ ${title}`
  if (it.status === 'failed') return `❌ ${title}`
  if (it.status === 'skipped') {
    if (/已在曲库|equal|higher/i.test(it.message || '')) return `⏭ ${title}  曲库已有`
    if (/filter/i.test(it.message || '')) return `⏭ ${title}  命中过滤词`
    return `⏭ ${title}`
  }
  return `· ${title}`
}

function formatJobBlock(job) {
  const items = job.items || []
  const done = items.filter((i) => i.status === 'done').length
  const skipped = items.filter((i) => i.status === 'skipped').length
  const failed = items.filter((i) => i.status === 'failed').length
  const kind = jobTypeLabel(job.type)
  let head
  if (job.status === 'running' || job.status === 'pending') {
    head = `${kind}中 · #${job.id}（${done + skipped}/${items.length || job.total || 0}）`
  } else if (job.type === 'lyric_fill' && skipped && !done && !failed) {
    head = `${kind} · #${job.id}\n这 ${skipped} 首${skipped === items.length ? '都' : ''}没找到歌词`
  } else if (job.type === 'lyric_fill' && done && !failed) {
    head = `${kind}完成 · #${job.id}`
  } else if (failed && !done) {
    head = `${kind}失败 · #${job.id}`
  } else if (job.status === 'cancelled') {
    head = `${kind}已取消 · #${job.id}`
  } else {
    head = `${kind}完成 · #${job.id}`
  }
  const shown = items.slice(0, 12)
  const extra = items.length - shown.length
  const lines = shown.map((it) => formatJobItemLine(job, it))
  if (extra > 0) lines.push(`· …还有 ${extra} 首`)
  return lines.length ? `${head}\n${lines.join('\n')}` : head
}

function createBot(token) {
  const agent = telegramAgent()
  const bot = new Bot(token, {
    client: agent
      ? {
          baseFetchConfig: { compress: true, agent, duplex: 'half' },
        }
      : {},
  })

  bot.use(async (ctx, next) => {
    const text = ctx.message?.text || ctx.callbackQuery?.data || ''
    console.log('[tg] update', ctx.chat?.id, text)
    try {
      await next()
    } catch (e) {
      console.error('[tg] handler', sanitizeTgError(e))
      try {
        await ctx.reply(`处理失败: ${e.message || e}`)
      } catch {}
    }
  })

  bot.use(async (ctx, next) => {
    if (isAllowed(ctx)) return next()
    await ctx.reply(
      `未授权。当前 Chat ID：${ctx.chat?.id}\n请把这个数字填到网页「设置 → Bot Chat ID」，保存后再试。`
    )
  })

  bot.command('start', async (ctx) => {
    await ctx.reply(
      [
        '音乐下载机器人',
        '',
        '直接发送歌名即可搜索',
        '/search 晴天',
        '/playlist 周杰伦',
        '/id  查看 Chat ID',
        '/jobs  最近任务',
        '/lyrics  扫描缺少歌词',
      ].join('\n')
    )
  })

  bot.command('id', async (ctx) => {
    await ctx.reply(`Chat ID: ${ctx.chat?.id}\nUser ID: ${ctx.from?.id || '-'}`)
  })

  bot.command('search', async (ctx) => {
    await replySearch(ctx, ctx.match || '')
  })

  bot.command('dl', async (ctx) => {
    const parts = (ctx.match || '').trim().split(/\s+/).filter(Boolean)
    if (parts.length < 2) return ctx.reply('用法: /dl <平台> <songmid> [歌名] [歌手]')
    const [source, songmid, ...rest] = parts
    const name = rest[0] || songmid
    const singer = rest.slice(1).join(' ') || 'Unknown'
    try {
      const job = download.enqueueSongs([{ source, songmid, name, singer }], {
        type: 'tg',
        quality: config.preferredQuality,
      })
      await ctx.reply(`已入队 #${job.id}: ${name} - ${singer}`)
    } catch (e) {
      await ctx.reply(`失败: ${e.message}`)
    }
  })

  bot.command('playlist', async (ctx) => {
    const input = String(ctx.match || '').trim()
    if (!input) {
      return ctx.reply('用法: /playlist 关键词\n也可以发歌单链接。')
    }
    try {
      if (looksLikePlaylistRef(input)) {
        const detected = music.detectPlaylistSource(input)
        const pid = putPl({ source: detected.source, id: detected.id, name: '', songs: [], loaded: false })
        await ctx.reply('正在打开歌单…')
        await replyPlaylistPage(ctx, pid, 1)
        return
      }
      const keyword = parseSearchInput(input)
      await ctx.reply(`正在搜索歌单「${keyword}」…`)
      const data = await music.searchMergedPlaylists({ keyword, page: 1, limit: 8 })
      const list = data?.list || []
      if (!list.length) return ctx.reply(`没有找到相关歌单：${keyword}`)
      const lines = list.map((p, i) => {
        const from = platformLabel(p.source)
        const count = p.total ? ` · ${p.total} 首` : ''
        const author = p.author ? ` — ${p.author}` : ''
        return `${i + 1}. ${p.name || '未命名歌单'}${author}${from ? `（${from}）` : ''}${count}`
      })
      const keyboard = new InlineKeyboard()
      list.forEach((p, i) => {
        const id = putPl({ ...p, songs: [], loaded: false })
        keyboard.text(`打开 ${i + 1}`, `pl:${id}`)
        if (i % 2 === 1 || i === list.length - 1) keyboard.row()
      })
      await ctx.reply(`「${keyword}」${list.length} 个歌单\n\n${lines.join('\n\n')}\n\n点按钮打开`, {
        reply_markup: keyboard,
      })
    } catch (e) {
      await ctx.reply(`失败: ${e.message}`)
    }
  })

  bot.command('jobs', async (ctx) => {
    const list = download.listJobs().slice(0, 8)
    if (!list.length) return ctx.reply('还没有任务。')
    const jobs = list.map((j) => download.getJob(j.id) || j)
    const blocks = jobs.map((j) => formatJobBlock(j))
    const text = blocks.join('\n\n')
    const keyboard = new InlineKeyboard()
    let hasCancel = false
    for (const job of jobs) {
      if (job.status === 'running' || job.status === 'pending') {
        keyboard.text(`取消 #${job.id}`, `cj:${job.id}`).row()
        hasCancel = true
      }
    }
    const opts = hasCancel ? { reply_markup: keyboard } : undefined
    if (text.length <= 3500) {
      await ctx.reply(text, opts)
      return
    }
    let chunk = ''
    for (const block of blocks) {
      const next = chunk ? `${chunk}\n\n${block}` : block
      if (next.length > 3500 && chunk) {
        await ctx.reply(chunk)
        chunk = block
      } else {
        chunk = next
      }
    }
    if (chunk) await ctx.reply(chunk, opts)
  })

  bot.command('lyrics', async (ctx) => {
    const arg = String(ctx.match || '').trim().toLowerCase()
    if (arg === 'fill' || arg === '补') {
      const missing = await findMissingLyrics({ limit: 500 })
      if (!missing.length) return ctx.reply('曲库里的歌都已经有歌词了。')
      download.enqueueLyricFill(missing)
      return
    }
    await ctx.reply('正在扫描缺少歌词的歌曲…')
    const missing = await findMissingLyrics({ limit: 200 })
    if (!missing.length) return ctx.reply('曲库里的歌都已经有歌词了。')
    const lines = missing.slice(0, 30).map((t, i) => `${i + 1}. ${t.name || ''} — ${t.singer || ''}`.trim())
    const extra = missing.length > 30 ? `\n…还有 ${missing.length - 30} 首` : ''
    const keyboard = new InlineKeyboard().text('全部补歌词', 'lyrics:fill')
    await ctx.reply(`找到 ${missing.length} 首缺少歌词：\n\n${lines.join('\n')}${extra}`, {
      reply_markup: keyboard,
    })
  })

  bot.callbackQuery(/^dl:(.+)$/, async (ctx) => {
    const id = ctx.match[1]
    const song = takeSong(id)
    if (!song) {
      await ctx.answerCallbackQuery({ text: '结果已过期，请重新搜索', show_alert: true })
      return
    }
    try {
      const job = download.enqueueSongs([song], { type: 'tg', quality: config.preferredQuality })
      const title = `${song.name || ''} - ${song.singer || ''}`.trim()
      await ctx.answerCallbackQuery({ text: '已加入下载队列' })
      await ctx.reply(`已入队 #${job.id}: ${title}`)
    } catch (e) {
      await ctx.answerCallbackQuery({ text: e.message || '失败', show_alert: true })
    }
  })

  bot.callbackQuery(/^pl:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    await replyPlaylistPage(ctx, ctx.match[1], 1)
  })

  bot.callbackQuery(/^pp:(.+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    await replyPlaylistPage(ctx, ctx.match[1], Number(ctx.match[2]), { edit: true })
  })

  bot.callbackQuery(/^pw:(.+):(\d+)$/, async (ctx) => {
    const pl = getPl(ctx.match[1])
    const page = Number(ctx.match[2])
    if (!pl) {
      await ctx.answerCallbackQuery({ text: '歌单已过期，请重新搜索', show_alert: true })
      return
    }
    try {
      await loadPlaylistSongs(pl, page * PL_PAGE)
      const slice = (pl.songs || []).slice((page - 1) * PL_PAGE, page * PL_PAGE)
      if (!slice.length) {
        await ctx.answerCallbackQuery({ text: '这一页是空的', show_alert: true })
        return
      }
      download.enqueueSongs(slice, { type: 'playlist', quality: config.preferredQuality })
      await ctx.answerCallbackQuery({ text: `本页 ${slice.length} 首已加入下载` })
    } catch (e) {
      await ctx.answerCallbackQuery({ text: e.message || '失败', show_alert: true })
    }
  })

  bot.callbackQuery(/^pa:(.+)$/, async (ctx) => {
    const pl = getPl(ctx.match[1])
    if (!pl) {
      await ctx.answerCallbackQuery({ text: '歌单已过期，请重新搜索', show_alert: true })
      return
    }
    try {
      await ctx.answerCallbackQuery({ text: '正在加入下载' })
      await loadPlaylistSongs(pl)
      if (!pl.songs?.length) {
        await ctx.reply('这个歌单是空的。')
        return
      }
      download.enqueueSongs(pl.songs, {
        type: 'playlist',
        quality: config.preferredQuality,
        payload: { source: pl.source, id: pl.id },
      })
    } catch (e) {
      try {
        await ctx.reply(`失败: ${e.message}`)
      } catch {}
    }
  })

  bot.callbackQuery(/^cj:(\d+)$/, async (ctx) => {
    const job = download.cancelJob(Number(ctx.match[1]))
    await ctx.answerCallbackQuery({ text: job ? '已取消整个任务' : '已经结束了' })
    try {
      await ctx.editMessageReplyMarkup()
    } catch {}
  })

  bot.callbackQuery('lyrics:fill', async (ctx) => {
    try {
      await ctx.answerCallbackQuery()
      const missing = await findMissingLyrics({ limit: 500 })
      if (!missing.length) {
        await ctx.reply('曲库里的歌都已经有歌词了。')
        return
      }
      download.enqueueLyricFill(missing)
    } catch (e) {
      try {
        await ctx.reply(`失败: ${e.message}`)
      } catch {}
    }
  })

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text || ''
    if (text.startsWith('/')) {
      await ctx.reply('可用命令：/start /search /id /jobs /lyrics /playlist\n也可以直接发送歌名搜索。')
      return
    }
    await replySearch(ctx, text)
  })

  bot.catch((err) => {
    const ctx = err.ctx
    console.error(`[tg] error for ${ctx?.update?.update_id}:`, sanitizeTgError(err.error))
    const e = err.error
    if (e instanceof GrammyError) console.error('[tg] grammy:', e.description)
    else if (e instanceof HttpError) console.error('[tg] http:', e)
  })

  return bot
}

export function isTelegramRunning() {
  return botReady && !!currentBot
}

export function telegramStatus() {
  const running = isTelegramRunning()
  return {
    running,
    polling: running && config.tgListen !== false,
    listen: config.tgListen !== false,
    error: lastTgError,
    username: currentBot?.botInfo?.username || '',
  }
}

async function withTimeout(promise, ms, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

let restartChain = Promise.resolve()
let botGeneration = 0
let pollAbort = null

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function isAbortError(err) {
  return err?.name === 'AbortError' || /aborted/i.test(String(err?.message || err || ''))
}

function isConflictError(err) {
  return /409|Conflict/.test(sanitizeTgError(err))
}

async function warnConflict(bot) {
  const chatId = String(config.tgChatId || '').trim()
  if (!chatId) return
  try {
    await bot.api.sendMessage(
      chatId,
      '本机已改为仅发送下载通知，不再抢收消息。命令请继续发给 MoviePilot / NAS 上的 Bot。若要在本机搜歌下载，请用 @BotFather 另建一个 Bot，把新 Token 填到本机设置。'
    )
  } catch (e) {
    console.warn('[tg] conflict notice:', sanitizeTgError(e))
  }
}

async function pollLoop(bot, gen) {
  let offset = 0
  let backoff = 8000
  let conflictNotified = false
  while (gen === botGeneration) {
    const ac = new AbortController()
    pollAbort = ac
    try {
      const updates = await bot.api.getUpdates(
        {
          offset,
          timeout: 10,
          limit: 50,
          allowed_updates: ['message', 'callback_query'],
        },
        ac.signal
      )
      if (gen !== botGeneration) return
      backoff = 8000
      lastTgError = ''
      botReady = true
      conflictNotified = false
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1)
        try {
          await bot.handleUpdate(update)
        } catch (e) {
          console.error('[tg] handleUpdate', sanitizeTgError(e))
        }
      }
    } catch (e) {
      if (gen !== botGeneration || isAbortError(e)) return
      if (isConflictError(e)) {
        console.warn('[tg] getUpdates 冲突，改为仅通知，命令留给其他程序')
        config.tgListen = false
        try {
          settings.updateSettings({ tgListen: false })
        } catch (err) {
          console.warn('[tg] persist listen:', sanitizeTgError(err))
        }
        lastTgError = ''
        botReady = true
        if (!conflictNotified) {
          conflictNotified = true
          await warnConflict(bot)
        }
        return
      }
      lastTgError = sanitizeTgError(e)
      botReady = false
      console.error('[tg] poll:', lastTgError)
      await sleep(4000)
    }
  }
}

async function restartTelegramBotNow() {
  const myGen = ++botGeneration
  try {
    pollAbort?.abort()
  } catch {}
  pollAbort = null
  currentBot = null
  botReady = false
  lastTgError = ''
  setTelegramNotify(null)

  const token = String(config.tgBotToken || '').trim()
  if (!token) {
    console.log('[tg] token empty, bot off')
    return { running: false }
  }

  if (myGen !== botGeneration) return { running: false }

  const listen = config.tgListen !== false
  const bot = createBot(token)
  try {
    await withTimeout(bot.init(), 20000, '连接 Telegram 超时（请确认代理已开启）')
    if (myGen !== botGeneration) return { running: false }
    if (listen) {
      await bot.api.deleteWebhook({ drop_pending_updates: false })
      await bot.api.setMyCommands(BOT_COMMANDS)
    }
  } catch (e) {
    lastTgError = sanitizeTgError(e)
    console.error('[tg] init failed:', lastTgError)
    return { running: false, error: lastTgError }
  }

  setTelegramNotify(async (text) => {
    const chatId = String(config.tgChatId || '').trim()
    if (!chatId) return
    await bot.api.sendMessage(chatId, text, { disable_web_page_preview: true })
  })

  currentBot = bot
  botReady = true
  const username = bot.botInfo?.username || ''
  if (listen) {
    console.log(`[tg] bot @${username} polling`)
    pollLoop(bot, myGen)
  } else {
    console.log(`[tg] bot @${username} notify-only`)
  }
  return { running: true, username }
}

export function restartTelegramBot() {
  restartChain = restartChain.then(restartTelegramBotNow, restartTelegramBotNow)
  return restartChain
}
