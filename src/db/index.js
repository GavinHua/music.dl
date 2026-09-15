import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'

let db

export function getDb() {
  if (db) return db
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true })
  db = new Database(config.dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      filename TEXT NOT NULL,
      description TEXT DEFAULT '',
      version TEXT DEFAULT '',
      author TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      allow_unsafe_vm INTEGER DEFAULT 0,
      platforms TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS library (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      songmid TEXT NOT NULL,
      name TEXT NOT NULL,
      singer TEXT NOT NULL,
      album TEXT DEFAULT '',
      quality TEXT DEFAULT '',
      file_path TEXT NOT NULL,
      lyric_path TEXT DEFAULT '',
      file_size INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(platform, songmid)
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload TEXT NOT NULL DEFAULT '{}',
      progress INTEGER DEFAULT 0,
      total INTEGER DEFAULT 0,
      message TEXT DEFAULT '',
      result TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS job_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      platform TEXT,
      songmid TEXT,
      name TEXT,
      singer TEXT,
      album TEXT,
      quality TEXT,
      status TEXT DEFAULT 'pending',
      message TEXT DEFAULT '',
      file_path TEXT DEFAULT '',
      music_info TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(job_id) REFERENCES jobs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_library_name ON library(name, singer);
    CREATE INDEX IF NOT EXISTS idx_job_items_job ON job_items(job_id);
  `)
  return db
}

export const sourcesRepo = {
  list() {
    return getDb().prepare('SELECT * FROM sources ORDER BY sort_order ASC, name ASC').all()
  },
  get(id) {
    return getDb().prepare('SELECT * FROM sources WHERE id = ?').get(id)
  },
  upsert(row) {
    getDb()
      .prepare(
        `INSERT INTO sources (id, name, filename, description, version, author, enabled, sort_order, allow_unsafe_vm, platforms, updated_at)
         VALUES (@id, @name, @filename, @description, @version, @author, @enabled, @sort_order, @allow_unsafe_vm, @platforms, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name,
           filename=excluded.filename,
           description=excluded.description,
           version=excluded.version,
           author=excluded.author,
           enabled=excluded.enabled,
           sort_order=excluded.sort_order,
           allow_unsafe_vm=excluded.allow_unsafe_vm,
           platforms=excluded.platforms,
           updated_at=datetime('now')`
      )
      .run(row)
  },
  setEnabled(id, enabled) {
    getDb().prepare(`UPDATE sources SET enabled = ?, updated_at = datetime('now') WHERE id = ?`).run(enabled ? 1 : 0, id)
  },
  reorder(ids) {
    const stmt = getDb().prepare(`UPDATE sources SET sort_order = ?, updated_at = datetime('now') WHERE id = ?`)
    const tx = getDb().transaction((list) => {
      list.forEach((id, i) => stmt.run(i, id))
    })
    tx(ids)
  },
  remove(id) {
    getDb().prepare('DELETE FROM sources WHERE id = ?').run(id)
  },
}

export const libraryRepo = {
  findByKey(platform, songmid) {
    return getDb().prepare('SELECT * FROM library WHERE platform = ? AND songmid = ?').get(platform, songmid)
  },
  findByNameSinger(name, singer) {
    return getDb()
      .prepare('SELECT * FROM library WHERE lower(name) = lower(?) AND lower(singer) = lower(?)')
      .all(name, singer)
  },
  list({ limit = 100, offset = 0, q = '' } = {}) {
    if (q) {
      const like = `%${q}%`
      return getDb()
        .prepare(
          `SELECT * FROM library WHERE name LIKE ? OR singer LIKE ? OR album LIKE ?
           ORDER BY updated_at DESC LIMIT ? OFFSET ?`
        )
        .all(like, like, like, limit, offset)
    }
    return getDb().prepare('SELECT * FROM library ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(limit, offset)
  },
  all() {
    return getDb().prepare('SELECT * FROM library ORDER BY id ASC').all()
  },
  remove(id) {
    getDb().prepare('DELETE FROM library WHERE id = ?').run(id)
  },
  removeByPath(filePath) {
    getDb().prepare('DELETE FROM library WHERE file_path = ?').run(filePath)
  },
  upsert(row) {
    getDb()
      .prepare(
        `INSERT INTO library (platform, songmid, name, singer, album, quality, file_path, lyric_path, file_size, updated_at)
         VALUES (@platform, @songmid, @name, @singer, @album, @quality, @file_path, @lyric_path, @file_size, datetime('now'))
         ON CONFLICT(platform, songmid) DO UPDATE SET
           name=excluded.name,
           singer=excluded.singer,
           album=excluded.album,
           quality=excluded.quality,
           file_path=excluded.file_path,
           lyric_path=excluded.lyric_path,
           file_size=excluded.file_size,
           updated_at=datetime('now')`
      )
      .run(row)
  },
}

export const jobsRepo = {
  create({ type, payload = {}, total = 0 }) {
    const info = getDb()
      .prepare(
        `INSERT INTO jobs (type, status, payload, total) VALUES (?, 'pending', ?, ?)`
      )
      .run(type, JSON.stringify(payload), total)
    return info.lastInsertRowid
  },
  update(id, fields) {
    const keys = Object.keys(fields)
    if (!keys.length) return
    const sets = keys.map((k) => `${k} = ?`).join(', ')
    const values = keys.map((k) => (typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]))
    getDb()
      .prepare(`UPDATE jobs SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
      .run(...values, id)
  },
  get(id) {
    const job = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id)
    if (!job) return null
    return {
      ...job,
      payload: safeJson(job.payload),
      result: safeJson(job.result),
    }
  },
  list({ limit = 50 } = {}) {
    return getDb()
      .prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((j) => ({ ...j, payload: safeJson(j.payload), result: safeJson(j.result) }))
  },
  addItem(item) {
    const info = getDb()
      .prepare(
        `INSERT INTO job_items (job_id, platform, songmid, name, singer, album, quality, status, message, music_info)
         VALUES (@job_id, @platform, @songmid, @name, @singer, @album, @quality, @status, @message, @music_info)`
      )
      .run({
        status: 'pending',
        message: '',
        album: '',
        quality: '',
        music_info: '{}',
        ...item,
        music_info: typeof item.music_info === 'string' ? item.music_info : JSON.stringify(item.music_info || {}),
      })
    return info.lastInsertRowid
  },
  updateItem(id, fields) {
    const keys = Object.keys(fields)
    if (!keys.length) return
    const sets = keys.map((k) => `${k} = ?`).join(', ')
    const values = keys.map((k) => fields[k])
    getDb()
      .prepare(`UPDATE job_items SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
      .run(...values, id)
  },
  listItems(jobId) {
    return getDb()
      .prepare('SELECT * FROM job_items WHERE job_id = ? ORDER BY id ASC')
      .all(jobId)
      .map((i) => ({ ...i, music_info: safeJson(i.music_info) }))
  },
  nextPendingItems(limit = 10) {
    return getDb()
      .prepare(
        `SELECT * FROM job_items WHERE status = 'pending' ORDER BY id ASC LIMIT ?`
      )
      .all(limit)
      .map((i) => ({ ...i, music_info: safeJson(i.music_info) }))
  },
  cancelPendingItems(jobId) {
    return getDb()
      .prepare(
        `UPDATE job_items SET status = 'cancelled', message = 'cancelled', updated_at = datetime('now')
         WHERE job_id = ? AND status IN ('pending', 'running')`
      )
      .run(jobId)
  },
  retryFailedItems(jobId) {
    return getDb()
      .prepare(
        `UPDATE job_items SET status = 'pending', message = '', updated_at = datetime('now')
         WHERE job_id = ? AND status IN ('failed', 'cancelled')`
      )
      .run(jobId)
  },
  delete(jobId) {
    const tx = getDb().transaction((id) => {
      getDb().prepare('DELETE FROM job_items WHERE job_id = ?').run(id)
      getDb().prepare('DELETE FROM jobs WHERE id = ?').run(id)
    })
    tx(jobId)
  },
  clearFinished() {
    const rows = getDb()
      .prepare(`SELECT id FROM jobs WHERE status IN ('completed', 'failed', 'cancelled')`)
      .all()
    const tx = getDb().transaction((list) => {
      for (const r of list) {
        getDb().prepare('DELETE FROM job_items WHERE job_id = ?').run(r.id)
        getDb().prepare('DELETE FROM jobs WHERE id = ?').run(r.id)
      }
    })
    tx(rows)
    return rows.length
  },
}

function safeJson(s) {
  try {
    return JSON.parse(s || '{}')
  } catch {
    return {}
  }
}
