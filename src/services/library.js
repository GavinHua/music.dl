import fs from 'node:fs'
import path from 'node:path'
import { config, qualityRank } from '../config.js'
import { libraryRepo } from '../db/index.js'
import { hasEmbeddedLyric } from './tags.js'

/** Marker stored in lyric_path when lyrics are embedded in the audio file. */
export const LYRIC_EMBEDDED = 'embedded'

const UNSAFE = /[<>:"/\\|?*\x00-\x1f]/g

export function sanitizePathPart(name, fallback = 'Unknown') {
  const s = String(name || '')
    .replace(UNSAFE, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
  return s || fallback
}

/** Take the first artist when multiple are joined (/, 、, ,, &, …). */
export function primarySinger(singer) {
  const raw = String(singer || '').trim()
  if (!raw) return ''
  const first = raw.split(/[/／|｜、,，;&＋+]+/)[0].trim()
  return first || raw
}

export function buildRelativePath(musicInfo, quality, ext) {
  const fullSinger = musicInfo.singer || musicInfo.artist || ''
  const singerDir = sanitizePathPart(primarySinger(fullSinger), 'Unknown')
  const album = sanitizePathPart(musicInfo.albumName || musicInfo.album || 'Single', 'Single')
  const title = sanitizePathPart(musicInfo.name || musicInfo.songname, 'Unknown')
  const qTag = sanitizePathPart(quality || 'unknown', 'unknown')
  const singerLabel = sanitizePathPart(fullSinger || singerDir, 'Unknown')
  // Name - Singer - quality - album.ext  (folder uses primary singer only)
  const filename = `${title} - ${singerLabel} - ${qTag} - ${album}.${ext}`
  return path.join(singerDir, album, filename)
}

export function extFromUrlOrQuality(url, quality) {
  try {
    const u = new URL(url)
    const p = u.pathname.toLowerCase()
    if (p.endsWith('.flac')) return 'flac'
    if (p.endsWith('.wav')) return 'wav'
    if (p.endsWith('.m4a')) return 'm4a'
    if (p.endsWith('.ape')) return 'ape'
    if (p.endsWith('.ogg')) return 'ogg'
    if (p.endsWith('.mp3')) return 'mp3'
  } catch {}
  const q = String(quality || '').toLowerCase()
  if (q.includes('flac') || q.includes('hires') || q.includes('master') || q.includes('atmos') || q === '24bit') {
    return 'flac'
  }
  return 'mp3'
}

export function trackHasLyric(row) {
  if (!row) return false
  return row.lyric_path === LYRIC_EMBEDDED
}

export async function trackHasLyricAsync(row) {
  if (trackHasLyric(row)) return true
  if (!row?.file_path) return false
  const abs = absoluteMusicPath(row.file_path)
  if (!fs.existsSync(abs)) return false
  return hasEmbeddedLyric(abs)
}

export function decideDownload(musicInfo, targetQuality) {
  const platform = musicInfo.source || musicInfo.platform
  const songmid = String(musicInfo.songmid || musicInfo.hash || musicInfo.id || '')
  if (!platform || !songmid) {
    return { action: 'download', reason: 'no identity' }
  }

  const existing = libraryRepo.findByKey(platform, songmid)
  if (!existing) {
    // also check name+singer duplicates
    const byName = libraryRepo.findByNameSinger(musicInfo.name, musicInfo.singer)
    if (byName.length) {
      const best = byName.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))[0]
      if (qualityRank(best.quality) >= qualityRank(targetQuality)) {
        const needLyric = !trackHasLyric(best)
        return {
          action: needLyric ? 'lyric_only' : 'skip',
          existing: best,
          reason: needLyric ? 'same track, missing lyric' : 'already have equal/higher quality',
        }
      }
      return { action: 'upgrade', existing: best, reason: 'higher quality available' }
    }
    return { action: 'download', reason: 'new track' }
  }

  if (qualityRank(existing.quality) >= qualityRank(targetQuality)) {
    const needLyric = !trackHasLyric(existing)
    return {
      action: needLyric ? 'lyric_only' : 'skip',
      existing,
      reason: needLyric ? 'missing lyric' : 'already have equal/higher quality',
    }
  }
  return { action: 'upgrade', existing, reason: 'higher quality available' }
}

export function absoluteMusicPath(rel) {
  return path.join(config.musicDir, rel)
}

export function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

export function upsertLibraryRecord({ musicInfo, quality, fileRel, lyricRel, fileSize }) {
  libraryRepo.upsert({
    platform: musicInfo.source || musicInfo.platform,
    songmid: String(musicInfo.songmid || musicInfo.hash || musicInfo.id),
    name: musicInfo.name || '',
    singer: musicInfo.singer || '',
    album: musicInfo.albumName || musicInfo.album || '',
    quality: quality || '',
    file_path: fileRel,
    lyric_path: lyricRel || '',
    file_size: fileSize || 0,
  })
}
