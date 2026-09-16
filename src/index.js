import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { config } from './config.js'
import { getDb } from './db/index.js'
import { createApiRouter } from './routes/api.js'
import { initMusicSdk } from './services/music.js'
import { reloadSources } from './services/sources.js'
import { loadSettings } from './services/settings.js'
import { restartTelegramBot } from './tg/bot.js'

async function main() {
  process.on('unhandledRejection', (err) => {
    console.warn('[unhandledRejection]', err?.message || err)
  })
  process.on('uncaughtException', (err) => {
    console.warn('[uncaughtException]', err?.message || err)
  })

  fs.mkdirSync(config.dataDir, { recursive: true })
  fs.mkdirSync(config.musicDir, { recursive: true })
  fs.mkdirSync(config.sourceDir, { recursive: true })

  // global stub used by vendor request.js proxy helpers
  global.lx = global.lx || { config: {} }

  getDb()
  loadSettings()
  await initMusicSdk()
  const sourceResult = await reloadSources()
  console.log(
    '[sources]',
    sourceResult.results.map((r) => `${r.name}:${r.success ? 'ok' : r.skipped ? 'off' : r.error}`).join(', ')
  )

  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use(express.urlencoded({ extended: true }))
  app.use('/api', createApiRouter())
  app.use(express.static(path.join(config.root, 'public')))

  app.get('/files/*', (req, res) => {
    const rel = req.params[0]
    const abs = path.join(config.musicDir, rel)
    if (!abs.startsWith(config.musicDir) || !fs.existsSync(abs)) {
      return res.status(404).end('not found')
    }
    res.sendFile(abs)
  })

  app.listen(config.port, config.host, () => {
    console.log(`[app] listening on http://${config.host}:${config.port}`)
  })

  await restartTelegramBot()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
