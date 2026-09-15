import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { libraryRepo } from '../db/index.js'
import { absoluteMusicPath, LYRIC_EMBEDDED, trackHasLyric } from './library.js'
import { hasEmbeddedLyric } from './tags.js'

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.wav', '.ogg', '.ape', '.aac'])

/** Remove DB rows whose audio file no longer exists; refresh lyric flags from tags. */
export function syncLibraryWithDisk() {
  const rows = libraryRepo.all()
  let removed = 0
  let lyricCleared = 0
  let lyricMarked = 0
  for (const row of rows) {
    const abs = absoluteMusicPath(row.file_path)
    if (!row.file_path || !fs.existsSync(abs)) {
      libraryRepo.remove(row.id)
      removed++
      continue
    }

    // Drop legacy sidecar path references; lyrics live in tags now.
    if (row.lyric_path && row.lyric_path !== LYRIC_EMBEDDED) {
      const lyricAbs = absoluteMusicPath(row.lyric_path)
      const sidecarOk = fs.existsSync(lyricAbs)
      if (!sidecarOk) {
        libraryRepo.upsert({
          ...pickRow(row),
          lyric_path: '',
          file_size: fs.statSync(abs).size,
        })
        lyricCleared++
        row.lyric_path = ''
      }
    }
  }
  return {
    total: rows.length,
    removed,
    lyricCleared,
    lyricMarked,
    remaining: libraryRepo.all().length,
  }
}

function pickRow(row) {
  return {
    platform: row.platform,
    songmid: row.songmid,
    name: row.name,
    singer: row.singer,
    album: row.album,
    quality: row.quality,
    file_path: row.file_path,
    lyric_path: row.lyric_path || '',
    file_size: row.file_size || 0,
  }
}

export function listLibraryFresh(opts = {}) {
  syncLibraryWithDisk()
  return libraryRepo.list(opts).map((t) => ({
    ...t,
    exists: fs.existsSync(absoluteMusicPath(t.file_path)),
    has_lyric: trackHasLyric(t),
  }))
}

/** Scan library for tracks without embedded lyrics (reads tags when needed). */
export async function findMissingLyrics({ limit = 500 } = {}) {
  const rows = libraryRepo.all()
  const missing = []
  for (const row of rows) {
    if (missing.length >= limit) break
    const abs = absoluteMusicPath(row.file_path)
    if (!row.file_path || !fs.existsSync(abs)) continue

    if (row.lyric_path === LYRIC_EMBEDDED) continue
    if (trackHasLyric(row)) {
      // migrate legacy sidecar flag → embedded if tags already have lyric
      if (await hasEmbeddedLyric(abs)) {
        libraryRepo.upsert({ ...pickRow(row), lyric_path: LYRIC_EMBEDDED })
      }
      continue
    }

    if (await hasEmbeddedLyric(abs)) {
      libraryRepo.upsert({ ...pickRow(row), lyric_path: LYRIC_EMBEDDED })
      continue
    }

    missing.push({
      ...row,
      exists: true,
      has_lyric: false,
    })
  }
  return missing
}

export function deleteLibraryEntry(id, { deleteFile = false } = {}) {
  const row = libraryRepo.getById(id) || libraryRepo.all().find((r) => String(r.id) === String(id))
  if (!row) return false
  if (deleteFile && row.file_path) {
    const abs = absoluteMusicPath(row.file_path)
    if (fs.existsSync(abs)) {
      try {
        fs.unlinkSync(abs)
      } catch {}
    }
    if (row.lyric_path && row.lyric_path !== LYRIC_EMBEDDED) {
      const lyricAbs = absoluteMusicPath(row.lyric_path)
      if (fs.existsSync(lyricAbs)) {
        try {
          fs.unlinkSync(lyricAbs)
        } catch {}
      }
    }
  }
  libraryRepo.removeRelated(row)
  return true
}

export function scanOrphanFiles() {
  const known = new Set(libraryRepo.all().map((r) => r.file_path))
  const orphans = []
  walk(config.musicDir, (abs) => {
    const ext = path.extname(abs).toLowerCase()
    if (!AUDIO_EXT.has(ext)) return
    const rel = path.relative(config.musicDir, abs)
    if (!known.has(rel)) orphans.push(rel)
  })
  return orphans
}

function walk(dir, onFile) {
  if (!fs.existsSync(dir)) return
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const abs = path.join(dir, name)
    let st
    try {
      st = fs.statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(abs, onFile)
    else onFile(abs)
  }
}
