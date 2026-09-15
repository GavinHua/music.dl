import musicSdk from '../vendor/musicSdk/index.js'

const PLATFORMS = ['kw', 'kg', 'tx', 'wy', 'mg']

export function listPlatforms() {
  return musicSdk.sources || PLATFORMS.map((id) => ({ id, name: id }))
}

export async function searchMusic({ keyword, source = 'kw', page = 1, limit = 20 }) {
  const sdk = musicSdk[source]
  if (!sdk?.musicSearch?.search) throw new Error(`平台 ${source} 不支持搜索`)
  return sdk.musicSearch.search(keyword, page, limit)
}

export async function searchAll({ keyword, page = 1, limit = 20 }) {
  const tasks = PLATFORMS.map(async (source) => {
    try {
      const data = await searchMusic({ keyword, source, page, limit })
      return { source, ...(data || { list: [] }) }
    } catch (e) {
      return { source, list: [], error: e.message }
    }
  })
  return Promise.all(tasks)
}

export async function getSongListTags(source = 'kw') {
  const sdk = musicSdk[source]
  if (!sdk?.songList?.getTags) throw new Error(`平台 ${source} 不支持歌单分类`)
  return sdk.songList.getTags()
}

export async function getSongListList({ source = 'kw', sortId, tagId, page = 1 }) {
  const sdk = musicSdk[source]
  if (!sdk?.songList?.getList) throw new Error(`平台 ${source} 不支持歌单列表`)
  return sdk.songList.getList(sortId, tagId, page)
}

export async function searchSongList({ source = 'kw', keyword, page = 1, limit = 20 }) {
  const sdk = musicSdk[source]
  if (!sdk?.songList?.search) throw new Error(`平台 ${source} 不支持歌单搜索`)
  return sdk.songList.search(keyword, page, limit)
}

export async function getSongListDetail({ source = 'kw', id, page = 1 }) {
  const sdk = musicSdk[source]
  if (!sdk?.songList?.getListDetail) throw new Error(`平台 ${source} 不支持歌单详情`)
  return sdk.songList.getListDetail(id, page)
}

export async function getLeaderboardBoards(source = 'kw') {
  const sdk = musicSdk[source]
  if (!sdk?.leaderboard?.getBoards) throw new Error(`平台 ${source} 不支持排行榜`)
  return sdk.leaderboard.getBoards()
}

export async function getLeaderboardList({ source = 'kw', bangid, page = 1 }) {
  const sdk = musicSdk[source]
  if (!sdk?.leaderboard?.getList) throw new Error(`平台 ${source} 不支持排行榜列表`)
  let id = bangid
  // board ids may be like kw__93 / wy__xxx — SDK expects raw bangid
  if (typeof id === 'string' && id.includes('__')) id = id.split('__').pop()
  return sdk.leaderboard.getList(id, page)
}

export async function searchArtist({ keyword, source = 'wy', page = 1, limit = 20 }) {
  const sdk = musicSdk[source]
  if (!sdk?.extendSearch?.searchSinger) throw new Error(`平台 ${source} 不支持歌手搜索`)
  return sdk.extendSearch.searchSinger(keyword, page, limit)
}

export async function getArtistSongs({ source = 'wy', id, page = 1, limit = 100 }) {
  const sdk = musicSdk[source]
  if (!sdk?.extendDetail?.getArtistSongs) throw new Error(`平台 ${source} 不支持歌手歌曲`)
  return sdk.extendDetail.getArtistSongs(id, page, limit)
}

export async function getArtistDetail({ source = 'wy', id }) {
  const sdk = musicSdk[source]
  if (!sdk?.extendDetail?.getArtistDetail) throw new Error(`平台 ${source} 不支持歌手详情`)
  return sdk.extendDetail.getArtistDetail(id)
}

export async function getLyric(musicInfo) {
  const source = musicInfo.source || musicInfo.platform
  const sdk = musicSdk[source]
  if (!sdk?.getLyric) throw new Error(`平台 ${source} 不支持歌词`)
  const result = sdk.getLyric(musicInfo)
  const data = result?.promise ? await result.promise : await result
  // normalize field names
  if (data && !data.lyric && data.lrc) data.lyric = data.lrc
  return data
}

export function detectPlaylistSource(input) {
  const s = String(input || '').trim()
  if (!s) return null
  if (/music\.163\.com|163cn\.tv/i.test(s)) return { source: 'wy', id: s }
  if (/y\.qq\.com|i\.y\.qq\.com/i.test(s)) return { source: 'tx', id: s }
  if (/kugou\.com/i.test(s)) return { source: 'kg', id: s }
  if (/kuwo\.cn/i.test(s)) return { source: 'kw', id: s }
  if (/migu\.cn/i.test(s)) return { source: 'mg', id: s }
  // id with source prefix: wy:123 / tx:xxx
  const m = s.match(/^(kw|kg|tx|wy|mg)[:/](.+)$/i)
  if (m) return { source: m[1].toLowerCase(), id: m[2] }
  return { source: 'kw', id: s }
}

export async function initMusicSdk() {
  if (typeof musicSdk.init === 'function') {
    try {
      await musicSdk.init()
    } catch (e) {
      console.warn('[musicSdk] init warning:', e.message)
    }
  }
  return musicSdk
}

export { musicSdk, PLATFORMS }
