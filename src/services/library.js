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

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.wav', '.ogg', '.ape', '.aac'])

function libraryFileExists(row) {
  if (!row?.file_path) return false
  return fs.existsSync(absoluteMusicPath(row.file_path))
}

function decideForExisting(existing, targetQuality) {
  if (!libraryFileExists(existing)) {
    return { action: 'download', existing, reason: '文件缺失，重新下载' }
  }
  if (qualityRank(existing.quality) >= qualityRank(targetQuality)) {
    const needLyric = !trackHasLyric(existing)
    return {
      action: needLyric ? 'lyric_only' : 'skip',
      existing,
      reason: needLyric ? '缺少歌词' : '已在曲库，音质相同或更高（删记录后可重下）',
    }
  }
  return { action: 'upgrade', existing, reason: '可升级音质' }
}

/** Parse quality tag from filename: `Title - Singer - QUALITY - Album.ext` */
function qualityFromFilename(filename, album) {
  const base = filename.replace(/\.[^.]+$/, '')
  const albumTail = ` - ${album}`
  if (album && base.endsWith(albumTail)) {
    const withoutAlbum = base.slice(0, -albumTail.length)
    const parts = withoutAlbum.split(' - ')
    return parts.length >= 3 ? parts[parts.length - 1] : ''
  }
  const parts = base.split(' - ')
  return parts.length >= 3 ? parts[2] : ''
}

/**
 * Find an on-disk audio file that matches the expected naming layout,
 * even when the library DB has no record (e.g. after DB reset).
 */
export function findDiskMatch(musicInfo, targetQuality) {
  const fullSinger = musicInfo.singer || musicInfo.artist || ''
  const singerDir = sanitizePathPart(primarySinger(fullSinger), 'Unknown')
  const album = sanitizePathPart(musicInfo.albumName || musicInfo.album || 'Single', 'Single')
  const title = sanitizePathPart(musicInfo.name || musicInfo.songname, 'Unknown')
  const singerLabel = sanitizePathPart(fullSinger || singerDir, 'Unknown')
  const dirRel = path.join(singerDir, album)
  const dirAbs = absoluteMusicPath(dirRel)
  if (!fs.existsSync(dirAbs)) return null

  const prefix = `${title} - ${singerLabel} - `
  let names
  try {
    names = fs.readdirSync(dirAbs)
  } catch {
    return null
  }

  const matches = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    const ext = path.extname(name).toLowerCase()
    if (!AUDIO_EXT.has(ext)) continue
    if (!name.startsWith(prefix)) continue
    const rel = path.join(dirRel, name)
    const abs = absoluteMusicPath(rel)
    let size = 0
    try {
      size = fs.statSync(abs).size
    } catch {
      continue
    }
    if (size <= 0) continue
    const quality = qualityFromFilename(name, album) || targetQuality || ''
    matches.push({ rel, quality, size })
  }
  if (!matches.length) return null

  matches.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality) || b.size - a.size)
  const best = matches[0]
  return {
    platform: musicInfo.source || musicInfo.platform || '',
    songmid: String(musicInfo.songmid || musicInfo.hash || musicInfo.id || ''),
    name: musicInfo.name || musicInfo.songname || '',
    singer: musicInfo.singer || musicInfo.artist || '',
    album: musicInfo.albumName || musicInfo.album || '',
    quality: best.quality,
    file_path: best.rel,
    lyric_path: '',
    file_size: best.size,
  }
}

export function decideDownload(musicInfo, targetQuality) {
  const platform = musicInfo.source || musicInfo.platform
  const songmid = String(musicInfo.songmid || musicInfo.hash || musicInfo.id || '')

  if (platform && songmid) {
    const existing = libraryRepo.findByKey(platform, songmid)
    if (existing) return decideForExisting(existing, targetQuality)

    const byName = libraryRepo.findByNameSinger(musicInfo.name, musicInfo.singer)
    if (byName.length) {
      const best = byName.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))[0]
      return decideForExisting(best, targetQuality)
    }
  } else {
    const byName = libraryRepo.findByNameSinger(musicInfo.name, musicInfo.singer)
    if (byName.length) {
      const best = byName.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))[0]
      return decideForExisting(best, targetQuality)
    }
  }

  // DB miss: still honor files left on disk (e.g. after DB wipe)
  const disk = findDiskMatch(musicInfo, targetQuality)
  if (disk) {
    if (qualityRank(disk.quality) >= qualityRank(targetQuality)) {
      return {
        action: 'adopt',
        existing: disk,
        reason: '磁盘已有文件，补回曲库记录',
      }
    }
    // lower quality on disk → download upgrade; keep disk path for optional cleanup
    return { action: 'download', existing: disk, reason: '磁盘音质较低，升级下载' }
  }

  return { action: 'download', reason: 'new track' }
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
