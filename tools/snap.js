'use strict'

// 开发用离屏截图：渲染真实界面并保存 PNG，不依赖系统截屏
const { app, BrowserWindow, protocol, net, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { Readable } = require('node:stream')
const { spawn } = require('node:child_process')
const { exportSegments } = require('../lib/exporter')
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
      const fps = (() => {
        const [a, b] = String(v.avg_frame_rate || '').split('/').map(Number)
        return b ? a / b : 0
      })()
      resolve({
        width: v.width,
        height: v.height,
        duration: parseFloat(j.format.duration || 0),
        fps,
        codec: v.codec_name,
        hasAudio: j.streams.some(s => s.codec_type === 'audio'),
        size: 0
      })
    })
  })
}

const videoArg = process.argv.find(a => a.startsWith('--video='))
const video = videoArg ? videoArg.slice(8) : null
const ratioArg = process.argv.find(a => a.startsWith('--ratio='))
const ratio = ratioArg ? ratioArg.slice(8) : null
const cutsArg = process.argv.find(a => a.startsWith('--cuts='))
const cuts = cutsArg ? cutsArg.slice(7).split(',').map(Number).filter(n => Number.isFinite(n)) : null
const outArg = process.argv.find(a => a.startsWith('--out='))
const outPng = outArg ? outArg.slice(6) : path.join(__dirname, 'preview.png')
const exportArg = process.argv.find(a => a.startsWith('--export='))
const exportOut = exportArg ? exportArg.slice(9) : null
const segArg = process.argv.find(a => a.startsWith('--segments='))
const segs = segArg
  ? segArg.slice(11).split(',').map(s => {
      const [a, b] = s.split('-').map(Number)
      return { start: a, end: b }
    })
  : null
const modeArg = process.argv.find(a => a.startsWith('--mode='))
const exportMode = modeArg ? modeArg.slice(7) : 'precise'
const pageArg = process.argv.find(a => a.startsWith('--page='))
const page = pageArg ? pageArg.slice(7) : 'edit.html'
const navArg = process.argv.find(a => a.startsWith('--nav='))
const vfArg = process.argv.find(a => a.startsWith('--vf='))
const vf = vfArg ? vfArg.slice(5) : null
const scaleArg = process.argv.find(a => a.startsWith('--scale='))
const scalePct = scaleArg ? scaleArg.slice(8) : null

app.whenReady().then(() => {
  protocol.handle('xcfile', async req => {
    let p = decodeURIComponent(new URL(req.url).pathname)
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
    p = path.normalize(p.replace(/\//g, '\\'))

    let stat
    try { stat = await fs.promises.stat(p) } catch { return new Response('not found', { status: 404 }) }

    const range = req.headers.get('range')
    if (!range) {
      return new Response(Readable.toWeb(fs.createReadStream(p)), {
        status: 200,
        headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes' }
      })
    }

    const m = /bytes=(\d*)-(\d*)/.exec(range)
    let start = m && m[1] ? parseInt(m[1], 10) : 0
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1
    if (!Number.isFinite(start) || start < 0) start = 0
    if (!Number.isFinite(end) || end >= stat.size) end = stat.size - 1

    return new Response(Readable.toWeb(fs.createReadStream(p, { start, end })), {
      status: 206,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes'
      }
    })
  })

  ipcMain.handle('video:probe', (_e, file) => probe(file))

  ipcMain.handle('edit:export', (_e, opts) => exportSegments(
    { ...opts, ffmpeg: 'F:\\Tools\\ffmpeg\\bin\\ffmpeg.exe' },
    p => { if (!win.isDestroyed()) win.webContents.send('export:progress', { percent: p }) }
  ))

  const win = new BrowserWindow({
    width: 1380,
    height: 900,
    backgroundColor: '#121518',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.loadFile(path.join(__dirname, '..', 'renderer', page), {
    query: video ? { video } : {}
  })

  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      if (navArg) {
        const id = navArg.slice(6)
        await win.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).click()`)
        await new Promise(r => setTimeout(r, 1400))
        console.log('NAV', await win.webContents.executeJavaScript('location.href'))
      }

      if (ratio) {
        await win.webContents.executeJavaScript(`
          (() => {
            const s = document.getElementById('ratio')
            s.value = ${JSON.stringify(ratio)}
            s.dispatchEvent(new Event('change'))
            return s.value
          })()
        `)
        await new Promise(r => setTimeout(r, 900))
      }

      try {
        const geom = await win.webContents.executeJavaScript(
          'typeof calcGeom === "function" ? JSON.stringify(calcGeom()) : "NO_CALCGEOM"'
        )
        console.log('GEOM', geom)
      } catch {}

      if (scalePct) {
        await win.webContents.executeJavaScript(`
          (() => {
            const s = document.getElementById('scalePct')
            s.value = ${JSON.stringify(scalePct)}
            s.dispatchEvent(new Event('change'))
            return s.value
          })()
        `)
        await new Promise(r => setTimeout(r, 400))
        const geom = await win.webContents.executeJavaScript(
          'typeof calcGeom === "function" ? JSON.stringify(calcGeom()) : "NO_CALCGEOM"'
        )
        console.log('GEOM_SCALED', geom)
      }

      if (cuts) {
        const diag = await win.webContents.executeJavaScript(`
          (async () => {
            const sleep = ms => new Promise(r => setTimeout(r, ms))
            const v = document.getElementById('video')
            const btn = document.getElementById('btnCutTop')
            const list = ${JSON.stringify(cuts)}
            const log = []
            for (const t of list) {
              v.currentTime = t
              await sleep(600)
              log.push({ set: t, now: v.currentTime, dur: v.duration, disabled: btn.disabled })
              btn.click()
              await sleep(300)
              log.push({ rows: document.querySelectorAll('.clip-row').length })
            }
            return JSON.stringify(log)
          })()
        `)
        console.log('CUTDIAG', diag)
        await new Promise(r => setTimeout(r, 800))
      }

      if (exportOut && segs) {
        const res = await win.webContents.executeJavaScript(
          `window.xc.exportSegments(${JSON.stringify({ input: video, output: exportOut, segments: segs, mode: exportMode, vf })})`
        )
        console.log('EXPORT', JSON.stringify(res))
        await new Promise(r => setTimeout(r, 500))
      }

      const img = await win.webContents.capturePage()
      fs.writeFileSync(outPng, img.toPNG())
      console.log('saved', outPng, img.getSize())
      app.quit()
    }, 4500)
  })
})
