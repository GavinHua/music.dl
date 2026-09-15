// Stub: musicSdk platform getMusicUrl goes through custom sources.
// Our download service calls userApi directly; this keeps musicSdk imports working.

const supportQuality = {}

const apis = (source) => {
  throw new Error(`未找到支持 ${source} 平台的自定义源，请先在源管理中启用音源`)
}

export { apis, supportQuality }
