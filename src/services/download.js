import fs from 'node:fs'
import path from 'node:path'
import needle from 'needle'
import { config } from '../config.js'
import { jobsRepo, libraryRepo } from '../db/index.js'
import { getMusicUrlCandidates, getLyricFromSources } from './sources.js'
import { getLyric } from './music.js'
import { embedLyric } from './tags.js'
import { matchesFilterWords } from './settings.js'
import {
  decideDownload,
  buildRelativePath,
  extFromUrlOrQuality,
  absoluteMusicPath,
  ensureParentDir,
  upsertLibraryRecord,
  LYRIC_EMBEDDED,
} from './library.js'

let running = 0
let pumpScheduled = false

/** itemId -> { aborted, abort(), destroy() } */
const activeDownloads = new Map()

const SLOW_CHECK_MS = 12_000
const SLOW_MIN_BYTES = 200 * 1024 // ~17KB/s average
const PROBE_BYTES = 48 * 1024
const PROBE_TIMEOUT_MS = 8_000
const MAX_CANDIDATES = 4

function songLabel(song) {
  if (!song || typeof song !== 'object') return ''
  return song.name || song.songname || song.title || ''
}

function songSinger(song) {
  if (!song || typeof song !== 'object') return ''
  return song.singer || song.artist || ''
}

export function buildJobTitle(type, payload = {}, songs = []) {
  if (payload.title) return String(payload.title)
  if (payload.name) return String(payload.name)
  if (type === 'lyric_fill') {
    if (songs.length === 1) {
      const name = songLabel(songs[0])
      return name ? `补歌词 · ${name}` : '补歌词'
    }
    return songs.length ? `补歌词 · ${songs.length} 首` : '补歌词'
  }
  if (songs.length === 1) {
    const name = songLabel(songs[0])
    const singer = songSinger(songs[0])
    if (name && singer) return `${name} · ${singer}`
    return name || '单曲下载'
  }
  if (songs.length > 1) {
    const first = songLabel(songs[0]) || '批量'
    return `${first} 等 ${songs.length} 首`
  }
  const fallback = {
    playlist: '歌单下载',
    artist: '歌手下载',
    leaderboard: '榜单下载',
    download: '下载',
    tg: 'Telegram 下载',
    lyric_fill: '补歌词',
  }
  return fallback[type] || type || '任务'
}

function withJobTitle(job, items = null) {
  if (!job) return job
  const payload = job.payload || {}
  if (payload.title) return { ...job, title: String(payload.title) }
  const list = items ?? []
  return { ...job, title: buildJobTitle(job.type, payload, list) }
}

export function enqueueSongs(songs, { type = 'download', quality, payload = {}, title } = {}) {
  const q = quality || config.preferredQuality
  const incoming = Array.isArray(songs) ? songs : []
  const filteredOut = []
  const kept = []
  for (const song of incoming) {
    const musicInfo = normalizeIncomingSong(song)
    if (matchesFilterWords(musicInfo)) {
      filteredOut.push(musicInfo)
      continue
    }
    kept.push(musicInfo)
  }

  const allSongs = [...kept, ...filteredOut]
  const jobTitle = title || buildJobTitle(type, payload, allSongs.length ? allSongs : incoming)
  const jobId = jobsRepo.create({
    type,
    payload: {
      ...payload,
      title: jobTitle,
      quality: q,
      filtered: filteredOut.length,
      filterWords: [...(config.filterWords || [])],
    },
    total: kept.length + filteredOut.length,
  })

  for (const musicInfo of kept) {
    jobsRepo.addItem({
      job_id: jobId,
      platform: musicInfo.source,
      songmid: String(musicInfo.songmid || musicInfo.hash || musicInfo.id || ''),
      name: musicInfo.name || '',
      singer: musicInfo.singer || '',
      album: musicInfo.albumName || '',
      quality: q,
      music_info: musicInfo,
    })
  }
  for (const musicInfo of filteredOut) {
    jobsRepo.addItem({
      job_id: jobId,
      platform: musicInfo.source,
      songmid: String(musicInfo.songmid || musicInfo.hash || musicInfo.id || ''),
      name: musicInfo.name || '',
      singer: musicInfo.singer || '',
      album: musicInfo.albumName || '',
      quality: q,
      music_info: musicInfo,
      status: 'skipped',
      message: 'filtered by filter words',
    })
  }

  jobsRepo.update(jobId, {
    status: kept.length ? 'running' : 'completed',
    message: filteredOut.length ? `filtered ${filteredOut.length}, queue ${kept.length}` : '',
    progress: filteredOut.length,
  })
  schedulePump()
  return withJobTitle(jobsRepo.get(jobId))
}

function normalizeIncomingSong(song) {
  if (!song || typeof song !== 'object') return {}
  return {
    ...song,
    source: song.source || song.platform,
    name: song.name || song.songname || song.title || '',
    singer: song.singer || song.artist || '',
    albumName: song.albumName || song.album || '',
    songmid: song.songmid || song.songId || song.id || song.hash,
  }
}

function schedulePump() {
  if (pumpScheduled) return
  pumpScheduled = true
  setImmediate(() => {
    pumpScheduled = false
    pump()
  })
}

async function pump() {
  while (running < config.downloadConcurrency) {
    const [item] = jobsRepo.nextPendingItems(1)
    if (!item) break
    jobsRepo.updateItem(item.id, { status: 'running', message: 'downloading' })
    running++
    processItem(item)
      .catch((e) => {
        const msg = e?.message || String(e)
        if (msg === 'cancelled' || isItemCancelled(item.id)) {
          jobsRepo.updateItem(item.id, { status: 'cancelled', message: 'cancelled by user' })
        } else {
          jobsRepo.updateItem(item.id, { status: 'failed', message: msg })
        }
      })
      .finally(() => {
        activeDownloads.delete(item.id)
        running--
        refreshJob(item.job_id)
        schedulePump()
      })
  }
}

function createActiveHandle(itemId) {
  const handle = {
    aborted: false,
    req: null,
    out: null,
    abort() {
      this.aborted = true
      try {
        this.req?.destroy()
      } catch {}
      try {
        this.out?.destroy()
      } catch {}
    },
  }
  activeDownloads.set(itemId, handle)
  return handle
}

function isItemCancelled(itemId) {
  if (activeDownloads.get(itemId)?.aborted) return true
  const row = jobsRepo.getItem(itemId)
  return row?.status === 'cancelled'
}

function assertNotCancelled(itemId) {
  if (isItemCancelled(itemId)) {
    const err = new Error('cancelled')
    throw err
  }
}

async function processItem(item) {
  const handle = createActiveHandle(item.id)
  const musicInfo = item.music_info || {}
  const targetQuality = item.quality || config.preferredQuality
  const decision = decideDownload(musicInfo, targetQuality)

  assertNotCancelled(item.id)

  if (decision.action === 'skip') {
    jobsRepo.updateItem(item.id, {
      status: 'skipped',
      message: decision.reason,
      file_path: decision.existing?.file_path || '',
    })
    return
  }

  if (decision.action === 'adopt') {
    const row = decision.existing
    if (!row?.file_path) {
      jobsRepo.updateItem(item.id, { status: 'failed', message: 'adopt missing file' })
      return
    }
    const platform = musicInfo.source || musicInfo.platform || row.platform
    const songmid = String(musicInfo.songmid || musicInfo.hash || musicInfo.id || row.songmid || '')
    if (!platform || !songmid) {
      jobsRepo.updateItem(item.id, {
        status: 'skipped',
        message: `${decision.reason}（缺 platform/songmid，未写入曲库）`,
        file_path: row.file_path,
      })
      return
    }
    const lyricOk = await saveLyric(musicInfo, row.file_path)
    assertNotCancelled(item.id)
    upsertLibraryRecord({
      musicInfo: { ...musicInfo, source: platform, platform, songmid },
      quality: row.quality || targetQuality,
      fileRel: row.file_path,
      lyricRel: lyricOk ? LYRIC_EMBEDDED : '',
      fileSize: row.file_size || 0,
    })
    jobsRepo.updateItem(item.id, {
      status: 'done',
      message: lyricOk ? 'adopted + lyric' : 'adopted from disk',
      file_path: row.file_path,
      quality: row.quality || targetQuality,
    })
    return
  }

  if (decision.action === 'lyric_only') {
    const ok = await saveLyric(musicInfo, decision.existing.file_path)
    assertNotCancelled(item.id)
    if (ok) {
      libraryRepo.upsert({
        platform: decision.existing.platform,
        songmid: decision.existing.songmid,
        name: decision.existing.name,
        singer: decision.existing.singer,
        album: decision.existing.album,
        quality: decision.existing.quality,
        file_path: decision.existing.file_path,
        lyric_path: LYRIC_EMBEDDED,
        file_size: decision.existing.file_size || 0,
      })
      jobsRepo.updateItem(item.id, {
        status: 'done',
        message: 'lyric embedded',
        file_path: decision.existing.file_path,
      })
    } else {
      jobsRepo.updateItem(item.id, {
        status: 'skipped',
        message: 'lyric not found',
        file_path: decision.existing.file_path,
      })
    }
    return
  }

  const platform = musicInfo.source
  if (!platform) throw new Error('缺少平台 source')

  jobsRepo.updateItem(item.id, { message: 'resolving sources…' })
  let candidates = []
  try {
    candidates = await getMusicUrlCandidates(platform, musicInfo, targetQuality, {
      maxCandidates: MAX_CANDIDATES,
    })
  } catch (e) {
    throw e
  }
  assertNotCancelled(item.id)

  jobsRepo.updateItem(item.id, { message: `probing ${candidates.length} sources…` })
  const ranked = await rankCandidatesByProbe(candidates, handle)
  assertNotCancelled(item.id)

  let lastErr = null
  let resolved = null
  let abs = null
  let rel = null
  const tried = []

  for (const cand of ranked) {
    assertNotCancelled(item.id)
    if (tried.includes(cand.sourceId)) continue
    tried.push(cand.sourceId)
    try {
      const ext = extFromUrlOrQuality(cand.url, cand.quality)
      rel = buildRelativePath(musicInfo, cand.quality, ext)
      abs = absoluteMusicPath(rel)
      ensureParentDir(abs)

      if (
        (decision.action === 'upgrade' || decision.existing?.file_path) &&
        decision.existing?.file_path
      ) {
        const oldAbs = absoluteMusicPath(decision.existing.file_path)
        if (oldAbs !== abs && fs.existsSync(oldAbs)) {
          try {
            fs.unlinkSync(oldAbs)
          } catch {}
        }
      }

      const tmp = `${abs}.part`
      jobsRepo.updateItem(item.id, {
        message: `downloading via ${cand.sourceName} @ ${cand.quality}${cand.bytesPerSec ? ` (~${formatSpeed(cand.bytesPerSec)})` : ''}`,
      })
      await downloadFile(cand.url, tmp, {
        handle,
        itemId: item.id,
        timeoutMs: config.downloadTimeoutMs,
        enableSlowSwitch: ranked.length > 1 && tried.length < ranked.length,
      })
      fs.renameSync(tmp, abs)
      resolved = cand
      lastErr = null
      break
    } catch (e) {
      lastErr = e
      if (e?.message === 'cancelled') throw e
      if (abs) {
        try {
          fs.unlinkSync(`${abs}.part`)
        } catch {}
      }
      console.warn(`[download] switch source after: ${e.message}`)
      jobsRepo.updateItem(item.id, {
        message: `${cand.sourceName} failed (${e.message}), trying next…`,
      })
    }
  }

  if (lastErr || !resolved || !abs) throw lastErr || new Error('download failed')
  assertNotCancelled(item.id)

  const stat = fs.statSync(abs)
  const lyricOk = await saveLyric(musicInfo, rel)
  upsertLibraryRecord({
    musicInfo,
    quality: resolved.quality,
    fileRel: rel,
    lyricRel: lyricOk ? LYRIC_EMBEDDED : '',
    fileSize: stat.size,
  })

  jobsRepo.updateItem(item.id, {
    status: 'done',
    message: `ok via ${resolved.sourceName} @ ${resolved.quality}`,
    file_path: rel,
    quality: resolved.quality,
  })
}

function formatSpeed(bps) {
  if (!bps || bps < 1024) return `${Math.round(bps || 0)} B/s`
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`
  return `${(bps / 1024 / 1024).toFixed(1)} MB/s`
}

async function rankCandidatesByProbe(candidates, handle) {
  if (candidates.length <= 1) return candidates
  const probed = await Promise.all(
    candidates.map(async (c) => {
      if (handle.aborted) return { ...c, bytesPerSec: 0, probeOk: false }
      try {
        const speed = await probeUrlSpeed(c.url, handle)
        return { ...c, bytesPerSec: speed, probeOk: speed > 0 }
      } catch {
        return { ...c, bytesPerSec: 0, probeOk: false }
      }
    })
  )
  probed.sort((a, b) => (b.bytesPerSec || 0) - (a.bytesPerSec || 0))
  const ok = probed.filter((p) => p.probeOk)
  return ok.length ? ok : candidates
}

function probeUrlSpeed(url, handle) {
  return new Promise((resolve, reject) => {
    let bytes = 0
    const started = Date.now()
    let settled = false
    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        req.destroy()
      } catch {}
      fn(arg)
    }
    const timer = setTimeout(() => {
      if (bytes > 0) finish(resolve, (bytes / Math.max(Date.now() - started, 1)) * 1000)
      else finish(reject, new Error('probe timeout'))
    }, PROBE_TIMEOUT_MS)

    const req = needle.get(url, {
      follow_max: 5,
      open_timeout: 8_000,
      response_timeout: PROBE_TIMEOUT_MS,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Range: `bytes=0-${PROBE_BYTES - 1}`,
      },
    })
    handle.req = req
    req.on('header', (statusCode) => {
      if (statusCode >= 400) finish(reject, new Error(`HTTP ${statusCode}`))
    })
    req.on('data', (chunk) => {
      if (handle.aborted) return finish(reject, new Error('cancelled'))
      bytes += chunk.length
      if (bytes >= PROBE_BYTES) {
        const elapsed = Math.max(Date.now() - started, 1)
        finish(resolve, (bytes / elapsed) * 1000)
      }
    })
    req.on('end', () => {
      if (bytes > 0) {
        const elapsed = Math.max(Date.now() - started, 1)
        finish(resolve, (bytes / elapsed) * 1000)
      } else finish(reject, new Error('empty probe'))
    })
    req.on('error', (e) => finish(reject, e))
  })
}

async function saveLyric(musicInfo, audioRel) {
  let lyricText = ''
  try {
    const data = await getLyric(musicInfo)
    lyricText = data?.lyric || data?.lrc || ''
  } catch {}
  if (!lyricText) {
    try {
      const data = await getLyricFromSources(musicInfo.source, musicInfo)
      lyricText = data?.lyric || ''
    } catch {}
  }
  if (!lyricText) return false

  try {
    const ok = await embedLyric(absoluteMusicPath(audioRel), lyricText, musicInfo)
    return !!ok
  } catch (e) {
    console.warn('[lyric] embed failed:', e.message)
    return false
  }
}

/** Queue lyric-only fill for library rows. */
export function enqueueLyricFill(rows, { title } = {}) {
  const songs = (rows || []).map((row) => ({
    source: row.platform || row.source,
    platform: row.platform || row.source,
    songmid: row.songmid,
    id: row.songmid,
    name: row.name,
    singer: row.singer,
    albumName: row.album,
    album: row.album,
  }))
  return enqueueSongs(songs, { type: 'lyric_fill', title })
}

function downloadFile(url, dest, { timeoutMs = config.downloadTimeoutMs, handle, itemId, enableSlowSwitch = false } = {}) {
  const ms = Number(timeoutMs) || 5 * 60 * 1000
  return new Promise((resolve, reject) => {
    let settled = false
    let bytes = 0
    const started = Date.now()
    let slowTimer = null

    const fail = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (slowTimer) clearTimeout(slowTimer)
      try {
        req.destroy()
      } catch {}
      try {
        out.destroy()
      } catch {}
      try {
        fs.unlinkSync(dest)
      } catch {}
      reject(err instanceof Error ? err : new Error(String(err)))
    }
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (slowTimer) clearTimeout(slowTimer)
      resolve()
    }

    if (handle?.aborted || (itemId && isItemCancelled(itemId))) {
      return fail(new Error('cancelled'))
    }

    const timer = setTimeout(() => fail(new Error(`下载超时（${Math.round(ms / 1000)}s）`)), ms)
    if (enableSlowSwitch) {
      slowTimer = setTimeout(() => {
        if (settled) return
        if (bytes < SLOW_MIN_BYTES) {
          fail(new Error(`下载过慢（${SLOW_CHECK_MS / 1000}s 仅 ${Math.round(bytes / 1024)}KB），切换音源`))
        }
      }, SLOW_CHECK_MS)
    }

    const out = fs.createWriteStream(dest)
    const req = needle.get(url, {
      follow_max: 5,
      open_timeout: 30_000,
      response_timeout: ms,
      read_timeout: ms,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    })
    if (handle) {
      handle.req = req
      handle.out = out
    }

    req.on('header', (statusCode) => {
      if (statusCode >= 400) {
        fail(new Error(`下载失败 HTTP ${statusCode}`))
      }
    })
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (handle?.aborted || (itemId && isItemCancelled(itemId))) {
        fail(new Error('cancelled'))
      }
    })
    req.pipe(out)
    out.on('finish', done)
    out.on('error', fail)
    req.on('error', fail)
  })
}

function refreshJob(jobId) {
  const items = jobsRepo.listItems(jobId)
  const done = items.filter((i) => ['done', 'skipped', 'failed', 'cancelled'].includes(i.status)).length
  const failed = items.filter((i) => i.status === 'failed').length
  const pending = items.filter((i) => ['pending', 'running'].includes(i.status)).length
  const cancelled = items.filter((i) => i.status === 'cancelled').length
  let status = 'completed'
  if (pending) status = 'running'
  else if (cancelled && cancelled === items.length) status = 'cancelled'
  else if (failed && failed === items.length) status = 'failed'
  jobsRepo.update(jobId, {
    progress: done,
    total: items.length,
    status,
    message: `${done}/${items.length} finished, ${failed} failed`,
  })
}

export function getJob(id) {
  const job = jobsRepo.get(id)
  if (!job) return null
  const items = jobsRepo.listItems(id)
  return { ...withJobTitle(job, items), items }
}

export function listJobs() {
  return jobsRepo.list().map((job) => withJobTitle(job, []))
}

export function cancelJob(id) {
  const items = jobsRepo.listItems(id)
  for (const it of items) {
    if (['pending', 'running'].includes(it.status)) {
      activeDownloads.get(it.id)?.abort()
    }
  }
  jobsRepo.cancelPendingItems(id)
  refreshJob(id)
  const job = jobsRepo.get(id)
  if (job && ['running', 'pending'].includes(job.status)) {
    jobsRepo.update(id, { status: 'cancelled', message: 'cancelled by user' })
  }
  return getJob(id)
}

export function cancelJobItem(itemId) {
  const item = jobsRepo.getItem(itemId)
  if (!item) return null
  if (!['pending', 'running'].includes(item.status)) {
    return getJob(item.job_id)
  }
  activeDownloads.get(item.id)?.abort()
  jobsRepo.updateItem(item.id, { status: 'cancelled', message: 'cancelled by user' })
  refreshJob(item.job_id)
  schedulePump()
  return getJob(item.job_id)
}

export function retryJob(id) {
  jobsRepo.retryFailedItems(id)
  jobsRepo.update(id, { status: 'running', message: 'retrying' })
  refreshJob(id)
  schedulePump()
  return getJob(id)
}

export function deleteJob(id) {
  const items = jobsRepo.listItems(id)
  for (const it of items) activeDownloads.get(it.id)?.abort()
  jobsRepo.delete(id)
  return true
}

export function clearFinishedJobs() {
  return jobsRepo.clearFinished()
}

// kick pump periodically in case of stalls
setInterval(() => schedulePump(), 3000).unref?.()
