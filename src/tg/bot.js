import { Bot, GrammyError, HttpError } from 'grammy'
import { config } from '../config.js'
import * as music from '../services/music.js'
import * as download from '../services/download.js'

export function startTelegramBot() {
  if (!config.tgBotToken) {
    console.log('[tg] TG_BOT_TOKEN not set, skip')
    return null
  }

  const bot = new Bot(config.tgBotToken)

  bot.use(async (ctx, next) => {
    const id = ctx.from?.id
    if (config.tgAllowedIds.length && !config.tgAllowedIds.includes(id)) {
      await ctx.reply('未授权的用户')
      return
    }
    await next()
  })

  bot.command('start', async (ctx) => {
    await ctx.reply(
      [
        '音乐下载机器人',
        '/search <关键词> [平台]',
        '/dl <平台> <songmid> [歌名] [歌手]',
        '/playlist <歌单URL或 平台:id>',
        '/artist <平台> <歌手id>',
        '/lyric <平台> <songmid>',
        '/jobs',
      ].join('\n')
    )
  })

  bot.command('search', async (ctx) => {
    const text = ctx.match?.trim() || ''
    const parts = text.split(/\s+/).filter(Boolean)
    if (!parts.length) return ctx.reply('用法: /search 关键词 [平台]')
    let source = 'kw'
    let keyword = text
    const last = parts[parts.length - 1]
    if (['kw', 'kg', 'tx', 'wy', 'mg'].includes(last) && parts.length > 1) {
      source = last
      keyword = parts.slice(0, -1).join(' ')
    }
    try {
      const data = await music.searchMusic({ keyword, source, page: 1, limit: 10 })
      const list = data?.list || []
      if (!list.length) return ctx.reply('没有结果')
      const lines = list.map((s, i) => {
        const mid = s.songmid || s.hash || s.id
        return `${i + 1}. ${s.name} - ${s.singer}\n   ${s.source}/${mid}`
      })
      await ctx.reply(`搜索结果 (${source}):\n\n${lines.join('\n\n')}\n\n用 /dl 平台 songmid 下载`)
    } catch (e) {
      await ctx.reply(`搜索失败: ${e.message}`)
    }
  })

  bot.command('dl', async (ctx) => {
    const parts = (ctx.match || '').trim().split(/\s+/).filter(Boolean)
    if (parts.length < 2) return ctx.reply('用法: /dl <平台> <songmid> [歌名] [歌手]')
    const [source, songmid, ...rest] = parts
    const name = rest[0] || songmid
    const singer = rest.slice(1).join(' ') || 'Unknown'
    try {
      const job = download.enqueueSongs(
        [{ source, songmid, name, singer }],
        { type: 'tg', quality: config.preferredQuality }
      )
      await ctx.reply(`已入队 #${job.id}: ${name} - ${singer}`)
    } catch (e) {
      await ctx.reply(`失败: ${e.message}`)
    }
  })

  bot.command('playlist', async (ctx) => {
    const input = (ctx.match || '').trim()
    if (!input) return ctx.reply('用法: /playlist <歌单URL或 平台:id>')
    try {
      const detected = music.detectPlaylistSource(input)
      const songs = []
      let info = null
      let page = 1
      while (page <= 20) {
        const data = await music.getSongListDetail({
          source: detected.source,
          id: detected.id,
          page,
        })
        info = info || data
        const list = data?.list || []
        songs.push(...list)
        if (!list.length || data?.isEnd) break
        page++
      }
      const job = download.enqueueSongs(songs, {
        type: 'playlist',
        quality: config.preferredQuality,
        payload: {
          ...detected,
          name: info?.name || info?.info?.name,
        },
      })
      await ctx.reply(`歌单「${job.title || '歌单'}」已入队 #${job.id}，共 ${songs.length} 首`)
    } catch (e) {
      await ctx.reply(`失败: ${e.message}`)
    }
  })

  bot.command('artist', async (ctx) => {
    const parts = (ctx.match || '').trim().split(/\s+/).filter(Boolean)
    if (parts.length < 2) return ctx.reply('用法: /artist <平台> <歌手id>')
    const [source, id] = parts
    try {
      const songs = []
      let page = 1
      while (page <= 30) {
        const data = await music.getArtistSongs({ source, id, page, limit: 100 })
        const list = data?.list || []
        songs.push(...list)
        if (!list.length) break
        if (data.total && songs.length >= data.total) break
        if (list.length < 100) break
        page++
      }
      const artistName = songs[0]?.singer || songs[0]?.artist
      const job = download.enqueueSongs(songs, {
        type: 'artist',
        quality: config.preferredQuality,
        payload: { source, id, name: artistName },
      })
      await ctx.reply(`歌手「${job.title || artistName || '未知'}」已入队 #${job.id}，共 ${songs.length} 首`)
    } catch (e) {
      await ctx.reply(`失败: ${e.message}`)
    }
  })

  bot.command('lyric', async (ctx) => {
    const parts = (ctx.match || '').trim().split(/\s+/).filter(Boolean)
    if (parts.length < 2) return ctx.reply('用法: /lyric <平台> <songmid>')
    const [source, songmid] = parts
    try {
      const data = await music.getLyric({ source, songmid })
      const text = data?.lyric || '(空)'
      await ctx.reply(text.slice(0, 3500))
    } catch (e) {
      await ctx.reply(`失败: ${e.message}`)
    }
  })

  bot.command('jobs', async (ctx) => {
    const list = download.listJobs().slice(0, 10)
    if (!list.length) return ctx.reply('暂无任务')
    const lines = list.map(
      (j) => `#${j.id} ${j.title || j.type} ${j.status} ${j.progress}/${j.total} ${j.message || ''}`
    )
    await ctx.reply(lines.join('\n'))
  })

  bot.catch((err) => {
    const ctx = err.ctx
    console.error(`[tg] error for ${ctx?.update?.update_id}:`, err.error)
    const e = err.error
    if (e instanceof GrammyError) console.error('[tg] grammy:', e.description)
    else if (e instanceof HttpError) console.error('[tg] http:', e)
  })

  bot.start({
    onStart: (info) => console.log(`[tg] bot @${info.username} started`),
  })
  return bot
}
