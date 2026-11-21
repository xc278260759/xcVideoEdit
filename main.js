'use strict'

const { app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { Readable } = require('node:stream')
const { spawn } = require('node:child_process')
const { exportSegments } = require('./lib/exporter')

const FFMPEG = process.env.XC_FFMPEG || 'F:\\Tools\\ffmpeg\\bin\\ffmpeg.exe'
const FFPROBE = process.env.XC_FFPROBE || 'F:\\Tools\\ffmpeg\\bin\\ffprobe.exe'

const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'avi', 'm4v', 'webm', 'wmv', 'flv', 'mts', 'm2ts', 'ts', 'mpg', 'mpeg', '3gp']

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv', '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.3gp': 'video/3gpp'
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'xcfile',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
}])

let win = null
let activeFfmpeg = null

function mimeOf (p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream'
}

function safePathFromUrl (rawUrl) {
  let p = decodeURIComponent(new URL(rawUrl).pathname)
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
  return path.normalize(p.replace(/\//g, '\\'))
}

// 本地视频通过自定义协议提供给渲染进程，并实现 Range 以支持拖动进度
function registerVideoProtocol () {
  protocol.handle('xcfile', async (request) => {
    const filePath = safePathFromUrl(request.url)
    let stat
    try {
      stat = await fs.promises.stat(filePath)
    } catch {
      return new Response('not found', { status: 404 })
    }
    if (!stat.isFile()) return new Response('not a file', { status: 404 })

    const range = request.headers.get('range')
    if (!range) {
      return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
        status: 200,
        headers: {
          'Content-Type': mimeOf(filePath),
          'Content-Length': String(stat.size),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store'
        }
      })
    }

    const m = /bytes=(\d*)-(\d*)/.exec(range)
    let start = m && m[1] ? parseInt(m[1], 10) : 0
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1
    if (!Number.isFinite(start) || start < 0) start = 0
    if (!Number.isFinite(end) || end >= stat.size) end = stat.size - 1
    if (start > end) {
      return new Response('bad range', { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } })
    }

    return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), {
      status: 206,
      headers: {
        'Content-Type': mimeOf(filePath),
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      }
    })
  })
}

function createWindow (initialVideo) {
  win = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#121518',
    icon: path.join(__dirname, 'build', 'icon.png'),
    title: 'xcVideoEdit · 剪辑与取景',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  Menu.setApplicationMenu(null)

  const query = {}
  if (initialVideo) query.video = initialVideo
  win.loadFile(path.join(__dirname, 'renderer', 'studio.html'), { query })

  win.on('closed', () => {
    if (activeFfmpeg) {
      try { activeFfmpeg.kill() } catch {}
    }
    win = null
  })
}

function parseFps (value) {
  if (!value || value === '0/0') return 0
  const [a, b] = String(value).split('/').map(Number)
  if (!b) return Number(a) || 0
  return a / b
}

function probe (file) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFPROBE, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      file
    ], { windowsHide: true })

    let out = ''
    let err = ''
    p.stdout.on('data', d => { out += d.toString() })
    p.stderr.on('data', d => { err += d.toString() })
    p.on('error', reject)
    p.on('close', code => {
      if (code !== 0) {
        reject(new Error(err.trim() || 'ffprobe 读取视频失败'))
        return
      }
      try {
        const json = JSON.parse(out)
        const v = (json.streams || []).find(s => s.codec_type === 'video')
        if (!v) {
          reject(new Error('这个文件里没有视频流'))
          return
        }
        const duration = parseFloat((json.format && json.format.duration) || v.duration || 0) || 0
        resolve({
          width: Number(v.width),
          height: Number(v.height),
          duration,
          fps: parseFps(v.avg_frame_rate || v.r_frame_rate),
          codec: v.codec_name || '',
          sar: v.sample_aspect_ratio || '1:1',
          hasAudio: (json.streams || []).some(s => s.codec_type === 'audio'),
          size: Number((json.format && json.format.size) || 0)
        })
      } catch (e) {
        reject(new Error('解析视频信息失败: ' + e.message))
      }
    })
  })
}

function even (n) {
  const v = Math.round(Number(n) || 0)
  return Math.max(2, v - (v % 2))
}

function buildFilter (crop, srcW, srcH, outHeight) {
  let cw = even(Math.min(crop.w, srcW))
  let ch = even(Math.min(crop.h, srcH))
  cw = Math.min(cw, even(srcW))
  ch = Math.min(ch, even(srcH))

  let cx = Math.round(crop.x)
  let cy = Math.round(crop.y)
  cx = cx - (cx % 2)
  cy = cy - (cy % 2)
  cx = Math.max(0, Math.min(cx, srcW - cw))
  cy = Math.max(0, Math.min(cy, srcH - ch))

  let filter = `crop=${cw}:${ch}:${cx}:${cy}`
  const targetH = outHeight ? even(outHeight) : 0
  if (targetH && targetH !== ch) {
    filter += `,scale=-2:${targetH}`
  }
  return { filter, cw, ch, cx, cy, outH: targetH || ch }
}

function exportVideo (opts) {
  return new Promise((resolve, reject) => {
    const { input, output, crop, outHeight, duration, crf = 18, preset = 'medium' } = opts

    probe(input).then(info => {
      const calc = buildFilter(crop, info.width, info.height, outHeight)
      const args = [
        '-y',
        '-i', input,
        '-vf', calc.filter,
        '-c:v', 'libx264',
        '-crf', String(crf),
        '-preset', preset,
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        '-progress', 'pipe:1',
        '-nostats',
        output
      ]

      const proc = spawn(FFMPEG, args, { windowsHide: true })
      activeFfmpeg = proc

      let stderr = ''
      let lastUs = 0
      let lastSent = 0

      proc.stdout.on('data', chunk => {
        const lines = chunk.toString().split(/\r?\n/)
        for (const line of lines) {
          const idx = line.indexOf('=')
          if (idx < 0) continue
          const key = line.slice(0, idx)
          const val = line.slice(idx + 1).trim()
          if (key === 'out_time_us' || key === 'out_time_ms') {
            const n = parseInt(val, 10)
            if (Number.isFinite(n)) lastUs = n
          }
        }
        const now = Date.now()
        if (now - lastSent > 150 && win && !win.isDestroyed()) {
          lastSent = now
          const total = duration ? duration * 1e6 : 0
          const percent = total ? Math.min(99, Math.max(0, (lastUs / total) * 100)) : 0
          win.webContents.send('export:progress', { percent, outTime: lastUs / 1e6 })
        }
      })

      proc.stderr.on('data', chunk => {
        stderr = (stderr + chunk.toString()).slice(-6000)
      })

      proc.on('error', err => {
        activeFfmpeg = null
        reject(err)
      })

      proc.on('close', code => {
        activeFfmpeg = null
        if (code === 0) {
          if (win && !win.isDestroyed()) {
            win.webContents.send('export:progress', { percent: 100, outTime: duration })
          }
          resolve({ output, ...calc })
        } else {
          reject(new Error(extractFfmpegError(stderr) || `ffmpeg 退出码 ${code}`))
        }
      })
    }).catch(reject)
  })
}

function sendProgress (percent) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('export:progress', { percent })
  }
}

function extractFfmpegError (stderr) {
  const lines = stderr.split(/\r?\n/).filter(Boolean)
  const bad = lines.filter(l => /error|invalid|failed|unable|no such|not found/i.test(l))
  return (bad.length ? bad.slice(-6) : lines.slice(-6)).join('\n')
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      if (!win.isVisible()) win.show()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    registerVideoProtocol()

  ipcMain.handle('video:open', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择视频',
      properties: ['openFile'],
      filters: [{ name: '视频文件', extensions: VIDEO_EXT }]
    })
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })

  ipcMain.handle('video:probe', async (_e, file) => probe(file))

  ipcMain.handle('video:chooseOutput', async (_e, defaultPath) => {
    const result = await dialog.showSaveDialog(win, {
      title: '导出到',
      defaultPath,
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
    })
    if (result.canceled || !result.filePath) return null
    return result.filePath
  })

  ipcMain.handle('video:export', async (_e, opts) => exportVideo(opts))

  ipcMain.handle('edit:export', async (_e, opts) => exportSegments({ ...opts, ffmpeg: FFMPEG }, sendProgress))

  ipcMain.handle('shell:reveal', async (_e, target) => {
    shell.showItemInFolder(target)
    return true
  })

    const initial = process.argv.find(a => a.startsWith('--video='))
    createWindow(initial ? initial.slice(8) : null)
  })
}

app.on('window-all-closed', () => {
  app.quit()
})
