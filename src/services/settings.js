import fs from 'node:fs'
import path from 'node:path'
import { config, QUALITY_RANK } from '../config.js'

const settingsPath = () => path.join(config.dataDir, 'settings.json')

const DEFAULTS = {
  preferredQuality: config.preferredQuality || 'flac',
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

export function loadSettings() {
  const stored = { ...DEFAULTS, ...readFile() }
  if (stored.preferredQuality && QUALITY_RANK[String(stored.preferredQuality).toLowerCase()] != null) {
    config.preferredQuality = stored.preferredQuality
  }
  return getSettings()
}

export function getSettings() {
  return {
    preferredQuality: config.preferredQuality,
    qualities: QUALITY_OPTIONS,
  }
}

export function updateSettings(patch = {}) {
  const next = { ...readFile() }
  if (patch.preferredQuality != null) {
    const q = String(patch.preferredQuality).toLowerCase()
    if (!(q in QUALITY_RANK)) throw new Error(`不支持的音质: ${patch.preferredQuality}`)
    next.preferredQuality = q
    config.preferredQuality = q
  }
  writeFile(next)
  return getSettings()
}
