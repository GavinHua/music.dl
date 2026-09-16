import fs from 'node:fs'
import path from 'node:path'
import needle from 'needle'
import { config } from '../config.js'
import { jobsRepo, libraryRepo } from '../db/index.js'
import { getMusicUrl, getLyricFromSources } from './sources.js'
import { getLyric } from './music.js'
import { embedLyric } from './tags.js'
import { matchesFilterWords } from './settings.js'
import { notifyTelegram } from '../tg/notify.js'
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
const notifiedJobs = new Set()
const inflight = new Map()

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
    const ac = new AbortController()
    inflight.set(item.id, { ac, jobId: item.job_id })
    processItem(item, ac.signal)
      .catch((e) => {
        const cancelled =
          e?.cancelled ||
          ac.signal.aborted ||
          /已取消|aborted/i.test(String(e?.message || e))
        jobsRepo.updateItem(item.id, {
          status: cancelled ? 'cancelled' : 'failed',
          message: cancelled ? '已取消' : e.message || String(e),
        })
      })
      .finally(() => {
        inflight.delete(item.id)
        running--
        refreshJob(item.job_id)
        notifyDownloadProgress(item.job_id, item.id)
        schedulePump()
      })
  }
}

async function processItem(item, signal) {
  throwIfAborted(signal)
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
    const ok = await Promise.race([
      saveLyric(musicInfo, decision.existing.file_path),
      whenAborted(signal),
    ])
    throwIfAborted(signal)
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
    throwIfAborted(signal)
    try {
      resolved = await Promise.race([
        getMusicUrl(platform, musicInfo, targetQuality, {
          excludeSourceIds: tried,
        }),
        whenAborted(signal),
      ])
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
      await downloadFile(resolved.url, tmp, config.downloadTimeoutMs, signal)
      throwIfAborted(signal)
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
      if (e?.cancelled) throw e
    }
  }
  if (lastErr || !resolved || !abs) throw lastErr || new Error('download failed')
  throwIfAborted(signal)

  const stat = fs.statSync(abs)

  const lyricOk = await Promise.race([saveLyric(musicInfo, rel), whenAborted(signal)])
  throwIfAborted(signal)
  upsertLibraryRecord({
    musicInfo,
    quality: resolved.quality,
    fileRel: rel,
    lyricRel: lyricOk ? LYRIC_EMBEDDED : '',
    fileSize: stat.size,
  })

  jobsRepo.updateItem(item.id, {
    status: 'done',
    message: `ok via ${resolved.sourceName} @ ${resolved.quality}${lyricOk ? ' lyric' : ''}`,
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

function abortError() {
  const e = new Error('已取消')
  e.cancelled = true
  return e
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError()
}

function whenAborted(signal) {
  return new Promise((_, reject) => {
    if (!signal) return
    if (signal.aborted) {
      reject(abortError())
      return
    }
    signal.addEventListener('abort', () => reject(abortError()), { once: true })
  })
}

function downloadFile(url, dest, timeoutMs = config.downloadTimeoutMs, signal) {
  const ms = Number(timeoutMs) || 5 * 60 * 1000
  return new Promise((resolve, reject) => {
    let settled = false
    let req
    let out
    let timer
    const fail = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        signal?.removeEventListener?.('abort', onAbort)
      } catch {}
      try {
        req?.destroy()
      } catch {}
      try {
        out?.destroy()
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
      try {
        signal?.removeEventListener?.('abort', onAbort)
      } catch {}
      resolve()
    }
    const onAbort = () => fail(abortError())

    if (signal?.aborted) {
      fail(abortError())
      return
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })

    timer = setTimeout(() => fail(new Error(`下载超时（${Math.round(ms / 1000)}s）`)), ms)
    out = fs.createWriteStream(dest)
    req = needle.get(url, {
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

function songTitle(item) {
  return `${item.name || ''} — ${item.singer || ''}`.trim() || item.songmid || `#${item.id}`
}

function humanSkipReason(msg) {
  const s = String(msg || '')
  if (/lyric not found/i.test(s)) return '没找到歌词'
  if (/filter/i.test(s)) return '命中过滤词，已跳过'
  if (/已在曲库|equal|higher/i.test(s)) return '曲库里已有同等或更高音质，跳过'
  if (/缺少歌词/.test(s)) return '文件已在曲库，这次只补歌词'
  return s || '已跳过'
}

function itemStatusLine(item) {
  const title = songTitle(item).replace(' — ', ' - ')
  if (item.status === 'done') {
    const m = String(item.message || '').match(/^ok via (.+?) @ (\S+)(.*)$/i)
    if (m) {
      const via = `via ${m[1]} @ ${m[2]}`
      const lines = [`✅ ${title}`, '下载完成', item.file_path ? `${via} ${item.file_path}` : via]
      if (/lyric/i.test(m[3] || '')) lines.push('歌词已写入')
      return lines.join('\n')
    }
    if (/lyric embedded/i.test(item.message || '')) return `✅ ${title}\n歌词已写入`
    return `✅ ${title}\n下载完成`
  }
  if (item.status === 'skipped') return `⏭ ${title}\n${humanSkipReason(item.message)}`
  if (item.status === 'failed') return `❌ ${title}\n下载失败：${item.message || '未知错误'}`
  if (item.status === 'cancelled') return `⏹ ${title}\n已取消`
  return `⏳ ${title}\n正在下载`
}

function listTitles(items, limit = 25) {
  const lines = items.slice(0, limit).map((i) => `· ${songTitle(i)}`)
  if (items.length > limit) lines.push(`· …还有 ${items.length - limit} 首`)
  return lines
}

function formatLyricFillNotice(job, items) {
  const done = items.filter((i) => i.status === 'done')
  const failed = items.filter((i) => i.status === 'failed')
  const skipped = items.filter((i) => i.status === 'skipped')
  const notFound = skipped.filter((i) => /lyric not found/i.test(i.message || ''))
  const otherSkip = skipped.filter((i) => !/lyric not found/i.test(i.message || ''))
  const lines = [`补歌词任务 #${job.id} 任务完成。`]
  if (done.length) {
    lines.push(`成功写入 ${done.length} 首：`, ...listTitles(done))
  }
  if (notFound.length) {
    lines.push(
      done.length || failed.length || otherSkip.length
        ? `${notFound.length} 首没找到歌词：`
        : `${notFound.length} 首都没找到歌词：`,
      ...listTitles(notFound)
    )
  }
  if (otherSkip.length) {
    lines.push(
      `${otherSkip.length} 首跳过：`,
      ...otherSkip.slice(0, 15).map((i) => `· ${songTitle(i)}（${i.message || '跳过'}）`)
    )
  }
  if (failed.length) {
    lines.push(
      `${failed.length} 首失败：`,
      ...failed.slice(0, 15).map((i) => `· ${songTitle(i)}（${i.message || '失败'}）`)
    )
  }
  if (items.length && !done.length && !skipped.length && !failed.length) {
    lines.push('没有需要处理的歌曲。')
  }
  const text = lines.join('\n')
  return text.length > 3500 ? `${text.slice(0, 3490)}\n…` : text
}

function parseVia(message) {
  const m = String(message || '').match(/^ok via (.+?) @ (\S+)(.*)$/i)
  if (!m) return null
  return { source: m[1], quality: m[2], lyric: /lyric/i.test(m[3] || '') }
}

function formatDownloadNotice(job, items) {
  const done = items.filter((i) => i.status === 'done')
  const skipped = items.filter((i) => i.status === 'skipped')
  const failed = items.filter((i) => i.status === 'failed')
  const cancelled = items.filter((i) => i.status === 'cancelled')
  const kind = job.type === 'playlist' ? '歌单下载' : '下载'
  let head
  if (cancelled.length && cancelled.length === items.length) head = `${kind}已取消 · #${job.id}`
  else if (failed.length && !done.length) head = `${kind}失败 · #${job.id}`
  else if (failed.length) head = `${kind}完成 · #${job.id}（有失败）`
  else if (cancelled.length) head = `${kind}完成 · #${job.id}（有取消）`
  else if (skipped.length && !done.length) head = `${kind} · #${job.id}`
  else head = `${kind}完成 · #${job.id}`

  const bits = []
  if (done.length) bits.push(`成功 ${done.length} 首`)
  if (skipped.length) bits.push(`跳过 ${skipped.length} 首`)
  if (failed.length) bits.push(`失败 ${failed.length} 首`)
  if (cancelled.length) bits.push(`取消 ${cancelled.length} 首`)
  const lines = [head]
  if (bits.length) lines.push(bits.join('，'))
  lines.push('')

  const shown = items.slice(0, 25)
  for (const it of shown) {
    const title = songTitle(it)
    if (it.status === 'done') {
      const via = parseVia(it.message)
      lines.push(`✅ ${title}`)
      if (via) {
        const extra = via.lyric ? ' · 已写入歌词' : ''
        lines.push(`   ${String(via.quality).toUpperCase()} · ${via.source}${extra}`)
      }
    } else if (it.status === 'skipped') {
      lines.push(`⏭ ${title}`)
      lines.push(`   ${humanSkipReason(it.message)}`)
    } else if (it.status === 'failed') {
      lines.push(`❌ ${title}`)
      lines.push(`   ${it.message || '失败'}`)
    } else if (it.status === 'cancelled') {
      lines.push(`⏹ ${title}`)
    }
  }
  if (items.length > shown.length) lines.push(`· …还有 ${items.length - shown.length} 首`)
  const text = lines.join('\n').trim()
  return text.length > 3500 ? `${text.slice(0, 3490)}\n…` : text
}

function notifyDownloadProgress(jobId, itemId) {
  const job = jobsRepo.get(jobId)
  const items = jobsRepo.listItems(jobId)
  const item = items.find((i) => i.id === itemId)
  if (!job || !item) return

  const total = job.total || items.length
  const isLyricFill = job.type === 'lyric_fill'
  const terminal = ['done', 'skipped', 'failed', 'cancelled'].includes(item.status)
  if (!isLyricFill && terminal && total === 1) {
    notifyTelegram(itemStatusLine(item))
  }

  if (['pending', 'running'].includes(job.status)) return
  if (notifiedJobs.has(jobId)) return
  notifiedJobs.add(jobId)

  if (isLyricFill) {
    notifyTelegram(formatLyricFillNotice(job, items))
    return
  }

  if (total <= 1) return
  notifyTelegram(formatDownloadNotice(job, items))
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
  const jobId = Number(id)
  jobsRepo.cancelPendingItems(jobId)
  for (const row of inflight.values()) {
    if (row.jobId === jobId) row.ac.abort()
  }
  refreshJob(jobId)
  const job = jobsRepo.get(jobId)
  if (job && ['running', 'pending'].includes(job.status)) {
    jobsRepo.update(jobId, { status: 'cancelled', message: 'cancelled by user' })
  }
  return getJob(jobId)
}

export function retryJob(id) {
  notifiedJobs.delete(Number(id))
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
