'use strict'

const path = require('node:path')
const fs = require('node:fs')

// xcfile:// URL -> Windows 绝对路径
// Chromium 对自定义协议的处理在不同版本/路径字符下不一致，
// 含中文、空格、% 的文件名可能被多转义一层，这里逐级解码并按磁盘存在性选路
function normalizeFsPath (p) {
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
  return path.normalize(p.replace(/\//g, '\\'))
}

function safePathFromUrl (rawUrl) {
  const u = new URL(rawUrl)
  let raw = u.pathname
  // Chromium 对非 standard scheme 会把盘符当成 host：
  // xcfile:///D:/Downloads/... 实际传进来是 xcfile://d/Downloads/...
  if (u.host && /^[a-z]$/i.test(u.host)) {
    raw = '/' + u.host.toUpperCase() + ':' + raw
  }
  const candidates = []
  let cur = raw
  for (let i = 0; i < 3; i++) {
    candidates.push(cur)
    try {
      const next = decodeURIComponent(cur)
      if (next === cur) break
      cur = next
    } catch {
      break
    }
  }
  for (const c of candidates) {
    const p = normalizeFsPath(c)
    try {
      if (fs.existsSync(p)) return p
    } catch {}
  }
  return normalizeFsPath(candidates[candidates.length - 1])
}

module.exports = { safePathFromUrl, normalizeFsPath }
