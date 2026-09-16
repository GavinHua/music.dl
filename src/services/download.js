import fs from 'node:fs'
import path from 'node:path'
import needle from 'needle'
import { config } from '../config.js'
import { jobsRepo, libraryRepo } from '../db/index.js'
import { getMusicUrl, getLyricFromSources } from './sources.js'
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

export function enqueueSongs(songs, { type = 'download', quality, payload = {} } = {}) {
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

  const jobId = jobsRepo.create({
    type,
    payload: {
      ...payload,
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

  // addItem defaults status to pending then spreads item — ensure skipped stuck
  // (status is in INSERT columns via @status)
  jobsRepo.update(jobId, {
    status: kept.length ? 'running' : 'completed',
    message: filteredOut.length ? `filtered ${filteredOut.length}, queue ${kept.length}` : '',
    progress: filteredOut.length,
  })
  schedulePump()
  return jobsRepo.get(jobId)
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
        jobsRepo.updateItem(item.id, { status: 'failed', message: e.message || String(e) })
      })
      .finally(() => {
        running--
        refreshJob(item.job_id)
        schedulePump()
      })
  }
}

async function processItem(item) {
  const musicInfo = item.music_info || {}
  const targetQuality = item.quality || config.preferredQuality
  const decision = decideDownload(musicInfo, targetQuality)

  if (decision.action === 'skip') {
    jobsRepo.updateItem(item.id, {
      status: 'skipped',
      message: decision.reason,
      file_path: decision.existing?.file_path || '',
    })
    return
  }

  if (decision.action === 'lyric_only') {
    const ok = await saveLyric(musicInfo, decision.existing.file_path)
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

  const tried = []
  let lastErr = null
  let resolved = null
  let abs = null
  let rel = null

  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      resolved = await getMusicUrl(platform, musicInfo, targetQuality, {
        excludeSourceIds: tried,
      })
      if (tried.includes(resolved.sourceId)) {
        lastErr = new Error('no more sources')
        break
      }
      tried.push(resolved.sourceId)
      const ext = extFromUrlOrQuality(resolved.url, resolved.quality)
      rel = buildRelativePath(musicInfo, resolved.quality, ext)
      abs = absoluteMusicPath(rel)
      ensureParentDir(abs)

      if (decision.action === 'upgrade' && decision.existing?.file_path) {
        const oldAbs = absoluteMusicPath(decision.existing.file_path)
        if (oldAbs !== abs && fs.existsSync(oldAbs)) {
          try {
            fs.unlinkSync(oldAbs)
          } catch {}
        }
      }

      const tmp = `${abs}.part`
      await downloadFile(resolved.url, tmp)
      fs.renameSync(tmp, abs)
      lastErr = null
      break
    } catch (e) {
      lastErr = e
      if (abs) {
        try {
          fs.unlinkSync(`${abs}.part`)
        } catch {}
      }
      console.warn(`[download] retry after: ${e.message}`)
    }
  }
  if (lastErr || !resolved || !abs) throw lastErr || new Error('download failed')

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
export function enqueueLyricFill(rows) {
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
  return enqueueSongs(songs, { type: 'lyric_fill' })
}

function downloadFile(url, dest, timeoutMs = config.downloadTimeoutMs) {
  const ms = Number(timeoutMs) || 5 * 60 * 1000
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
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
      resolve()
    }

    const timer = setTimeout(() => fail(new Error(`下载超时（${Math.round(ms / 1000)}s）`)), ms)
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
    req.on('header', (statusCode) => {
      if (statusCode >= 400) {
        fail(new Error(`下载失败 HTTP ${statusCode}`))
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
  return { ...job, items: jobsRepo.listItems(id) }
}

export function listJobs() {
  return jobsRepo.list()
}

export function cancelJob(id) {
  jobsRepo.cancelPendingItems(id)
  refreshJob(id)
  const job = jobsRepo.get(id)
  if (job && ['running', 'pending'].includes(job.status)) {
    jobsRepo.update(id, { status: 'cancelled', message: 'cancelled by user' })
  }
  return getJob(id)
}

export function retryJob(id) {
  jobsRepo.retryFailedItems(id)
  jobsRepo.update(id, { status: 'running', message: 'retrying' })
  refreshJob(id)
  schedulePump()
  return getJob(id)
}

export function deleteJob(id) {
  jobsRepo.delete(id)
  return true
}

export function clearFinishedJobs() {
  return jobsRepo.clearFinished()
}

// kick pump periodically in case of stalls
setInterval(() => schedulePump(), 3000).unref?.()
