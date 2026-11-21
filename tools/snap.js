'use strict'

// 开发用离屏截图：渲染真实界面并保存 PNG，不依赖系统截屏
const { app, BrowserWindow, protocol, net, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { Readable } = require('node:stream')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const { exportSegments } = require('../lib/exporter')
const { safePathFromUrl } = require('../lib/localpath')
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
      const v = j.streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic)
      const a = j.streams.find(s => s.codec_type === 'audio')
      const fps = (() => {
        if (!v) return 0
        const [x, y] = String(v.avg_frame_rate || '').split('/').map(Number)
        return y ? x / y : 0
      })()
      resolve({
        isAudio: !v,
        width: v ? v.width : 0,
        height: v ? v.height : 0,
        duration: parseFloat(j.format.duration || 0),
        fps,
        codec: (v || a || {}).codec_name || '',
        hasAudio: !!a,
        audio: a ? { codec: a.codec_name, sampleRate: Number(a.sample_rate), channels: Number(a.channels) } : null,
        size: 0
      })
    })
  })
}

const MIME = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg'
}

function mimeOf (p) {
  return MIME[path.extname(p).toLowerCase()] || 'video/mp4'
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
const selTest = process.argv.includes('--seltest')
const audioTest = process.argv.includes('--audiotest')
const historyTest = process.argv.includes('--historytest')
const thumbTest = process.argv.includes('--thumbtest')
const projTest = process.argv.includes('--projtest')
const zoomTest = process.argv.includes('--zoomtest')
const seqTest = process.argv.includes('--seqtest')
const seqExportArg = process.argv.find(a => a.startsWith('--seqexport='))
const seqExport = seqExportArg ? seqExportArg.slice(12) : null
const keepZoom = process.argv.includes('--keepzoom')

app.whenReady().then(() => {
  protocol.handle('xcfile', async req => {
    const p = safePathFromUrl(req.url)
    if (process.env.XC_DEBUG) {
      console.log('[xcfile]', JSON.stringify(req.url), '=>', JSON.stringify(p), 'exists=', fs.existsSync(p))
    }

    let stat
    try { stat = await fs.promises.stat(p) } catch { return new Response('not found', { status: 404 }) }

    const range = req.headers.get('range')
    if (!range) {
      return new Response(Readable.toWeb(fs.createReadStream(p)), {
        status: 200,
        headers: { 'Content-Type': mimeOf(p), 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' }
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
        'Content-Type': mimeOf(p),
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*'
      }
    })
  })

  ipcMain.handle('video:probe', (_e, file) => probe(file))

  ipcMain.handle('audio:read', async (_e, file) => {
    const buf = await fs.promises.readFile(file)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  })

  ipcMain.handle('video:thumbs', async (_e, file) => {
    const st = await fs.promises.stat(file)
    const key = crypto.createHash('md5').update(`${file}|${st.size}|${st.mtimeMs}|v2|320|16`).digest('hex').slice(0, 16)
    const dir = path.join(app.getPath('userData'), 'thumb-cache', key)
    const readJpgs = async () => (await fs.promises.readdir(dir).catch(() => [])).filter(f => f.endsWith('.jpg')).sort()
    const cached = await readJpgs()
    if (cached.length >= 16) return { dir, count: cached.length, files: cached }
    const info = await probe(file).catch(() => null)
    const dur = (info && info.duration) || 0
    if (!dur) throw new Error('no duration')
    fs.mkdirSync(dir, { recursive: true })
    await new Promise((resolve, reject) => {
      const p = spawn('F:\\Tools\\ffmpeg\\bin\\ffmpeg.exe', [
        '-y', '-v', 'error', '-i', file,
        '-vf', `fps=${(16 / dur).toFixed(6)},scale=320:-2`,
        '-frames:v', '16', '-q:v', '4',
        path.join(dir, 'thumb_%03d.jpg')
      ], { windowsHide: true })
      let err = ''
      p.stderr.on('data', d => { err += d })
      p.on('error', reject)
      p.on('close', c => c === 0 ? resolve() : reject(new Error(err.trim() || 'thumb failed')))
    })
    const files = await readJpgs()
    return { dir, count: files.length, files }
  })

  ipcMain.handle('project:write', async (_e, file, data) => {
    await fs.promises.writeFile(file, JSON.stringify(data, null, 2), 'utf8')
    return file
  })

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

      try {
        const muted = await win.webContents.executeJavaScript(
          '(() => { const v = document.getElementById("video"); return v ? v.muted : "NO_VIDEO" })()'
        )
        console.log('MUTED', muted)
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

      if (selTest) {
        const res = await win.webContents.executeJavaScript(`
          (async () => {
            const sleep = ms => new Promise(r => setTimeout(r, ms))
            const count = () => document.querySelectorAll('.clip.on').length
            document.getElementById('btnSelectAll').click()
            await sleep(120)
            const before = count()
            const fire = (el, opts) => {
              el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, bubbles: true, cancelable: true }))
              el.dispatchEvent(new MouseEvent('click', { ...opts, bubbles: true, cancelable: true }))
            }
            const clips = [...document.querySelectorAll('.clip')]
            fire(clips[1], { altKey: true })
            await sleep(150)
            const afterAlt = count()
            const clips2 = [...document.querySelectorAll('.clip')]
            fire(clips2[2], { shiftKey: true })
            await sleep(150)
            const afterShift = count()
            const checked = document.querySelectorAll('.clip-row input:checked').length
            return JSON.stringify({ total: clips.length, before, afterAlt, afterShift, checked })
          })()
        `)
        console.log('SELTEST', res)
        await new Promise(r => setTimeout(r, 200))
      }

      if (audioTest) {
        const res = await win.webContents.executeJavaScript(`
          JSON.stringify({
            isAudio: state.isAudio,
            wavePoints: (typeof waveData !== 'undefined' && waveData) ? waveData.length : 0,
            waveOpacity: document.getElementById('wave').style.opacity,
            audioStageHidden: document.getElementById('audioStage').hidden,
            cropHidden: document.getElementById('crop').hidden,
            bodyClass: document.body.className,
            srcInfo: document.getElementById('srcInfo').textContent,
            meta: document.getElementById('audioMeta').textContent,
            waveInfo: document.getElementById('audioWaveInfo').textContent,
            hint: document.getElementById('modeHint').textContent,
            waveSize: (() => { const c = document.getElementById('wave'); return c.width + 'x' + c.height })()
          })
        `)
        console.log('AUDIOTEST', res)
        await new Promise(r => setTimeout(r, 300))
      }

      if (historyTest) {
        const res = await win.webContents.executeJavaScript(`
          (async () => {
            const sleep = ms => new Promise(r => setTimeout(r, ms))
            const v = document.getElementById('video')
            const btn = document.getElementById('btnCutTop')
            v.currentTime = 1
            await sleep(500)
            btn.click()
            v.currentTime = 2
            await sleep(500)
            btn.click()
            await sleep(300)
            const before = state.segs.length
            undo()
            await sleep(200)
            const afterUndo = state.segs.length
            const undoDisabled = document.getElementById('btnUndo').disabled
            redo()
            await sleep(200)
            const afterRedo = state.segs.length
            const redoDisabled = document.getElementById('btnRedo').disabled
            return JSON.stringify({ before, afterUndo, afterRedo, undoDisabled, redoDisabled })
          })()
        `)
        console.log('HISTORYTEST', res)
        await new Promise(r => setTimeout(r, 300))
      }

      if (thumbTest) {
        const res = await win.webContents.executeJavaScript(`
          (async () => {
            const sleep = ms => new Promise(r => setTimeout(r, ms))
            for (let i = 0; i < 48; i++) {
              if (document.querySelectorAll('#thumbs img').length) break
              await sleep(250)
            }
            await sleep(600)
            const imgs = [...document.querySelectorAll('#thumbs img')]
            const box = document.getElementById('thumbs')
            return JSON.stringify({
              count: imgs.length,
              loaded: imgs.filter(i => i.naturalWidth > 0).length,
              bandH: box.clientHeight,
              timelineH: document.getElementById('timeline').clientHeight,
              firstSrc: imgs[0] ? imgs[0].src.slice(-30) : null
            })
          })()
        `)
        console.log('THUMBTEST', res)
      }

      if (seqTest) {
        const res = await win.webContents.executeJavaScript(`
          (async () => {
            const sleep = ms => new Promise(r => setTimeout(r, ms))
            const snap = () => state.segs.map(s => [+s.start.toFixed(2), +s.end.toFixed(2)])
            const before = snap()
            moveSegment(2, 0)
            await sleep(150)
            const reordered = snap()
            const rows = [...document.querySelectorAll('.clip-row')].map(el => ({
              idx: el.querySelector('.idx').textContent,
              start: el.querySelectorAll('.range')[0].textContent,
              end: el.querySelectorAll('.range')[1].textContent,
              dur: el.querySelector('.dur').textContent
            }))
            const first = document.querySelectorAll('.clip')[1]
            const edge = first.querySelector('.clip-edge.r')
            const r = edge.getBoundingClientRect()
            const cx = r.left + 3
            edge.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: cx, clientY: r.top + 10, pointerId: 1, button: 0 }))
            document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cx + 60, clientY: r.top + 10, pointerId: 1 }))
            await sleep(80)
            const dragging = snap()
            const snapLineVisible = !document.getElementById('snapLine').hidden
            document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: cx + 60, clientY: r.top + 10, pointerId: 1 }))
            await sleep(120)
            const afterEdge = snap()
            undo(); await sleep(120)
            const undone = snap()
            redo(); await sleep(120)
            const redone = snap()
            return JSON.stringify({
              before, reordered, rows, dragging, snapLineVisible,
              afterEdge, undone, redone,
              undoDisabled: document.getElementById('btnUndo').disabled
            })
          })()
        `)
        console.log('SEQT', res)
        await new Promise(r => setTimeout(r, 300))
      }

      if (projTest) {
        const projPath = path.join(__dirname, 'test_project.xcproj')
        const beforeRaw = await win.webContents.executeJavaScript(`
          (async () => {
            const sleep = ms => new Promise(r => setTimeout(r, ms))
            moveSegment(2, 0)
            await sleep(120)
            const p = collectProject()
            await window.xc.writeProject(${JSON.stringify(projPath)}, p)
            state.segs = [{ start: 0, end: video.duration || 0 }]
            state.selected = new Set([0])
            state.sel = { x: 0, y: 0, w: 1, h: 1 }
            state.outHeightManual = false
            renderAll()
            renderCrop()
            return JSON.stringify(p)
          })()
        `)
        const data = JSON.parse(fs.readFileSync(projPath, 'utf8'))
        const afterRaw = await win.webContents.executeJavaScript(`
          (() => {
            applyProject(${JSON.stringify(data)})
            return JSON.stringify({
              segs: state.segs.map(s => [+s.start.toFixed(2), +s.end.toFixed(2)]),
              selected: state.selected.size,
              sel: state.sel,
              preset: state.preset,
              outHeight: state.outHeight,
              mode: state.mode,
              undoDisabled: document.getElementById('btnUndo').disabled
            })
          })()
        `)
        console.log('PROJTEST', JSON.stringify({
          saved: JSON.parse(beforeRaw),
          restored: JSON.parse(afterRaw)
        }))
        await new Promise(r => setTimeout(r, 300))
      }

      if (zoomTest) {
        const res = await win.webContents.executeJavaScript(`
          (async () => {
            const sleep = ms => new Promise(r => setTimeout(r, ms))
            const tl = document.getElementById('timeline')
            const track = document.getElementById('track')
            const rect = track.getBoundingClientRect()
            const fire = (deltaY, mods) => tl.dispatchEvent(new WheelEvent('wheel', {
              deltaY,
              bubbles: true,
              cancelable: true,
              clientX: rect.left + rect.width * 0.5,
              ...mods
            }))
            const state0 = { span: +viewSpan().toFixed(3), start: +viewStart().toFixed(3) }
            fire(-100, { shiftKey: true })
            await sleep(60)
            const z1 = { span: +viewSpan().toFixed(3), start: +viewStart().toFixed(3) }
            fire(-100, { shiftKey: true })
            await sleep(60)
            const z2 = { span: +viewSpan().toFixed(3), start: +viewStart().toFixed(3) }
            fire(120, { altKey: true })
            await sleep(60)
            const p1 = { span: +viewSpan().toFixed(3), start: +viewStart().toFixed(3) }
            const infoText = document.getElementById('viewInfo').textContent
            const ticks = document.querySelectorAll('#ruler .tick').length
            const labels = [...document.querySelectorAll('#ruler .tick-label')].map(e => e.textContent)
            const thumbs = document.querySelectorAll('#thumbs .thumb').length
            const clips = [...document.querySelectorAll('.clip')].map(c => ({ left: c.style.left, width: c.style.width }))
            const btn = document.getElementById('btnFitAll')
            const zoomedBtn = { disabled: btn.disabled, text: btn.textContent }
            if (!${keepZoom}) {
              btn.click()
              await sleep(80)
            }
            const fitted = {
              span: +viewSpan().toFixed(3),
              start: +viewStart().toFixed(3),
              disabled: btn.disabled,
              text: btn.textContent,
              infoText: document.getElementById('viewInfo').textContent
            }
            return JSON.stringify({ state0, z1, z2, p1, infoText, ticks, labels, thumbs, clips, zoomedBtn, fitted })
          })()
        `)
        console.log('ZOOMTEST', res)
        await new Promise(r => setTimeout(r, 300))
      }

      if (seqExport && video) {
        const res = await win.webContents.executeJavaScript(`
          (async () => {
            const picked = segments().filter(s => s.selected)
            const r = await window.xc.exportSegments({
              input: ${JSON.stringify(video)},
              output: ${JSON.stringify(seqExport)},
              mode: 'precise',
              vf: null,
              audio: false,
              segments: picked.map(s => ({ start: s.start, end: s.end }))
            })
            return JSON.stringify({ segs: picked.map(s => [s.start, s.end]), result: r })
          })()
        `)
        console.log('SEQEXPORT', res)
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
