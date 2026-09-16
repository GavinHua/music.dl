import express from 'express'
import multer from 'multer'
import { config } from '../config.js'
import * as music from '../services/music.js'
import * as sources from '../services/sources.js'
import * as download from '../services/download.js'
import { getMusicUrl } from '../services/sources.js'
import { listLibraryFresh, syncLibraryWithDisk, deleteLibraryEntry, scanOrphanFiles, findMissingLyrics } from '../services/librarySync.js'
import * as settings from '../services/settings.js'
import * as preview from '../services/preview.js'
import { libraryRepo } from '../db/index.js'

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })

export function createApiRouter() {
  const router = express.Router()

  router.get('/health', (_req, res) => {
    res.json({ ok: true, preferredQuality: config.preferredQuality })
  })

  router.get('/settings', (_req, res) => {
    res.json(settings.getSettings())
  })

  router.put('/settings', (req, res) => {
    try {
      res.json(settings.updateSettings(req.body || {}))
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.get('/platforms', (_req, res) => {
    res.json({ list: music.listPlatforms() })
  })

  router.get('/search', async (req, res) => {
    try {
      const keyword = String(req.query.keyword || req.query.name || '').trim()
      if (!keyword) return res.status(400).json({ error: 'keyword required' })
      const source = String(req.query.source || 'kw')
      const page = Number(req.query.page || 1)
      const limit = Number(req.query.limit || 20)
      if (source === 'all') {
        const list = await music.searchAll({ keyword, page, limit })
        return res.json({ list })
      }
      const data = await music.searchMusic({ keyword, source, page, limit })
      res.json(data)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.get('/song-list/tags', async (req, res) => {
    try {
      const source = String(req.query.source || 'kw')
      res.json(await music.getSongListTags(source))
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.get('/song-list/list', async (req, res) => {
    try {
      const source = String(req.query.source || 'kw')
      const sortId = req.query.sortId
      const tagId = req.query.tagId
      const page = Number(req.query.page || 1)
      res.json(await music.getSongListList({ source, sortId, tagId, page }))
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.get('/song-list/detail', async (req, res) => {
    try {
      let source = String(req.query.source || '')
      let id = String(req.query.id || req.query.url || '').trim()
      if (!id) return res.status(400).json({ error: 'id or url required' })
      if (!source) {
        const detected = music.detectPlaylistSource(id)
        source = detected.source
        id = detected.id
      }
      res.json(await music.getSongListDetail({ source, id, page: Number(req.query.page || 1) }))
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.get('/song-list/search', async (req, res) => {
    try {
      const keyword = String(req.query.keyword || '').trim()
      if (!keyword) return res.status(400).json({ error: 'keyword required' })
      const source = String(req.query.source || 'kw')
      res.json(
        await music.searchSongList({
          source,
          keyword,
          page: Number(req.query.page || 1),
          limit: Number(req.query.limit || 20),
        })
      )
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.get('/leaderboard/boards', async (req, res) => {
    try {
      const source = String(req.query.source || 'kw')
      res.json(await music.getLeaderboardBoards(source))
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.get('/leaderboard/list', async (req, res) => {
    try {
      const source = String(req.query.source || 'kw')
      const bangid = req.query.bangid || req.query.id
      const page = Number(req.query.page || 1)
      res.json(await music.getLeaderboardList({ source, bangid, page }))
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.get('/artist/search', async (req, res) => {
    try {
      const keyword = String(req.query.keyword || '').trim()
      if (!keyword) return res.status(400).json({ error: 'keyword required' })
      const source = String(req.query.source || 'wy')
      res.json(
        await music.searchArtist({
          keyword,
          source,
          page: Number(req.query.page || 1),
          limit: Number(req.query.limit || 20),
        })
      )
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.get('/artist/songs', async (req, res) => {
    try {
      const source = String(req.query.source || 'wy')
      const id = String(req.query.id || '')
      if (!id) return res.status(400).json({ error: 'id required' })
      res.json(
        await music.getArtistSongs({
          source,
          id,
          page: Number(req.query.page || 1),
          limit: Number(req.query.limit || 100),
        })
      )
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.get('/artist/detail', async (req, res) => {
    try {
      const source = String(req.query.source || 'wy')
      const id = String(req.query.id || '')
      res.json(await music.getArtistDetail({ source, id }))
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/lyric', async (req, res) => {
    try {
      const musicInfo = req.body?.musicInfo || req.body
      res.json(await music.getLyric(musicInfo))
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/music-url', async (req, res) => {
    try {
      const { source, musicInfo, quality } = req.body || {}
      const platform = source || musicInfo?.source
      const result = await getMusicUrl(platform, musicInfo, quality || config.preferredQuality)
      res.json(result)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/preview', async (req, res) => {
    try {
      const musicInfo = req.body?.musicInfo || req.body?.song || req.body
      if (!musicInfo?.name && !musicInfo?.songmid) return res.status(400).json({ error: 'musicInfo required' })
      const data = await preview.resolvePreview(musicInfo, req.body?.quality)
      res.json(data)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.get('/preview/stream/:token', (req, res) => {
    preview.pipePreviewStream(req.params.token, res)
  })

  // ---- download / jobs ----
  router.post('/download', async (req, res) => {
    try {
      const songs = Array.isArray(req.body?.songs)
        ? req.body.songs
        : req.body?.song
          ? [req.body.song]
          : []
      if (!songs.length) return res.status(400).json({ error: 'songs required' })
      const job = download.enqueueSongs(songs, {
        type: 'download',
        quality: req.body.quality || config.preferredQuality,
      })
      res.json(job)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/download/playlist', async (req, res) => {
    try {
      let { source, id, url, quality, maxPages = 20 } = req.body || {}
      const input = id || url
      if (!input) return res.status(400).json({ error: 'id or url required' })
      if (!source) {
        const detected = music.detectPlaylistSource(input)
        source = detected.source
        id = detected.id
      } else {
        id = input
      }
      const songs = []
      let page = 1
      let info = null
      while (page <= maxPages) {
        const data = await music.getSongListDetail({ source, id, page })
        info = info || data
        const list = data?.list || []
        songs.push(...list)
        if (!list.length || data?.isEnd || list.length < (data?.limit || 1)) break
        page++
      }
      const job = download.enqueueSongs(songs, {
        type: 'playlist',
        quality: quality || config.preferredQuality,
        payload: { source, id, name: info?.name || info?.info?.name },
      })
      res.json({ job, count: songs.length })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/download/artist', async (req, res) => {
    try {
      const { source = 'wy', id, quality, maxPages = 30 } = req.body || {}
      if (!id) return res.status(400).json({ error: 'id required' })
      const songs = []
      let page = 1
      while (page <= maxPages) {
        const data = await music.getArtistSongs({ source, id, page, limit: 100 })
        const list = data?.list || []
        songs.push(...list)
        if (!list.length) break
        const total = data?.total || 0
        if (total && songs.length >= total) break
        if (list.length < 100) break
        page++
      }
      const job = download.enqueueSongs(songs, {
        type: 'artist',
        quality: quality || config.preferredQuality,
        payload: { source, id },
      })
      res.json({ job, count: songs.length })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/download/leaderboard', async (req, res) => {
    try {
      const { source = 'kw', bangid, quality, page = 1 } = req.body || {}
      if (!bangid) return res.status(400).json({ error: 'bangid required' })
      const data = await music.getLeaderboardList({ source, bangid, page })
      const songs = data?.list || []
      const job = download.enqueueSongs(songs, {
        type: 'leaderboard',
        quality: quality || config.preferredQuality,
        payload: { source, bangid },
      })
      res.json({ job, count: songs.length })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.get('/jobs', (_req, res) => {
    res.json({ list: download.listJobs() })
  })

  router.get('/jobs/:id', (req, res) => {
    const job = download.getJob(Number(req.params.id))
    if (!job) return res.status(404).json({ error: 'not found' })
    res.json(job)
  })

  router.post('/jobs/:id/cancel', (req, res) => {
    res.json(download.cancelJob(Number(req.params.id)))
  })

  router.post('/jobs/:id/retry', (req, res) => {
    res.json(download.retryJob(Number(req.params.id)))
  })

  router.delete('/jobs/:id', (req, res) => {
    download.deleteJob(Number(req.params.id))
    res.json({ ok: true })
  })

  router.post('/jobs/clear-finished', (_req, res) => {
    res.json({ cleared: download.clearFinishedJobs() })
  })

  // ---- sources ----
  router.get('/sources', (_req, res) => {
    res.json({ list: sources.listSources() })
  })

  router.post('/sources/reload', async (_req, res) => {
    try {
      res.json(await sources.reloadSources())
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/sources/toggle', async (req, res) => {
    try {
      const { id, enabled } = req.body || {}
      sources.setSourceEnabled(id, !!enabled)
      await sources.reloadSources()
      res.json({ ok: true, list: sources.listSources() })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/sources/reorder', async (req, res) => {
    try {
      const ids = req.body?.ids || []
      sources.reorderSources(ids)
      await sources.reloadSources()
      res.json({ ok: true, list: sources.listSources() })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/sources/:id/test', async (req, res) => {
    try {
      const result = await sources.testSource(req.params.id, {
        platform: req.body?.platform,
        quality: req.body?.quality,
      })
      res.json(result)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/sources/import-url', async (req, res) => {
    try {
      const url = req.body?.url
      if (!url) return res.status(400).json({ error: 'url required' })
      const row = await sources.importSourceFromUrl(url)
      res.json(row)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/sources/upload', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'file required' })
      const content = req.file.buffer.toString('utf8')
      const row = await sources.importSourceUpload(req.file.originalname, content)
      res.json(row)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.delete('/sources/:id', async (req, res) => {
    try {
      sources.deleteSource(req.params.id)
      await sources.reloadSources()
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ---- library ----
  router.get('/library', (req, res) => {
    const limit = Number(req.query.limit || 100)
    const offset = Number(req.query.offset || 0)
    const q = String(req.query.q || '')
    const sync = req.query.sync !== '0'
    const list = sync ? listLibraryFresh({ limit, offset, q }) : libraryRepo.list({ limit, offset, q })
    res.json({ list })
  })

  router.post('/library/sync', (_req, res) => {
    const result = syncLibraryWithDisk()
    const orphans = scanOrphanFiles()
    res.json({ ...result, orphans: orphans.length, orphanFiles: orphans.slice(0, 50) })
  })

  router.get('/library/missing-lyrics', async (req, res) => {
    try {
      const limit = Number(req.query.limit || 500)
      const list = await findMissingLyrics({ limit })
      res.json({ list, count: list.length })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/library/fill-lyrics', async (req, res) => {
    try {
      let rows = req.body?.tracks || req.body?.list
      if (!Array.isArray(rows) || !rows.length) {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null
        const missing = await findMissingLyrics({ limit: Number(req.body?.limit || 500) })
        rows = ids ? missing.filter((r) => ids.includes(String(r.id))) : missing
      }
      if (!rows.length) return res.json({ job: null, count: 0, message: '没有需要补歌词的歌曲' })
      const job = download.enqueueLyricFill(rows)
      res.json({ job, count: rows.length })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.delete('/library/:id', (req, res) => {
    const deleteFile = req.query.file === '1' || req.body?.deleteFile
    const ok = deleteLibraryEntry(req.params.id, { deleteFile: !!deleteFile })
    if (!ok) return res.status(404).json({ error: 'not found' })
    res.json({ ok: true })
  })

  return router
}
