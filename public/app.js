const $ = (s) => document.querySelector(s)
const $$ = (s) => [...document.querySelectorAll(s)]

let jobsTimer = null
let openJobId = null
let sourceEditMode = false
let sourceDraftList = []
let sourceSavedIds = []
let currentPlaylist = { source: '', id: '' }
let detailSongs = []
let detailTitle = ''
let missingLyricTracks = []

function toast(msg) {
  const el = $('#toast')
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => el.classList.remove('show'), 2800)
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: opts.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    ...opts,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

function closeMoreSheet() {
  const sheet = $('#more-sheet')
  if (sheet) sheet.hidden = true
}

function openMoreSheet() {
  const sheet = $('#more-sheet')
  if (sheet) sheet.hidden = false
}

function switchTab(tab) {
  if (!tab || tab === 'more') return
  $$('.nav-btn[data-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab)
  })
  $$('.panel').forEach((p) => p.classList.remove('active'))
  const panel = $(`#tab-${tab}`)
  if (!panel) return
  panel.classList.add('active')
  closeMoreSheet()
  closeDetail()

  if (tab === 'jobs') {
    loadJobs()
    startJobsAuto()
  } else {
    stopJobsAuto()
  }
  if (tab === 'sources') loadSources()
  else if (sourceEditMode) exitSourceEditMode(true)
  if (tab === 'library') loadLibrary()
  if (tab === 'playlist') browsePlaylists()
  if (tab === 'board') loadBoards()
  if (tab === 'settings') loadSettings()

  window.scrollTo({ top: 0, behavior: 'smooth' })
}

$$('.nav-btn[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'more' || btn.id === 'btn-more-menu') {
      openMoreSheet()
      return
    }
    switchTab(btn.dataset.tab)
  })
})

$$('[data-close-sheet]').forEach((el) => {
  el.addEventListener('click', closeMoreSheet)
})

$('#btn-goto-jobs')?.addEventListener('click', () => switchTab('jobs'))

function onEnter(id, fn) {
  $(id)?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      fn()
    }
  })
}

function emptyHtml(text = '暂无内容') {
  return `<div class="empty">${escapeHtml(text)}</div>`
}

function songItemHtml(s, { checkable = true } = {}) {
  const source = s.source || ''
  return `<div class="item" data-json='${escapeAttr(JSON.stringify(s))}'>
    <div class="meta">
      ${checkable ? `<label class="pick-wrap"><input type="checkbox" class="pick" aria-label="选择" /></label>` : ''}
      <div class="title">${escapeHtml(s.name || '')}</div>
      <div class="sub"><span class="badge">${escapeHtml(source)}</span>${escapeHtml(s.singer || '')} · ${escapeHtml(s.albumName || s.album || '')}</div>
    </div>
    <div class="actions">
      <button type="button" class="btn-preview">试听</button>
      <button type="button" class="btn-one-dl primary">下载</button>
    </div>
  </div>`
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
function escapeAttr(s) {
  return escapeHtml(s).replaceAll("'", '&#39;')
}

function bindSongList(container) {
  container.querySelectorAll('.item').forEach((item) => {
    const pick = item.querySelector('.pick')
    if (pick) {
      item.addEventListener('click', (e) => {
        if (e.target.closest('button, a, input, label, .actions')) return
        pick.checked = !pick.checked
      })
    }
  })
  container.querySelectorAll('.btn-one-dl').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const item = btn.closest('.item')
      const song = JSON.parse(item.dataset.json)
      try {
        const job = await api('/download', { method: 'POST', body: JSON.stringify({ songs: [song] }) })
        toast(`已入队 #${job.id} · ${job.title || song.name || '下载'}`)
      } catch (e) {
        toast(e.message)
      }
    })
  })
  container.querySelectorAll('.btn-preview').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const item = btn.closest('.item')
      const song = JSON.parse(item.dataset.json)
      await playPreview(song)
    })
  })
}

async function playPreview(song) {
  try {
    toast('解析试听地址…')
    const data = await api('/preview', {
      method: 'POST',
      body: JSON.stringify({ musicInfo: song }),
    })
    const audio = $('#player-audio')
    const bar = $('#player-bar')
    $('#player-title').textContent = data.name || song.name || '试听'
    $('#player-sub').textContent = `${data.singer || song.singer || ''} · ${data.sourceName || ''} @ ${data.quality || ''}`
    audio.src = data.streamPath
    bar.hidden = false
    bar.classList.add('is-open')
    document.body.classList.add('has-player')
    await audio.play().catch(() => {})
  } catch (e) {
    toast(e.message)
  }
}

function closePlayer() {
  const audio = $('#player-audio')
  if (audio) {
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
  }
  const bar = $('#player-bar')
  if (bar) {
    bar.hidden = true
    bar.classList.remove('is-open')
  }
  document.body.classList.remove('has-player')
}
$('#btn-player-close')?.addEventListener('click', closePlayer)
$('#player-audio')?.addEventListener('ended', closePlayer)

function selectedSongs(container) {
  return [...container.querySelectorAll('.item')]
    .filter((el) => el.querySelector('.pick')?.checked)
    .map((el) => JSON.parse(el.dataset.json))
}

// ---- detail modal ----
function openDetail({ title, subtitle = '', songs = [], onDownloadAll }) {
  detailSongs = songs || []
  detailTitle = title || ''
  $('#detail-title').textContent = title || '详情'
  $('#detail-sub').textContent = subtitle || `${detailSongs.length} 首`
  const body = $('#detail-body')
  body.innerHTML = detailSongs.map((s) => songItemHtml(s)).join('') || emptyHtml('暂无歌曲')
  bindSongList(body)
  $('#detail-check-all').checked = false
  $('#btn-detail-dl').onclick = async () => {
    if (typeof onDownloadAll === 'function') return onDownloadAll()
    if (!detailSongs.length) return toast('没有歌曲')
    try {
      const job = await api('/download', {
        method: 'POST',
        body: JSON.stringify({ songs: detailSongs, title: detailTitle || undefined }),
      })
      toast(`已入队 #${job.id} · ${job.title || detailTitle || '下载'}，共 ${detailSongs.length} 首`)
    } catch (e) {
      toast(e.message)
    }
  }
  $('#detail-sheet').hidden = false
  document.body.style.overflow = 'hidden'
}

function closeDetail() {
  const sheet = $('#detail-sheet')
  if (sheet) sheet.hidden = true
  document.body.style.overflow = ''
}

$$('[data-close-detail]').forEach((el) => el.addEventListener('click', closeDetail))

$('#btn-detail-dl-selected')?.addEventListener('click', async () => {
  const songs = selectedSongs($('#detail-body'))
  if (!songs.length) return toast('未选中歌曲')
  try {
    const job = await api('/download', {
      method: 'POST',
      body: JSON.stringify({ songs, title: detailTitle || undefined }),
    })
    toast(`已入队 #${job.id} · ${job.title || detailTitle || '下载'}，共 ${songs.length} 首`)
  } catch (e) {
    toast(e.message)
  }
})

$('#detail-check-all')?.addEventListener('change', () => {
  const on = $('#detail-check-all').checked
  $('#detail-body').querySelectorAll('.pick').forEach((c) => {
    c.checked = on
  })
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeDetail()
    closeMoreSheet()
  }
})

async function doSearch() {
  const keyword = $('#search-keyword').value.trim()
  const source = $('#search-source').value
  if (!keyword) return toast('请输入关键词')
  try {
    const data = await api(`/search?keyword=${encodeURIComponent(keyword)}&source=${source}`)
    const box = $('#search-result')
    if (source === 'all') {
      const blocks = data.list || []
      box.innerHTML = blocks.length
        ? blocks
            .map((block) => {
              const songs = block.list || []
              return `<h3>${escapeHtml(block.source)} ${block.error ? `(${escapeHtml(block.error)})` : ''}</h3>` +
                (songs.map((s) => songItemHtml(s)).join('') || emptyHtml('该平台无结果'))
            })
            .join('')
        : emptyHtml('无结果')
    } else {
      box.innerHTML = (data.list || []).map((s) => songItemHtml(s)).join('') || emptyHtml('无结果')
    }
    bindSongList(box)
  } catch (e) {
    toast(e.message)
  }
}

$('#btn-search').addEventListener('click', doSearch)
onEnter('#search-keyword', doSearch)

$('#btn-dl-selected').addEventListener('click', async () => {
  const songs = selectedSongs($('#search-result'))
  if (!songs.length) return toast('未选中歌曲')
  try {
    const keyword = $('#search-keyword').value.trim()
    const job = await api('/download', {
      method: 'POST',
      body: JSON.stringify({
        songs,
        title: keyword ? `${keyword} 等 ${songs.length} 首` : undefined,
      }),
    })
    toast(`已入队 #${job.id} · ${job.title || '下载'}，共 ${songs.length} 首`)
  } catch (e) {
    toast(e.message)
  }
})

// ---- playlist square ----
async function browsePlaylists(tagId = '') {
  const source = $('#pl-source').value
  const sortId = $('#pl-sort').value
  try {
    if (!$('#pl-tags').dataset.loaded || $('#pl-tags').dataset.source !== source) {
      const tags = await api(`/song-list/tags?source=${source}`)
      renderTags(tags, source)
    }
    const qs = new URLSearchParams({ source, sortId, page: '1' })
    if (tagId) qs.set('tagId', tagId)
    const data = await api(`/song-list/list?${qs}`)
    renderPlaylistCards(data.list || [], source)
  } catch (e) {
    toast(e.message)
  }
}

function renderTags(tags, source) {
  const box = $('#pl-tags')
  box.dataset.loaded = '1'
  box.dataset.source = source
  const hot = [{ id: '', name: '推荐' }]
  let list = []
  if (Array.isArray(tags?.tags)) {
    for (const g of tags.tags) {
      if (Array.isArray(g.list)) list.push(...g.list.map((t) => ({ id: t.id || t.tagId || `${t.id}-${t.type || ''}`, name: t.name || t.tagName })))
      else if (g.id || g.name) list.push({ id: g.id, name: g.name })
    }
  } else if (Array.isArray(tags?.list)) {
    list = tags.list.map((t) => ({ id: t.id || t.tagId, name: t.name }))
  } else if (Array.isArray(tags)) {
    list = tags.map((t) => ({ id: t.id, name: t.name }))
  }
  const chips = [...hot, ...list.slice(0, 40)]
  box.innerHTML = chips
    .map((t, i) => `<button type="button" class="chip ${i === 0 ? 'active' : ''}" data-id="${escapeAttr(String(t.id || ''))}">${escapeHtml(t.name || t.id)}</button>`)
    .join('')
  box.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      box.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'))
      chip.classList.add('active')
      browsePlaylists(chip.dataset.id || '')
    })
  })
}

function renderPlaylistCards(list, source) {
  const box = $('#pl-lists')
  box.innerHTML =
    list
      .map((p) => {
        const id = p.id || p.listId || p.gid || p.sourceid || ''
        const name = p.name || p.playListName || '未命名歌单'
        const author = p.author || p.userName || p.creator || ''
        const count = p.total || p.trackCount || p.musicnum || ''
        return `<div class="item">
          <div class="meta">
            <div class="title">${escapeHtml(name)}</div>
            <div class="sub">${escapeHtml(author)} · ${escapeHtml(String(count))} 首</div>
          </div>
          <div class="actions">
            <button type="button" class="btn-pl-open" data-id="${escapeAttr(String(id))}" data-name="${escapeAttr(name)}" data-source="${escapeAttr(source)}">查看</button>
            <button type="button" class="btn-pl-dl primary" data-id="${escapeAttr(String(id))}" data-name="${escapeAttr(name)}" data-source="${escapeAttr(source)}">下载</button>
          </div>
        </div>`
      })
      .join('') || emptyHtml('暂无歌单，换个分类试试')

  box.querySelectorAll('.btn-pl-open').forEach((btn) => {
    btn.addEventListener('click', () => openPlaylist(btn.dataset.source, btn.dataset.id, btn.dataset.name))
  })
  box.querySelectorAll('.btn-pl-dl').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const data = await api('/download/playlist', {
          method: 'POST',
          body: JSON.stringify({
            source: btn.dataset.source,
            id: btn.dataset.id,
            name: btn.dataset.name,
          }),
        })
        toast(`#${data.job.id} · ${data.job.title || btn.dataset.name || '歌单'}，${data.count} 首`)
      } catch (e) {
        toast(e.message)
      }
    })
  })
}

async function openPlaylist(source, id, name = '') {
  currentPlaylist = { source, id }
  $('#playlist-input').value = `${source}:${id}`
  try {
    const data = await api(`/song-list/detail?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}`)
    const songs = data.list || []
    openDetail({
      title: name || data.name || data.info?.name || '歌单详情',
      subtitle: `${songs.length} 首（当前页）`,
      songs,
      onDownloadAll: async () => {
        const r = await api('/download/playlist', {
          method: 'POST',
          body: JSON.stringify({ source, id, name: name || undefined }),
        })
        toast(`#${r.job.id} · ${r.job.title || name || '歌单'}，${r.count} 首`)
      },
    })
  } catch (e) {
    toast(e.message)
  }
}

$('#btn-pl-browse').addEventListener('click', () => {
  $('#pl-tags').dataset.loaded = ''
  browsePlaylists()
})
$('#pl-source').addEventListener('change', () => {
  $('#pl-tags').dataset.loaded = ''
  browsePlaylists()
})
$('#btn-pl-search').addEventListener('click', async () => {
  const keyword = $('#pl-search').value.trim()
  const source = $('#pl-source').value
  if (!keyword) return toast('请输入歌单关键词')
  try {
    const data = await api(`/song-list/search?source=${source}&keyword=${encodeURIComponent(keyword)}`)
    renderPlaylistCards(data.list || [], source)
  } catch (e) {
    toast(e.message)
  }
})
onEnter('#pl-search', () => $('#btn-pl-search').click())

$('#btn-playlist-load').addEventListener('click', async () => {
  const id = $('#playlist-input').value.trim()
  if (!id) return toast('请输入歌单')
  try {
    let source = ''
    let realId = id
    const m = id.match(/^(kw|kg|tx|wy|mg)[:/](.+)$/i)
    if (m) {
      source = m[1].toLowerCase()
      realId = m[2]
    }
    const qs = new URLSearchParams({ id: realId })
    if (source) qs.set('source', source)
    const data = await api(`/song-list/detail?${qs}`)
    currentPlaylist = { source: data.source || source, id: realId }
    openDetail({
      title: data.name || data.info?.name || '歌单详情',
      subtitle: `${(data.list || []).length} 首`,
      songs: data.list || [],
    })
  } catch (e) {
    toast(e.message)
  }
})

$('#btn-playlist-dl').addEventListener('click', async () => {
  const id = $('#playlist-input').value.trim() || currentPlaylist.id
  if (!id) return toast('请先打开歌单')
  try {
    let body = { id }
    if (currentPlaylist.source) body = { source: currentPlaylist.source, id: currentPlaylist.id || id }
    const m = String(id).match(/^(kw|kg|tx|wy|mg)[:/](.+)$/i)
    if (m) body = { source: m[1].toLowerCase(), id: m[2] }
    const data = await api('/download/playlist', { method: 'POST', body: JSON.stringify(body) })
    toast(`#${data.job.id} · ${data.job.title || '歌单'}，${data.count} 首`)
  } catch (e) {
    toast(e.message)
  }
})

// ---- artist ----
$('#btn-artist-search').addEventListener('click', async () => {
  const keyword = $('#artist-keyword').value.trim()
  const source = $('#artist-source').value
  if (!keyword) return toast('请输入歌手')
  try {
    const data = await api(`/artist/search?keyword=${encodeURIComponent(keyword)}&source=${source}`)
    const box = $('#artist-result')
    box.innerHTML =
      (data.list || [])
        .map((a) => {
          const id = a.id || a.mid || a.singerid
          const name = a.name || a.info?.name || ''
          return `<div class="item">
          <div class="meta"><div class="title">${escapeHtml(name)}</div><div class="sub">${escapeHtml(source)}</div></div>
          <div class="actions"><button type="button" data-id="${escapeAttr(String(id))}" data-name="${escapeAttr(name)}" class="btn-artist-songs">查看</button>
          <button type="button" data-id="${escapeAttr(String(id))}" data-name="${escapeAttr(name)}" class="btn-artist-dl primary">下载全部</button></div>
        </div>`
        })
        .join('') || emptyHtml('无结果')

    box.querySelectorAll('.btn-artist-songs').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const songs = await api(`/artist/songs?source=${source}&id=${encodeURIComponent(btn.dataset.id)}`)
          openDetail({
            title: btn.dataset.name || '歌手歌曲',
            subtitle: `${(songs.list || []).length} 首`,
            songs: songs.list || [],
            onDownloadAll: async () => {
              const r = await api('/download/artist', {
                method: 'POST',
                body: JSON.stringify({ source, id: btn.dataset.id, name: btn.dataset.name }),
              })
              toast(`#${r.job.id} · ${r.job.title || btn.dataset.name || '歌手'}，${r.count} 首`)
            },
          })
        } catch (e) {
          toast(e.message)
        }
      })
    })
    box.querySelectorAll('.btn-artist-dl').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const data = await api('/download/artist', {
            method: 'POST',
            body: JSON.stringify({ source, id: btn.dataset.id, name: btn.dataset.name }),
          })
          toast(`#${data.job.id} · ${data.job.title || btn.dataset.name || '歌手'}，${data.count} 首`)
        } catch (e) {
          toast(e.message)
        }
      })
    })
  } catch (e) {
    toast(e.message)
  }
})
onEnter('#artist-keyword', () => $('#btn-artist-search').click())

// ---- leaderboard ----
async function loadBoards() {
  const source = $('#board-source').value
  try {
    const data = await api(`/leaderboard/boards?source=${source}`)
    const boards = data.list || (Array.isArray(data) ? data : [])
    const box = $('#board-list')
    box.innerHTML =
      boards
        .map((b) => {
          const bangid = b.bangid != null ? b.bangid : b.id
          const name = b.name || bangid
          return `<div class="item"><div class="meta"><div class="title">${escapeHtml(name)}</div></div>
          <div class="actions"><button type="button" class="btn-board-open" data-id="${escapeAttr(String(bangid))}" data-name="${escapeAttr(String(name))}">查看</button>
          <button type="button" class="btn-board-dl primary" data-id="${escapeAttr(String(bangid))}" data-name="${escapeAttr(String(name))}">下载</button></div></div>`
        })
        .join('') || emptyHtml('无榜单')

    box.querySelectorAll('.btn-board-open').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const songs = await api(
            `/leaderboard/list?source=${source}&bangid=${encodeURIComponent(btn.dataset.id)}`
          )
          const list = songs.list || []
          if (!list.length) toast('该榜单暂无歌曲或接口失败')
          openDetail({
            title: btn.dataset.name || '榜单详情',
            subtitle: `${list.length} 首`,
            songs: list,
            onDownloadAll: async () => {
              const r = await api('/download/leaderboard', {
                method: 'POST',
                body: JSON.stringify({ source, bangid: btn.dataset.id, name: btn.dataset.name }),
              })
              toast(`#${r.job.id} · ${r.job.title || btn.dataset.name || '榜单'}，${r.count} 首`)
            },
          })
        } catch (e) {
          toast(e.message)
        }
      })
    })
    box.querySelectorAll('.btn-board-dl').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const data = await api('/download/leaderboard', {
            method: 'POST',
            body: JSON.stringify({ source, bangid: btn.dataset.id, name: btn.dataset.name }),
          })
          toast(`#${data.job.id} · ${data.job.title || btn.dataset.name || '榜单'}，${data.count} 首`)
        } catch (e) {
          toast(e.message)
        }
      })
    })
  } catch (e) {
    toast(e.message)
  }
}
$('#btn-board-load').addEventListener('click', loadBoards)
$('#board-source').addEventListener('change', loadBoards)

// ---- jobs ----
let jobsRefreshGen = 0
/** `${jobId}:${sec}` -> collapsed */
const jobSecCollapse = Object.create(null)

function startJobsAuto() {
  stopJobsAuto()
  if ($('#jobs-auto')?.checked) {
    jobsTimer = setInterval(() => loadJobs({ soft: true }), jobsPollMs())
  }
}
function stopJobsAuto() {
  if (jobsTimer) clearInterval(jobsTimer)
  jobsTimer = null
}
function jobsPollMs() {
  const hasRunning = [...$$('#jobs-result .job-card')].some((el) =>
    /running|pending/.test(el.dataset.status || '')
  )
  return hasRunning || openJobId ? 1000 : 2500
}
function rescheduleJobsAuto() {
  if ($('#jobs-auto')?.checked) startJobsAuto()
}
$('#jobs-auto')?.addEventListener('change', () => {
  if ($('#jobs-auto').checked) startJobsAuto()
  else stopJobsAuto()
})

function jobCardEl(id) {
  return $(`#jobs-result .job-card[data-id="${id}"]`)
}

function clearJobDetail() {
  openJobId = null
  $$('#jobs-result .job-detail-box').forEach((el) => el.remove())
  $$('#jobs-result .job-card.open').forEach((el) => el.classList.remove('open'))
  $$('#jobs-result .btn-job-detail').forEach((btn) => {
    btn.setAttribute('aria-expanded', 'false')
    btn.textContent = '详情'
  })
}

function statusBadge(status) {
  const map = {
    pending: '等待',
    running: '下载中',
    done: '完成',
    skipped: '跳过',
    failed: '失败',
    cancelled: '取消',
  }
  const label = map[status] || status || ''
  return `<span class="badge status-${escapeHtml(status || '')}">${escapeHtml(label)}</span>`
}

function itemGroup(status) {
  if (status === 'running' || status === 'pending') return 'active'
  if (status === 'failed' || status === 'cancelled') return 'failed'
  return 'done'
}

function itemProgressPct(i) {
  if (i.progress_pct != null && Number.isFinite(Number(i.progress_pct))) return Math.max(0, Math.min(100, Number(i.progress_pct)))
  if (i.bytes_total > 0 && i.bytes_done != null) {
    return Math.max(0, Math.min(100, Math.round((Number(i.bytes_done) / Number(i.bytes_total)) * 100)))
  }
  const m = String(i.message || '').match(/(\d+)\s*%/)
  return m ? Number(m[1]) : null
}

function formatItemBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${(v / (1024 * 1024)).toFixed(1)} MB`
}

function jobItemSubText(i) {
  const pct = itemProgressPct(i)
  const parts = []
  if (i.status === 'running' && (i.bytes_done || pct != null)) {
    if (pct != null && i.bytes_total > 0) {
      parts.push(`${pct}% · ${formatItemBytes(i.bytes_done)}/${formatItemBytes(i.bytes_total)}`)
    } else if (i.bytes_done) {
      parts.push(formatItemBytes(i.bytes_done))
    }
    if (i.speed > 0) parts.push(`${formatItemBytes(i.speed)}/s`)
  }
  if (i.message) parts.push(i.message)
  else if (i.file_path) parts.push(i.file_path)
  return parts.join(' · ')
}

function jobItemRowHtml(i) {
  const canCancel = ['pending', 'running'].includes(i.status)
  const pct = itemProgressPct(i)
  const showBar = i.status === 'running' || (i.status === 'pending' && pct != null)
  const barPct = i.status === 'pending' ? 0 : pct != null ? pct : 8
  return `<div class="job-item-row" data-item-id="${i.id}" data-status="${escapeAttr(i.status || '')}">
    <div class="meta">
      <div class="title">${statusBadge(i.status)} ${escapeHtml(i.name || '')} · ${escapeHtml(i.singer || '')}</div>
      <div class="sub">${escapeHtml(jobItemSubText(i))}</div>
      <div class="job-item-bar${showBar ? ' is-on' : ''}" ${showBar ? '' : 'hidden'}>
        <div class="job-item-bar-fill${pct == null && i.status === 'running' ? ' is-indeterminate' : ''}" style="width:${barPct}%"></div>
      </div>
    </div>
    <div class="actions">
      ${canCancel ? `<button type="button" class="btn-item-cancel" data-item-id="${i.id}">取消</button>` : ''}
    </div>
  </div>`
}

function bindJobItemCancels(scope) {
  scope.querySelectorAll('.btn-item-cancel').forEach((btn) => {
    if (btn.dataset.bound) return
    btn.dataset.bound = '1'
    btn.addEventListener('click', async () => {
      try {
        await api(`/jobs/items/${btn.dataset.itemId}/cancel`, { method: 'POST', body: '{}' })
        toast('已取消该条目')
        if (openJobId) await patchJobDetail(openJobId)
        await loadJobs({ soft: true })
      } catch (e) {
        toast(e.message)
      }
    })
  })
}

function ensureJobDetailStructure(box) {
  if (box.dataset.ready === '1') return
  const labels = {
    active: '下载中',
    done: '已完成',
    failed: '失败 / 取消',
  }
  box.innerHTML = ['active', 'done', 'failed']
    .map(
      (key) => `<div class="job-sec" data-sec="${key}" hidden>
      <button type="button" class="job-sec-head" aria-expanded="true">
        <span class="job-sec-chevron" aria-hidden="true">▾</span>
        <span class="job-sec-label">${labels[key]}</span>
        <span class="job-sec-count">0</span>
      </button>
      <div class="job-sec-list" data-list="${key}"></div>
    </div>`
    )
    .join('')
  box.dataset.ready = '1'
  box.querySelectorAll('.job-sec-head').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sec = btn.closest('.job-sec')
      if (!sec) return
      const collapsed = sec.classList.toggle('is-collapsed')
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
      const jobId = String(openJobId || '')
      const key = sec.dataset.sec
      if (jobId && key) {
        jobSecCollapse[`${jobId}:${key}`] = collapsed
      }
    })
  })
}

function applyJobSecCollapse(box) {
  const jobId = String(openJobId || '')
  box.querySelectorAll('.job-sec').forEach((sec) => {
    const key = sec.dataset.sec
    const stored = jobSecCollapse[`${jobId}:${key}`]
    const collapsed = stored === true
    sec.classList.toggle('is-collapsed', collapsed)
    const head = sec.querySelector('.job-sec-head')
    if (head) head.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
  })
}

function patchOneJobItemRow(row, i) {
  const title = row.querySelector('.title')
  const sub = row.querySelector('.sub')
  const bar = row.querySelector('.job-item-bar')
  const fill = row.querySelector('.job-item-bar-fill')
  const nextTitle = `${i.status}|${i.name || ''}|${i.singer || ''}`
  const nextSub = jobItemSubText(i)
  const pct = itemProgressPct(i)
  const showBar = i.status === 'running' || (i.status === 'pending' && pct != null)
  const barPct = i.status === 'pending' ? 0 : pct != null ? pct : 8
  const barSig = `${showBar}|${pct}|${i.status}`

  if (title && title.dataset.sig !== nextTitle) {
    title.innerHTML = `${statusBadge(i.status)} ${escapeHtml(i.name || '')} · ${escapeHtml(i.singer || '')}`
    title.dataset.sig = nextTitle
  }
  if (sub && sub.dataset.sig !== nextSub) {
    sub.textContent = nextSub
    sub.dataset.sig = nextSub
  }
  if (bar && bar.dataset.sig !== barSig) {
    bar.hidden = !showBar
    bar.classList.toggle('is-on', showBar)
    if (fill) {
      fill.style.width = `${barPct}%`
      fill.classList.toggle('is-indeterminate', pct == null && i.status === 'running')
    }
    bar.dataset.sig = barSig
  } else if (fill && showBar && pct != null) {
    fill.style.width = `${pct}%`
  }

  row.dataset.status = i.status || ''
  const actions = row.querySelector('.actions')
  const canCancel = ['pending', 'running'].includes(i.status)
  const hasBtn = !!row.querySelector('.btn-item-cancel')
  if (canCancel && !hasBtn) {
    actions.innerHTML = `<button type="button" class="btn-item-cancel" data-item-id="${i.id}">取消</button>`
  } else if (!canCancel && hasBtn) {
    actions.innerHTML = ''
  }
}

function patchJobItemRows(box, items) {
  const scrollTop = box.scrollTop
  ensureJobDetailStructure(box)
  applyJobSecCollapse(box)
  const lists = {
    active: box.querySelector('[data-list="active"]'),
    done: box.querySelector('[data-list="done"]'),
    failed: box.querySelector('[data-list="failed"]'),
  }
  const existing = new Map([...box.querySelectorAll('.job-item-row')].map((el) => [el.dataset.itemId, el]))
  const seen = new Set()
  const counts = { active: 0, done: 0, failed: 0 }

  for (const i of items) {
    const id = String(i.id)
    const group = itemGroup(i.status)
    counts[group]++
    seen.add(id)
    let row = existing.get(id)
    const parent = lists[group]
    if (!row) {
      const wrap = document.createElement('div')
      wrap.innerHTML = jobItemRowHtml(i)
      row = wrap.firstElementChild
      parent.appendChild(row)
    } else {
      if (row.parentElement !== parent) parent.appendChild(row)
      patchOneJobItemRow(row, i)
    }
  }

  for (const [id, el] of existing) {
    if (!seen.has(id)) el.remove()
  }

  for (const key of ['active', 'done', 'failed']) {
    const sec = box.querySelector(`[data-sec="${key}"]`)
    if (!sec) continue
    const countEl = sec.querySelector('.job-sec-count')
    if (countEl) countEl.textContent = String(counts[key])
    // 无条目时整块隐藏，避免「暂无进行中」闪烁
    sec.hidden = counts[key] === 0
  }

  bindJobItemCancels(box)
  box.scrollTop = scrollTop
}

async function patchJobDetail(id) {
  const card = jobCardEl(id)
  if (!card) return
  let box = card.querySelector('.job-detail-box')
  if (!box) {
    box = document.createElement('div')
    box.className = 'job-detail-box'
    card.appendChild(box)
  }
  card.classList.add('open')
  card.querySelector('.btn-job-detail')?.setAttribute('aria-expanded', 'true')
  try {
    const job = await api(`/jobs/${id}`)
    if (String(openJobId) !== String(id)) return
    patchJobItemRows(box, job.items || [])
  } catch (e) {
    if (String(openJobId) === String(id)) toast(e.message)
  }
}

function jobDisplayTitle(j) {
  return j.title || j.payload?.title || j.payload?.name || j.type || '任务'
}

function renderJobCardHtml(j, isOpen) {
  const canRetry = ['failed', 'cancelled', 'completed'].includes(j.status)
  const canCancel = ['running', 'pending'].includes(j.status)
  const pct = j.total ? Math.round((j.progress / j.total) * 100) : 0
  const label = jobDisplayTitle(j)
  return `<div class="job-card-row">
    <div class="meta">
      <div class="title">#${j.id} ${escapeHtml(label)} ${statusBadge(j.status)}</div>
      <div class="sub job-progress">${j.progress}/${j.total}（${pct}%） · ${escapeHtml(j.message || '')}</div>
    </div>
    <div class="actions">
      <button type="button" data-id="${j.id}" class="btn-job-detail" aria-expanded="${isOpen ? 'true' : 'false'}">${isOpen ? '收起' : '详情'}</button>
      ${canCancel ? `<button type="button" data-id="${j.id}" class="btn-job-cancel">全部取消</button>` : ''}
      ${canRetry ? `<button type="button" data-id="${j.id}" class="btn-job-retry">重试失败</button>` : ''}
      <button type="button" data-id="${j.id}" class="btn-job-del">删除</button>
    </div>
  </div>`
}

function syncJobCardActions(card, j, isOpen) {
  const actions = card.querySelector('.job-card-row .actions')
  if (!actions) return
  const canRetry = ['failed', 'cancelled', 'completed'].includes(j.status)
  const canCancel = ['running', 'pending'].includes(j.status)
  const want = `${canCancel ? 1 : 0}|${canRetry ? 1 : 0}|${isOpen ? 1 : 0}`
  if (actions.dataset.sig === want) {
    const detailBtn = actions.querySelector('.btn-job-detail')
    if (detailBtn) {
      detailBtn.textContent = isOpen ? '收起' : '详情'
      detailBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false')
    }
    return
  }
  actions.innerHTML = `
    <button type="button" data-id="${j.id}" class="btn-job-detail" aria-expanded="${isOpen ? 'true' : 'false'}">${isOpen ? '收起' : '详情'}</button>
    ${canCancel ? `<button type="button" data-id="${j.id}" class="btn-job-cancel">全部取消</button>` : ''}
    ${canRetry ? `<button type="button" data-id="${j.id}" class="btn-job-retry">重试失败</button>` : ''}
    <button type="button" data-id="${j.id}" class="btn-job-del">删除</button>`
  actions.dataset.sig = want
  bindJobCardActions(card)
}

function bindJobCardActions(root = $('#jobs-result')) {
  root.querySelectorAll('.btn-job-detail').forEach((btn) => {
    if (btn.dataset.bound) return
    btn.dataset.bound = '1'
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id
      if (String(openJobId) === String(id)) {
        clearJobDetail()
        return
      }
      openJobId = id
      $$('#jobs-result .job-card').forEach((el) => {
        if (el.dataset.id === String(id)) return
        el.classList.remove('open')
        el.querySelector('.job-detail-box')?.remove()
        const b = el.querySelector('.btn-job-detail')
        if (b) {
          b.setAttribute('aria-expanded', 'false')
          b.textContent = '详情'
        }
      })
      btn.textContent = '收起'
      await patchJobDetail(id)
      rescheduleJobsAuto()
    })
  })
  root.querySelectorAll('.btn-job-cancel').forEach((btn) => {
    if (btn.dataset.bound) return
    btn.dataset.bound = '1'
    btn.addEventListener('click', async () => {
      try {
        await api(`/jobs/${btn.dataset.id}/cancel`, { method: 'POST', body: '{}' })
        toast('已取消未完成条目')
        loadJobs({ soft: true })
      } catch (e) {
        toast(e.message)
      }
    })
  })
  root.querySelectorAll('.btn-job-retry').forEach((btn) => {
    if (btn.dataset.bound) return
    btn.dataset.bound = '1'
    btn.addEventListener('click', async () => {
      try {
        await api(`/jobs/${btn.dataset.id}/retry`, { method: 'POST', body: '{}' })
        toast('已重新入队失败项')
        loadJobs({ soft: true })
      } catch (e) {
        toast(e.message)
      }
    })
  })
  root.querySelectorAll('.btn-job-del').forEach((btn) => {
    if (btn.dataset.bound) return
    btn.dataset.bound = '1'
    btn.addEventListener('click', async () => {
      if (!confirm(`删除任务 #${btn.dataset.id}？`)) return
      try {
        await api(`/jobs/${btn.dataset.id}`, { method: 'DELETE' })
        if (String(openJobId) === String(btn.dataset.id)) clearJobDetail()
        loadJobs({ soft: false })
      } catch (e) {
        toast(e.message)
      }
    })
  })
}

function softPatchJobCards(list) {
  const box = $('#jobs-result')
  const existing = new Map([...box.querySelectorAll('.job-card')].map((el) => [el.dataset.id, el]))
  const seen = new Set()

  if (!list.length) {
    if (!box.querySelector('.empty')) box.innerHTML = emptyHtml('暂无任务')
    return
  }
  box.querySelector('.empty')?.remove()

  let prev = null
  for (const j of list) {
    const id = String(j.id)
    seen.add(id)
    const isOpen = String(openJobId) === id
    let card = existing.get(id)
    if (!card) {
      const wrap = document.createElement('div')
      wrap.innerHTML = `<div class="item job-card${isOpen ? ' open' : ''}" data-id="${j.id}" data-status="${escapeAttr(j.status || '')}">
        ${renderJobCardHtml(j, isOpen)}
        ${isOpen ? `<div class="job-detail-box"></div>` : ''}
      </div>`
      card = wrap.firstElementChild
      bindJobCardActions(card)
    }

    if (!prev) {
      if (box.firstChild !== card) box.insertBefore(card, box.firstChild)
    } else if (prev.nextSibling !== card) {
      prev.after(card)
    }

    const pct = j.total ? Math.round((j.progress / j.total) * 100) : 0
    const title = card.querySelector('.job-card-row .title')
    const sub = card.querySelector('.job-progress')
    const sig = `${j.status}|${j.progress}|${j.total}|${j.message || ''}|${jobDisplayTitle(j)}`
    if (card.dataset.sig !== sig) {
      if (title) title.innerHTML = `#${j.id} ${escapeHtml(jobDisplayTitle(j))} ${statusBadge(j.status)}`
      if (sub) sub.textContent = `${j.progress}/${j.total}（${pct}%） · ${j.message || ''}`
      card.dataset.sig = sig
    }
    syncJobCardActions(card, j, isOpen)
    card.dataset.status = j.status || ''
    card.classList.toggle('open', isOpen)
    if (!isOpen) card.querySelector('.job-detail-box')?.remove()
    prev = card
  }

  for (const [id, el] of existing) {
    if (!seen.has(id)) {
      if (String(openJobId) === id) openJobId = null
      el.remove()
    }
  }
}

async function loadJobs({ soft = true } = {}) {
  const gen = ++jobsRefreshGen
  try {
    const data = await api('/jobs')
    if (gen !== jobsRefreshGen) return
    const list = data.list || []
    const box = $('#jobs-result')

    if (!soft) {
      const openId = openJobId
      box.innerHTML =
        list
          .map((j) => {
            const isOpen = String(openId) === String(j.id)
            return `<div class="item job-card${isOpen ? ' open' : ''}" data-id="${j.id}" data-status="${escapeAttr(j.status || '')}">
              ${renderJobCardHtml(j, isOpen)}
              ${isOpen ? `<div class="job-detail-box"></div>` : ''}
            </div>`
          })
          .join('') || emptyHtml('暂无任务')
      bindJobCardActions(box)
    } else {
      softPatchJobCards(list)
    }

    if (openJobId && gen === jobsRefreshGen) await patchJobDetail(openJobId)
    if (gen === jobsRefreshGen) rescheduleJobsAuto()
  } catch (e) {
    if (gen === jobsRefreshGen) toast(e.message)
  }
}
$('#btn-jobs-refresh').addEventListener('click', () => loadJobs({ soft: false }))
$('#btn-jobs-clear').addEventListener('click', async () => {
  try {
    const r = await api('/jobs/clear-finished', { method: 'POST', body: '{}' })
    toast(`已清理 ${r.cleared} 个任务`)
    clearJobDetail()
    loadJobs({ soft: false })
  } catch (e) {
    toast(e.message)
  }
})

// ---- sources ----
function sourceOrderToolbar(editing) {
  $('#btn-src-edit-order').hidden = editing
  $('#btn-src-save-order').hidden = !editing
  $('#btn-src-cancel-order').hidden = !editing
  $('#sources-order-hint').hidden = !editing
  $('#btn-sources-reload').disabled = editing
  $('#btn-source-import').disabled = editing
  $('#source-url').disabled = editing
}

function exitSourceEditMode(reload = true) {
  sourceEditMode = false
  sourceDraftList = []
  sourceSavedIds = []
  sourceOrderToolbar(false)
  if (reload) loadSources()
  else renderSourceList(sourceDraftList.length ? sourceDraftList : [])
}

function enterSourceEditMode(list) {
  sourceEditMode = true
  sourceDraftList = list.map((s) => ({ ...s }))
  sourceSavedIds = list.map((s) => s.id)
  sourceOrderToolbar(true)
  renderSourceList(sourceDraftList)
}

function moveSourceDraft(id, dir) {
  const ids = sourceDraftList.map((s) => s.id)
  const i = ids.indexOf(id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= sourceDraftList.length) return
  const next = [...sourceDraftList]
  ;[next[i], next[j]] = [next[j], next[i]]
  sourceDraftList = next
  renderSourceList(sourceDraftList)
  const dirty = sourceDraftList.some((s, idx) => s.id !== sourceSavedIds[idx])
  $('#btn-src-save-order').disabled = !dirty
}

function renderSourceList(list) {
  const editing = sourceEditMode
  $('#sources-result').innerHTML =
    list
      .map(
        (s, idx) => `<div class="item${editing ? ' src-editing' : ''}" data-id="${escapeAttr(s.id)}">
        <div class="meta">
          <div class="title"><span class="src-rank">${idx + 1}</span>${escapeHtml(s.name)} <span class="badge ${s.enabled ? 'ok' : 'fail'}">${s.enabled ? '启用' : '禁用'}${s.loaded ? '' : ' · 未加载'}</span></div>
          <div class="sub">${escapeHtml(s.filename)} · v${escapeHtml(s.version || '-')} · ${(s.platforms || []).join(',')}</div>
        </div>
        <div class="actions">
          ${editing ? `<button type="button" class="btn-icon btn-src-up" data-id="${escapeAttr(s.id)}" title="上移" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="btn-icon btn-src-down" data-id="${escapeAttr(s.id)}" title="下移" ${idx === list.length - 1 ? 'disabled' : ''}>↓</button>` : `<button type="button" class="btn-icon btn-src-up" data-id="${escapeAttr(s.id)}" title="上移" hidden>↑</button>
          <button type="button" class="btn-icon btn-src-down" data-id="${escapeAttr(s.id)}" title="下移" hidden>↓</button>`}
          <button type="button" data-id="${escapeAttr(s.id)}" class="btn-src-test">测试</button>
          <button type="button" data-id="${escapeAttr(s.id)}" data-enabled="${s.enabled ? 0 : 1}" class="btn-src-toggle">${s.enabled ? '禁用' : '启用'}</button>
          <button type="button" data-id="${escapeAttr(s.id)}" class="btn-src-del">删除</button>
        </div>
      </div>`
      )
      .join('') || emptyHtml('暂无音源')

  if (editing) {
    $$('.btn-src-up').forEach((btn) => {
      btn.addEventListener('click', () => moveSourceDraft(btn.dataset.id, -1))
    })
    $$('.btn-src-down').forEach((btn) => {
      btn.addEventListener('click', () => moveSourceDraft(btn.dataset.id, 1))
    })
    return
  }

  $$('.btn-src-test').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true
      try {
        const r = await api(`/sources/${encodeURIComponent(btn.dataset.id)}/test`, {
          method: 'POST',
          body: '{}',
        })
        toast(`✓ ${r.sourceName || ''} ${r.ms}ms · ${r.song?.name} · ${r.urlHost}`)
      } catch (e) {
        toast(`测试失败: ${e.message}`)
      } finally {
        btn.disabled = false
      }
    })
  })
  $$('.btn-src-toggle').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api('/sources/toggle', {
        method: 'POST',
        body: JSON.stringify({ id: btn.dataset.id, enabled: btn.dataset.enabled === '1' }),
      })
      loadSources()
    })
  })
  $$('.btn-src-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('删除该音源？')) return
      await api(`/sources/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' })
      loadSources()
    })
  })
}

async function loadSources() {
  try {
    const data = await api('/sources')
    const list = data.list || []
    if (sourceEditMode) {
      sourceDraftList = list.map((s) => ({ ...s }))
      sourceSavedIds = list.map((s) => s.id)
      renderSourceList(sourceDraftList)
      return
    }
    renderSourceList(list)
  } catch (e) {
    toast(e.message)
  }
}

$('#btn-src-edit-order')?.addEventListener('click', async () => {
  try {
    const data = await api('/sources')
    const list = data.list || []
    if (!list.length) return toast('暂无音源')
    enterSourceEditMode(list)
    $('#btn-src-save-order').disabled = true
  } catch (e) {
    toast(e.message)
  }
})

$('#btn-src-cancel-order')?.addEventListener('click', () => {
  exitSourceEditMode(true)
  toast('已取消排序编辑')
})

$('#btn-src-save-order')?.addEventListener('click', async () => {
  const ids = sourceDraftList.map((s) => s.id)
  const dirty = ids.some((id, i) => id !== sourceSavedIds[i])
  if (!dirty) {
    exitSourceEditMode(true)
    return
  }
  const btn = $('#btn-src-save-order')
  btn.disabled = true
  try {
    await api('/sources/reorder', { method: 'POST', body: JSON.stringify({ ids }) })
    toast('排序已保存')
    sourceEditMode = false
    sourceDraftList = []
    sourceSavedIds = []
    sourceOrderToolbar(false)
    await loadSources()
  } catch (e) {
    toast(e.message)
    btn.disabled = false
  }
})
$('#btn-sources-reload').addEventListener('click', async () => {
  try {
    await api('/sources/reload', { method: 'POST', body: '{}' })
    toast('已重新加载')
    loadSources()
  } catch (e) {
    toast(e.message)
  }
})
$('#btn-source-import').addEventListener('click', async () => {
  const url = $('#source-url').value.trim()
  if (!url) return toast('请输入 URL')
  try {
    await api('/sources/import-url', { method: 'POST', body: JSON.stringify({ url }) })
    toast('导入成功')
    loadSources()
  } catch (e) {
    toast(e.message)
  }
})
$('#source-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0]
  if (!file) return
  const fd = new FormData()
  fd.append('file', file)
  try {
    const res = await fetch('/api/sources/upload', { method: 'POST', body: fd })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'upload failed')
    toast('上传成功')
    loadSources()
  } catch (err) {
    toast(err.message)
  }
})

// ---- library ----
async function loadLibrary() {
  try {
    const q = $('#library-q').value.trim()
    const data = await api(`/library?q=${encodeURIComponent(q)}`)
    $('#library-result').innerHTML =
      (data.list || [])
        .map(
          (t) => `<div class="item"><div class="meta">
          <div class="title">${escapeHtml(t.name)} · ${escapeHtml(t.singer)} ${t.exists === false ? '<span class="badge fail">文件缺失</span>' : ''} ${t.has_lyric ? '<span class="badge ok">有歌词</span>' : '<span class="badge">无歌词</span>'}</div>
          <div class="sub"><span class="badge">${escapeHtml(t.quality)}</span>${escapeHtml(t.file_path)}</div>
        </div>
        <div class="actions">
          <button type="button" data-id="${t.id}" class="btn-lib-del">删记录</button>
          <button type="button" data-id="${t.id}" class="btn-lib-rm">删文件</button>
        </div></div>`
        )
        .join('') || emptyHtml('曲库为空')
    $$('.btn-lib-del').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api(`/library/${btn.dataset.id}`, { method: 'DELETE' })
        toast('已删除曲库记录，可重新下载（文件仍在磁盘）')
        loadLibrary()
      })
    })
    $$('.btn-lib-rm').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('同时删除磁盘文件？')) return
        await api(`/library/${btn.dataset.id}?file=1`, { method: 'DELETE' })
        loadLibrary()
      })
    })
  } catch (e) {
    toast(e.message)
  }
}
$('#btn-library').addEventListener('click', loadLibrary)
onEnter('#library-q', loadLibrary)
$('#btn-library-sync').addEventListener('click', async () => {
  try {
    const r = await api('/library/sync', { method: 'POST', body: '{}' })
    $('#library-sync-msg').textContent = `同步完成：清理 ${r.removed} 条失效记录，歌词标记清理 ${r.lyricCleared}，剩余 ${r.remaining}，磁盘孤儿文件 ${r.orphans}`
    loadLibrary()
  } catch (e) {
    toast(e.message)
  }
})

async function scanMissingLyrics() {
  try {
    $('#missing-lyrics-msg').textContent = '扫描中…'
    const data = await api('/library/missing-lyrics')
    missingLyricTracks = data.list || []
    $('#missing-lyrics-msg').textContent = `发现 ${missingLyricTracks.length} 首缺少歌词`
    const box = $('#missing-lyrics-result')
    box.innerHTML =
      missingLyricTracks
        .map(
          (t) => `<div class="item">
          <div class="meta">
            <label class="pick-wrap"><input type="checkbox" class="pick-miss" data-id="${t.id}" checked aria-label="选择" /></label>
            <div class="title">${escapeHtml(t.name)} · ${escapeHtml(t.singer)}</div>
            <div class="sub"><span class="badge">${escapeHtml(t.quality || '')}</span>${escapeHtml(t.file_path || '')}</div>
          </div>
        </div>`
        )
        .join('') || emptyHtml('全部歌曲都已内嵌歌词')
  } catch (e) {
    toast(e.message)
    $('#missing-lyrics-msg').textContent = ''
  }
}

$('#btn-scan-lyrics')?.addEventListener('click', scanMissingLyrics)
$('#btn-fill-lyrics')?.addEventListener('click', async () => {
  try {
    let ids = [...$$('.pick-miss:checked')].map((el) => el.dataset.id)
    if (!ids.length && missingLyricTracks.length) {
      ids = missingLyricTracks.map((t) => String(t.id))
    }
    if (!ids.length) {
      await scanMissingLyrics()
      ids = missingLyricTracks.map((t) => String(t.id))
    }
    if (!ids.length) return toast('没有需要补歌词的歌曲')
    const r = await api('/library/fill-lyrics', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    })
    if (!r.job) return toast(r.message || '无需处理')
    toast(`#${r.job.id} · ${r.job.title || '补歌词'}，共 ${r.count} 首`)
    switchTab('jobs')
  } catch (e) {
    toast(e.message)
  }
})

// ---- settings ----
async function loadSettings() {
  try {
    const data = await api('/settings')
    const sel = $('#setting-quality')
    sel.innerHTML = (data.qualities || [])
      .map((q) => `<option value="${escapeAttr(q.id)}">${escapeHtml(q.label)}</option>`)
      .join('')
    sel.value = data.preferredQuality || 'flac'
    $('#setting-filters').value = (data.filterWords || []).join('\n')
    $('#setting-timeout').value = Math.round((data.downloadTimeoutMs || 300000) / 1000)
    $('#setting-concurrency').value = data.downloadConcurrency || 2
    $('#settings-msg').textContent = `当前音质 ${data.preferredQuality} · 并发 ${data.downloadConcurrency} · 过滤 ${(data.filterWords || []).length} 词 · 超时 ${Math.round((data.downloadTimeoutMs || 300000) / 1000)}s`
  } catch (e) {
    toast(e.message)
  }
}
$('#btn-settings-save')?.addEventListener('click', async () => {
  try {
    const preferredQuality = $('#setting-quality').value
    const filterWords = $('#setting-filters').value
    const downloadTimeoutMs = Number($('#setting-timeout').value) * 1000
    const downloadConcurrency = Number($('#setting-concurrency').value)
    const data = await api('/settings', {
      method: 'PUT',
      body: JSON.stringify({ preferredQuality, filterWords, downloadTimeoutMs, downloadConcurrency }),
    })
    $('#settings-msg').textContent = `已保存：${data.preferredQuality} · 并发 ${data.downloadConcurrency} · 过滤 ${(data.filterWords || []).length} 词 · 超时 ${Math.round(data.downloadTimeoutMs / 1000)}s`
    toast('设置已保存')
  } catch (e) {
    toast(e.message)
  }
})
