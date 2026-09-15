import fs from 'node:fs'
import path from 'node:path'
import NodeID3 from 'node-id3'
import { writeFlacTags, readFlacTags } from 'flac-tagger'

/**
 * Embed lyric text into audio tags (no sidecar .lrc).
 * FLAC: VORBIS COMMENT LYRICS
 * MP3: USLT
 */
export async function embedLyric(audioAbs, lyricText, musicInfo = {}) {
  if (!lyricText || !audioAbs || !fs.existsSync(audioAbs)) return false
  const ext = path.extname(audioAbs).toLowerCase()
  try {
    if (ext === '.mp3') {
      const tags = {
        title: musicInfo.name || undefined,
        artist: musicInfo.singer || undefined,
        album: musicInfo.albumName || musicInfo.album || undefined,
        unsynchronisedLyrics: {
          language: 'chi',
          text: lyricText,
        },
      }
      const ok = NodeID3.update(tags, audioAbs)
      return !!ok
    }
    if (ext === '.flac') {
      await writeFlacTags(
        {
          tagMap: {
            TITLE: musicInfo.name || '',
            ARTIST: musicInfo.singer || '',
            ALBUM: musicInfo.albumName || musicInfo.album || '',
            LYRICS: lyricText,
            UNSYNCEDLYRICS: lyricText,
          },
        },
        audioAbs
      )
      return true
    }
  } catch (e) {
    console.warn('[tags] embed lyric failed:', e.message)
  }
  return false
}

/** Read embedded lyric text from mp3/flac; empty string if none. */
export async function readEmbeddedLyric(audioAbs) {
  if (!audioAbs || !fs.existsSync(audioAbs)) return ''
  const ext = path.extname(audioAbs).toLowerCase()
  try {
    if (ext === '.mp3') {
      const tags = NodeID3.read(audioAbs)
      const uslt = tags?.unsynchronisedLyrics
      if (typeof uslt === 'string') return uslt.trim()
      if (uslt?.text) return String(uslt.text).trim()
      return ''
    }
    if (ext === '.flac') {
      const tags = await readFlacTags(audioAbs)
      const map = tags?.tagMap || {}
      const text = map.LYRICS || map.UNSYNCEDLYRICS || map.lyrics || map.unsyncedlyrics || ''
      return String(Array.isArray(text) ? text[0] : text).trim()
    }
  } catch (e) {
    console.warn('[tags] read lyric failed:', e.message)
  }
  return ''
}

export async function hasEmbeddedLyric(audioAbs) {
  const text = await readEmbeddedLyric(audioAbs)
  return text.length > 0
}
