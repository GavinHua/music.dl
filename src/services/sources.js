import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { sourcesRepo } from '../db/index.js'
import {
  extractMetadata,
  downloadScript,
  writeSourceFile,
  sourceIdFromFilename,
} from '../userApi/index.js'
import {
  loadSourceInWorker,
  unloadAllWorkers,
  getWorkerApis,
  getMusicUrlViaWorkers,
  getLyricViaWorkers,
  getMusicUrlCandidates,
  applyWorkerSortOrder,
} from '../userApi/pool.js'

export { getMusicUrlViaWorkers as getMusicUrl, getLyricViaWorkers as getLyricFromSources, getMusicUrlCandidates }

function readScript(filename) {
  return fs.readFileSync(path.join(config.sourceDir, filename), 'utf8')
}

export function scanSourceFiles() {
  fs.mkdirSync(config.sourceDir, { recursive: true })
  return fs
    .readdirSync(config.sourceDir)
    .filter((f) => f.endsWith('.js'))
    .map((filename) => {
      const script = readScript(filename)
      const meta = extractMetadata(script)
      const id = sourceIdFromFilename(filename)
      return {
        id,
        filename,
        name: meta.name || id,
        description: meta.description || '',
        version: String(meta.version || ''),
        author: meta.author || '',
        script,
      }
    })
}

export function syncSourcesToDb() {
  const files = scanSourceFiles()
  const existing = new Map(sourcesRepo.list().map((s) => [s.id, s]))
  // Prefer known good aggregators first on first import
  const preferred = ['全豆要', 'ikun', 'Huibq', '独家', '聚合', '六音', '野花', '野草']
  files.sort((a, b) => {
    const ia = preferred.findIndex((p) => a.name.includes(p) || a.id.includes(p))
    const ib = preferred.findIndex((p) => b.name.includes(p) || b.id.includes(p))
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
  })
  let order = 0
  for (const f of files) {
    const prev = existing.get(f.id)
    sourcesRepo.upsert({
      id: f.id,
      name: f.name,
      filename: f.filename,
      description: f.description,
      version: f.version,
      author: f.author,
      enabled: prev ? prev.enabled : 1,
      sort_order: prev ? prev.sort_order : order++,
      allow_unsafe_vm: prev ? prev.allow_unsafe_vm : 1,
      platforms: prev?.platforms || '[]',
    })
  }
  const fileIds = new Set(files.map((f) => f.id))
  for (const row of sourcesRepo.list()) {
    if (!fileIds.has(row.id)) sourcesRepo.remove(row.id)
  }
  return sourcesRepo.list()
}

export async function reloadSources() {
  await unloadAllWorkers()
  syncSourcesToDb()
  const rows = sourcesRepo.list()
  const results = []
  for (const row of rows) {
    if (!row.enabled) {
      results.push({ id: row.id, name: row.name, success: false, skipped: true })
      continue
    }
    const fullPath = path.join(config.sourceDir, row.filename)
    if (!fs.existsSync(fullPath)) {
      results.push({ id: row.id, name: row.name, success: false, error: 'file missing' })
      continue
    }
    const script = fs.readFileSync(fullPath, 'utf8')
    let res
    try {
      res = await loadSourceInWorker({
        id: row.id,
        name: row.name,
        description: row.description,
        version: row.version,
        author: row.author,
        homepage: '',
        script,
        sources: {},
        enabled: true,
        owner: 'open',
        allowUnsafeVM: !!row.allow_unsafe_vm,
        sortOrder: row.sort_order,
      })
    } catch (e) {
      res = { success: false, error: e.message }
    }
    if (res.success) {
      const platforms = Object.keys(res.apiInstance.info.sources || {})
      sourcesRepo.upsert({
        ...row,
        platforms: JSON.stringify(platforms),
        name: res.apiInstance.info.name || row.name,
        version: String(res.apiInstance.info.version || row.version),
      })
      results.push({ id: row.id, name: row.name, success: true, platforms })
    } else {
      results.push({ id: row.id, name: row.name, success: false, error: res.error })
    }
  }
  return { loaded: getWorkerApis(), results }
}

export function listSources() {
  const loaded = new Map(getWorkerApis().map((a) => [a.id, a]))
  return sourcesRepo.list().map((s) => ({
    ...s,
    enabled: !!s.enabled,
    allow_unsafe_vm: !!s.allow_unsafe_vm,
    platforms: safeParse(s.platforms, []),
    loaded: loaded.has(s.id),
  }))
}

export function setSourceEnabled(id, enabled) {
  sourcesRepo.setEnabled(id, enabled)
}

export function reorderSources(ids) {
  sourcesRepo.reorder(ids)
  applyWorkerSortOrder(ids)
}

export async function importSourceFromUrl(url) {
  const script = await downloadScript(url)
  const meta = extractMetadata(script)
  const base = meta.name || path.basename(new URL(url).pathname) || `source_${Date.now()}`
  const filename = `${sanitizeFilename(base)}.js`
  writeSourceFile(filename, script)
  const id = sourceIdFromFilename(filename)
  sourcesRepo.upsert({
    id,
    name: meta.name || id,
    filename,
    description: meta.description || '',
    version: String(meta.version || ''),
    author: meta.author || '',
    enabled: 1,
    sort_order: sourcesRepo.list().length,
    allow_unsafe_vm: 1,
    platforms: '[]',
  })
  await reloadSources()
  return sourcesRepo.get(id)
}

export async function importSourceUpload(originalName, content) {
  const meta = extractMetadata(content)
  const filename = sanitizeFilename(originalName || `${meta.name || 'upload'}.js`)
  const finalName = filename.endsWith('.js') ? filename : `${filename}.js`
  writeSourceFile(finalName, content)
  const id = sourceIdFromFilename(finalName)
  sourcesRepo.upsert({
    id,
    name: meta.name || id,
    filename: finalName,
    description: meta.description || '',
    version: String(meta.version || ''),
    author: meta.author || '',
    enabled: 1,
    sort_order: sourcesRepo.list().length,
    allow_unsafe_vm: 1,
    platforms: '[]',
  })
  await reloadSources()
  return sourcesRepo.get(id)
}

export async function testSource(id, opts = {}) {
  const { testSourceConnection } = await import('./preview.js')
  return testSourceConnection(id, opts)
}

export function deleteSource(id) {
  const row = sourcesRepo.get(id)
  if (!row) return false
  const full = path.join(config.sourceDir, row.filename)
  if (fs.existsSync(full)) fs.unlinkSync(full)
  sourcesRepo.remove(id)
  return true
}

function sanitizeFilename(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

function safeParse(s, def) {
  try {
    return JSON.parse(s)
  } catch {
    return def
  }
}
