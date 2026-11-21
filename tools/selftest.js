'use strict'

// 交互自测：切比例、拖动整框、拖角缩放，检查比例是否保持
const { app, BrowserWindow, protocol, net, ipcMain } = require('electron')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const FFPROBE = 'F:\\Tools\\ffmpeg\\bin\\ffprobe.exe'

protocol.registerSchemesAsPrivileged([{
  scheme: 'xcfile',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
}])

function probe (file) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { windowsHide: true })
    let out = ''
    p.stdout.on('data', d => { out += d })
    p.on('close', code => {
      if (code !== 0) return reject(new Error('probe failed'))
      const j = JSON.parse(out)
      const v = j.streams.find(s => s.codec_type === 'video')
      const [a, b] = String(v.avg_frame_rate || '').split('/').map(Number)
      resolve({
        width: v.width,
        height: v.height,
        duration: parseFloat(j.format.duration || 0),
        fps: b ? a / b : 0,
        codec: v.codec_name,
        hasAudio: false,
        size: 0
      })
    })
  })
}

const video = (process.argv.find(a => a.startsWith('--video=')) || '').slice(8)

app.whenReady().then(() => {
  protocol.handle('xcfile', req => {
    let p = decodeURIComponent(new URL(req.url).pathname)
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
    return net.fetch(pathToFileURL(path.normalize(p.replace(/\//g, '\\'))).toString())
  })
  ipcMain.handle('video:probe', (_e, f) => probe(f))

  const win = new BrowserWindow({
    width: 1380,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { video } })

  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      const result = await win.webContents.executeJavaScript(String.raw`
        (async () => {
          const sleep = ms => new Promise(r => setTimeout(r, ms))
          const $ = id => document.getElementById(id)
          const frame = $('frame'), crop = $('crop')
          const rectOf = () => {
            const r = crop.getBoundingClientRect()
            const f = frame.getBoundingClientRect()
            return {
              x: (r.left - f.left) / f.width,
              y: (r.top - f.top) / f.height,
              w: r.width / f.width,
              h: r.height / f.height,
              pxW: r.width, pxH: r.height, fw: f.width, fh: f.height
            }
          }
          const ev = (type, el, x, y) => el.dispatchEvent(new PointerEvent(type, {
            clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true
          }))

          const out = {}

          // 1) 切 9:16
          const sel = $('ratio')
          sel.value = '9:16'
          sel.dispatchEvent(new Event('change'))
          await sleep(150)
          out.ratio916 = rectOf()

          // 2) 整框拖动 +80px
          const c = crop.getBoundingClientRect()
          const cx = c.left + c.width / 2
          const cy = c.top + c.height / 2
          ev('pointerdown', crop, cx, cy)
          ev('pointermove', document, cx + 80, cy)
          ev('pointerup', document, cx + 80, cy)
          await sleep(80)
          out.moved = rectOf()

          // 3) 自由模式，拖右下角缩小
          sel.value = 'free'
          sel.dispatchEvent(new Event('change'))
          await sleep(60)
          const before = rectOf()
          const se = crop.querySelector('.handle.se').getBoundingClientRect()
          const hx = se.left + se.width / 2
          const hy = se.top + se.height / 2
          ev('pointerdown', crop.querySelector('.handle.se'), hx, hy)
          ev('pointermove', document, hx - 120, hy - 80)
          ev('pointerup', document, hx - 120, hy - 80)
          await sleep(80)
          out.freeBefore = before
          out.freeAfter = rectOf()

          // 4) 9:16 下拖右边中点，检查高度按比例收缩
          sel.value = '9:16'
          sel.dispatchEvent(new Event('change'))
          await sleep(60)
          const e0 = rectOf()
          const eh = crop.querySelector('.handle.e').getBoundingClientRect()
          const ex = eh.left + eh.width / 2
          const ey = eh.top + eh.height / 2
          ev('pointerdown', crop.querySelector('.handle.e'), ex, ey)
          ev('pointermove', document, ex - 90, ey)
          ev('pointerup', document, ex - 90, ey)
          await sleep(80)
          out.edgeBefore = e0
          out.edgeAfter = rectOf()

          return JSON.stringify(out)
        })()
      `)

      console.log('SELFTEST', result)
      app.quit()
    }, 4000)
  })
})
