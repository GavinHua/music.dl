let sendFn = async () => {}

export function setTelegramNotify(fn) {
  sendFn = typeof fn === 'function' ? fn : async () => {}
}

export function notifyTelegram(text) {
  const t = String(text || '').trim()
  if (!t) return Promise.resolve()
  const clipped = t.length > 3900 ? `${t.slice(0, 3900)}\n…` : t
  return Promise.resolve()
    .then(() => sendFn(clipped))
    .catch((e) => {
      console.warn('[tg] notify failed:', e.message || e)
    })
}
