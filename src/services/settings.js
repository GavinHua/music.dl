import fs from 'node:fs'
import path from 'node:path'
import { config, QUALITY_RANK } from '../config.js'

const settingsPath = () => path.join(config.dataDir, 'settings.json')

const DEFAULTS = {
  preferredQuality: config.preferredQuality || 'flac',
  filterWords: config.filterWords || [],
  downloadTimeoutMs: config.downloadTimeoutMs || 5 * 60 * 1000,
}

export const QUALITY_OPTIONS = [
  { id: '128k', label: '128k' },
  { id: '192k', label: '192k' },
  { id: '320k', label: '320k' },
  { id: 'flac', label: 'FLAC' },
  { id: 'flac24bit', label: 'FLAC 24bit' },
  { id: 'hires', label: 'Hi-Res' },
  { id: 'master', label: 'Master' },
  { id: 'atmos', label: 'Atmos' },
]

function readFile() {
  try {
    if (!fs.existsSync(settingsPath())) return {}
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) || {}
  } catch {
    return {}
  }
}

function writeFile(data) {
  fs.mkdirSync(config.dataDir, { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(data, null, 2), 'utf8')
}

function normalizeFilterWords(input) {
  if (Array.isArray(input)) {
    return input.map((s) => String(s).trim()).filter(Boolean)
  }
  return String(input || '')
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function loadSettings() {
  const stored = { ...DEFAULTS, ...readFile() }
  applyRuntime(stored)
  return getSettings()
}

function applyRuntime(stored) {
  if (stored.preferredQuality && QUALITY_RANK[String(stored.preferredQuality).toLowerCase()] != null) {
    config.preferredQuality = stored.preferredQuality
  }
  if (stored.filterWords != null) {
    config.filterWords = normalizeFilterWords(stored.filterWords)
  }
  if (stored.downloadTimeoutMs != null) {
    const n = Number(stored.downloadTimeoutMs)
    if (Number.isFinite(n) && n >= 30_000) config.downloadTimeoutMs = n
  }
}

export function getSettings() {
  return {
    preferredQuality: config.preferredQuality,
    qualities: QUALITY_OPTIONS,
    filterWords: [...(config.filterWords || [])],
    downloadTimeoutMs: config.downloadTimeoutMs,
  }
}

export function updateSettings(patch = {}) {
  const next = { ...readFile() }
  if (patch.preferredQuality != null) {
    const q = String(patch.preferredQuality).toLowerCase()
    if (!(q in QUALITY_RANK)) throw new Error(`不支持的音质: ${patch.preferredQuality}`)
    next.preferredQuality = q
  }
  if (patch.filterWords != null) {
    next.filterWords = normalizeFilterWords(patch.filterWords)
  }
  if (patch.downloadTimeoutMs != null) {
    const n = Number(patch.downloadTimeoutMs)
    if (!Number.isFinite(n) || n < 30_000) throw new Error('超时时间至少 30 秒')
    next.downloadTimeoutMs = Math.round(n)
  }
  applyRuntime(next)
  writeFile(next)
  return getSettings()
}

/** Whether song name/singer/album matches any filter word. */
export function matchesFilterWords(song, words = config.filterWords) {
  const list = words || []
  if (!list.length) return false
  const hay = `${song?.name || ''} ${song?.singer || song?.artist || ''} ${song?.albumName || song?.album || ''}`.toLowerCase()
  return list.some((w) => w && hay.includes(String(w).toLowerCase()))
}
