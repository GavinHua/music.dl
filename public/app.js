const $ = (s) => document.querySelector(s)
const $$ = (s) => [...document.querySelectorAll(s)]

let jobsTimer = null
let currentPlaylist = { source: '', id: '' }
let detailSongs = []
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
      ${checkable ? `<input type="checkbox" class="pick" aria-label="选择" />` : ''}
      <div class="title">${escapeHtml(s.name || '')}</div>
      <div class="sub"><span class="badge">${escapeHtml(source)}</span>${escapeHtml(s.singer || '')} · ${escapeHtml(s.albumName || s.album || '')}</div>
    </div>
    <div class="actions">
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
  container.querySelectorAll('.btn-one-dl').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const item = btn.closest('.item')
      const song = JSON.parse(item.dataset.json)
      try {
        const job = await api('/download', { method: 'POST', body: JSON.stringify({ songs: [song] }) })
        toast(`已入队任务 #${job.id}`)
      } catch (e) {
        toast(e.message)
      }
    })
  })
}

function selectedSongs(container) {
  return [...container.querySelectorAll('.item')]
    .filter((el) => el.querySelector('.pick')?.checked)
    .map((el) => JSON.parse(el.dataset.json))
}

// ---- detail modal ----
function openDetail({ title, subtitle = '', songs = [], onDownloadAll }) {
  detailSongs = songs || []
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
      const job = await api('/download', { method: 'POST', body: JSON.stringify({ songs: detailSongs }) })
      toast(`已入队 #${job.id}，共 ${detailSongs.length} 首`)
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
    const job = await api('/download', { method: 'POST', body: JSON.stringify({ songs }) })
    toast(`已入队 #${job.id}，共 ${songs.length} 首`)
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
    const job = await api('/download', { method: 'POST', body: JSON.stringify({ songs }) })
    toast(`已入队 #${job.id}，共 ${songs.length} 首`)
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
            <button type="button" class="btn-pl-dl primary" data-id="${escapeAttr(String(id))}" data-source="${escapeAttr(source)}">下载</button>
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
          body: JSON.stringify({ source: btn.dataset.source, id: btn.dataset.id }),
        })
        toast(`歌单任务 #${data.job.id}，${data.count} 首`)
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
          body: JSON.stringify({ source, id }),
        })
        toast(`歌单任务 #${r.job.id}，${r.count} 首`)
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
    toast(`歌单任务 #${data.job.id}，${data.count} 首`)
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
          <button type="button" data-id="${escapeAttr(String(id))}" class="btn-artist-dl primary">下载全部</button></div>
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
                body: JSON.stringify({ source, id: btn.dataset.id }),
              })
              toast(`歌手任务 #${r.job.id}，${r.count} 首`)
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
            body: JSON.stringify({ source, id: btn.dataset.id }),
          })
          toast(`歌手任务 #${data.job.id}，${data.count} 首`)
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
          <button type="button" class="btn-board-dl primary" data-id="${escapeAttr(String(bangid))}">下载</button></div></div>`
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
                body: JSON.stringify({ source, bangid: btn.dataset.id }),
              })
              toast(`榜单任务 #${r.job.id}，${r.count} 首`)
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
            body: JSON.stringify({ source, bangid: btn.dataset.id }),
          })
          toast(`榜单任务 #${data.job.id}，${data.count} 首`)
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
function startJobsAuto() {
  stopJobsAuto()
  if ($('#jobs-auto')?.checked) {
    jobsTimer = setInterval(loadJobs, 2500)
  }
}
function stopJobsAuto() {
  if (jobsTimer) clearInterval(jobsTimer)
  jobsTimer = null
}
$('#jobs-auto')?.addEventListener('change', () => {
  if ($('#jobs-auto').checked) startJobsAuto()
  else stopJobsAuto()
})

async function loadJobs() {
  try {
    const data = await api('/jobs')
    $('#jobs-result').innerHTML =
      (data.list || [])
        .map((j) => {
          const canRetry = ['failed', 'cancelled', 'completed'].includes(j.status)
          const canCancel = ['running', 'pending'].includes(j.status)
          const pct = j.total ? Math.round((j.progress / j.total) * 100) : 0
          return `<div class="item">
          <div class="meta">
            <div class="title">#${j.id} ${escapeHtml(j.type)} <span class="badge status-${escapeHtml(j.status)}">${escapeHtml(j.status)}</span></div>
            <div class="sub">${j.progress}/${j.total}（${pct}%） · ${escapeHtml(j.message || '')}</div>
          </div>
          <div class="actions">
            <button type="button" data-id="${j.id}" class="btn-job-detail">详情</button>
            ${canCancel ? `<button type="button" data-id="${j.id}" class="btn-job-cancel">取消</button>` : ''}
            ${canRetry ? `<button type="button" data-id="${j.id}" class="btn-job-retry">重试失败</button>` : ''}
            <button type="button" data-id="${j.id}" class="btn-job-del">删除</button>
          </div>
        </div>`
        })
        .join('') || emptyHtml('暂无任务')

    $$('.btn-job-detail').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const job = await api(`/jobs/${btn.dataset.id}`)
          const items = (job.items || [])
            .map((i) => `${padStatus(i.status)} | ${i.name} - ${i.singer}\n    ${i.message || ''} ${i.file_path || ''}`)
            .join('\n')
          $('#job-detail').innerHTML = `<div class="job-detail-box"><b>任务 #${job.id}</b>\n${items || '无条目'}</div>`
        } catch (e) {
          toast(e.message)
        }
      })
    })
    $$('.btn-job-cancel').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/jobs/${btn.dataset.id}/cancel`, { method: 'POST', body: '{}' })
          toast('已取消未完成条目')
          loadJobs()
        } catch (e) {
          toast(e.message)
        }
      })
    })
    $$('.btn-job-retry').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/jobs/${btn.dataset.id}/retry`, { method: 'POST', body: '{}' })
          toast('已重新入队失败项')
          loadJobs()
        } catch (e) {
          toast(e.message)
        }
      })
    })
    $$('.btn-job-del').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(`删除任务 #${btn.dataset.id}？`)) return
        try {
          await api(`/jobs/${btn.dataset.id}`, { method: 'DELETE' })
          $('#job-detail').innerHTML = ''
          loadJobs()
        } catch (e) {
          toast(e.message)
        }
      })
    })
  } catch (e) {
    toast(e.message)
  }
}
function padStatus(s) {
  return String(s || '').padEnd(8, ' ')
}
$('#btn-jobs-refresh').addEventListener('click', loadJobs)
$('#btn-jobs-clear').addEventListener('click', async () => {
  try {
    const r = await api('/jobs/clear-finished', { method: 'POST', body: '{}' })
    toast(`已清理 ${r.cleared} 个任务`)
    $('#job-detail').innerHTML = ''
    loadJobs()
  } catch (e) {
    toast(e.message)
  }
})

// ---- sources ----
async function loadSources() {
  try {
    const data = await api('/sources')
    $('#sources-result').innerHTML =
      (data.list || [])
        .map(
          (s) => `<div class="item">
        <div class="meta">
          <div class="title">${escapeHtml(s.name)} <span class="badge ${s.enabled ? 'ok' : 'fail'}">${s.enabled ? '启用' : '禁用'}${s.loaded ? '' : ' · 未加载'}</span></div>
          <div class="sub">${escapeHtml(s.filename)} · v${escapeHtml(s.version || '-')} · ${(s.platforms || []).join(',')}</div>
        </div>
        <div class="actions">
          <button type="button" data-id="${escapeAttr(s.id)}" data-enabled="${s.enabled ? 0 : 1}" class="btn-src-toggle">${s.enabled ? '禁用' : '启用'}</button>
          <button type="button" data-id="${escapeAttr(s.id)}" class="btn-src-del">删除</button>
        </div>
      </div>`
        )
        .join('') || emptyHtml('暂无音源')
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
  } catch (e) {
    toast(e.message)
  }
}
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
            <input type="checkbox" class="pick-miss" data-id="${t.id}" checked aria-label="选择" />
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
    toast(`补歌词任务 #${r.job.id}，共 ${r.count} 首`)
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
    $('#settings-msg').textContent = `当前：${data.preferredQuality}`
  } catch (e) {
    toast(e.message)
  }
}
$('#btn-settings-save')?.addEventListener('click', async () => {
  try {
    const preferredQuality = $('#setting-quality').value
    const data = await api('/settings', {
      method: 'PUT',
      body: JSON.stringify({ preferredQuality }),
    })
    $('#settings-msg').textContent = `已保存：${data.preferredQuality}`
    toast(`默认音质已设为 ${data.preferredQuality}`)
  } catch (e) {
    toast(e.message)
  }
})
