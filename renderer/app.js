'use strict'

const $ = id => document.getElementById(id)

const els = {
  stage: $('stage'),
  empty: $('empty'),
  frame: $('frame'),
  video: $('video'),
  crop: $('crop'),
  cropLabel: $('cropLabel'),
  btnOpen: $('btnOpen'),
  btnPlay: $('btnPlay'),
  btnExport: $('btnExport'),
  ratio: $('ratio'),
  outHeight: $('outHeight'),
  outSize: $('outSize'),
  srcInfo: $('srcInfo'),
  cropInfo: $('cropInfo'),
  outInfo: $('outInfo'),
  timeInfo: $('timeInfo'),
  progress: $('progress'),
  progressBar: $('progressBar'),
  progressText: $('progressText'),
  toast: $('toast')
}

const MIN_PX = 24

const state = {
  file: null,
  info: null,
  preset: 'source',
  ratio: null,
  sel: { x: 0, y: 0, w: 1, h: 1 }, // 归一化，相对画面
  outHeight: 1080,
  outHeightManual: false,
  playing: false,
  exporting: false,
  drag: null
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                             */
/* ------------------------------------------------------------------ */

function clamp (v, min, max) { return Math.max(min, Math.min(max, v)) }

function even (n) { const v = Math.round(n); return Math.max(2, v - (v % 2)) }

function toXcUrl (path) {
  const parts = path.replace(/\\/g, '/').split('/')
  return 'xcfile:///' + parts.map((s, i) => {
    if (i === 0 && /^[A-Za-z]:$/.test(s)) return s
    return encodeURIComponent(s)
  }).join('/')
}

function fmtTime (sec) {
  sec = Math.max(0, Math.floor(sec || 0))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
}

function toast (msg, ok = false) {
  els.toast.textContent = msg
  els.toast.classList.toggle('ok', ok)
  els.toast.hidden = false
  clearTimeout(toast._timer)
  toast._timer = setTimeout(() => { els.toast.hidden = true }, ok ? 5000 : 8000)
}

/* ------------------------------------------------------------------ */
/* 画面布局                                                            */
/* ------------------------------------------------------------------ */

function layoutFrame () {
  if (!state.info) return
  const pad = 26 * 2
  const availW = Math.max(100, els.stage.clientWidth - pad)
  const availH = Math.max(100, els.stage.clientHeight - pad)
  const vw = state.info.width
  const vh = state.info.height
  const scale = Math.min(availW / vw, availH / vh)

  const w = Math.max(80, Math.floor(vw * scale))
  const h = Math.max(60, Math.floor(vh * scale))

  els.frame.style.width = w + 'px'
  els.frame.style.height = h + 'px'
  renderCrop()
}

function frameRect () {
  return { W: els.frame.clientWidth || 1, H: els.frame.clientHeight || 1 }
}

/* ------------------------------------------------------------------ */
/* 裁剪框选择与渲染                                                     */
/* ------------------------------------------------------------------ */

function selToPx (sel, W, H) {
  return { x: sel.x * W, y: sel.y * H, w: sel.w * W, h: sel.h * H }
}

function pxToSel (r, W, H) {
  return { x: r.x / W, y: r.y / H, w: r.w / W, h: r.h / H }
}

function presetRatio (key) {
  if (key === 'free') return null
  if (key === 'source') return state.info ? state.info.width / state.info.height : null
  const parts = key.split(':').map(Number)
  return parts[1] ? parts[0] / parts[1] : null
}

function setSelection (rectPx, ratio, W, H) {
  // 保证在画面内
  let x = clamp(rectPx.x, 0, W - MIN_PX)
  let y = clamp(rectPx.y, 0, H - MIN_PX)
  let w = clamp(rectPx.w, MIN_PX, W - x)
  let h = clamp(rectPx.h, MIN_PX, H - y)

  if (ratio) {
    // 以中心为锚点，按比例收进画面
    const cx = x + w / 2
    const cy = y + h / 2
    if (w / h > ratio) w = h * ratio
    else h = w / ratio
    const maxW = 2 * Math.min(cx, W - cx)
    const maxH = 2 * Math.min(cy, H - cy)
    if (w > maxW) { w = maxW; h = w / ratio }
    if (h > maxH) { h = maxH; w = h * ratio }
    w = Math.max(MIN_PX, w)
    h = Math.max(MIN_PX, h)
    x = cx - w / 2
    y = cy - h / 2
    x = clamp(x, 0, W - w)
    y = clamp(y, 0, H - h)
  }

  state.sel = pxToSel({ x, y, w, h }, W, H)
  renderCrop()
}

function fitPreset (key) {
  const W = frameRect().W
  const H = frameRect().H
  const ratio = presetRatio(key)

  if (key === 'source' || !ratio) {
    state.sel = { x: 0, y: 0, w: 1, h: 1 }
    renderCrop()
    return
  }

  let w = W
  let h = w / ratio
  if (h > H) { h = H; w = h * ratio }
  setSelection({ x: (W - w) / 2, y: (H - h) / 2, w, h }, ratio, W, H)
}

function renderCrop () {
  const { W, H } = frameRect()
  const s = state.sel

  els.crop.style.left = (s.x * 100) + '%'
  els.crop.style.top = (s.y * 100) + '%'
  els.crop.style.width = (s.w * 100) + '%'
  els.crop.style.height = (s.h * 100) + '%'

  if (!state.info) return

  const cw = Math.max(2, even(s.w * state.info.width))
  const ch = Math.max(2, even(s.h * state.info.height))

  els.cropLabel.textContent = `${cw} × ${ch}`

  if (!state.outHeightManual) {
    state.outHeight = ch
    els.outHeight.value = String(ch)
  }

  const outH = even(state.outHeight)
  const outW = Math.max(2, even(cw * (outH / ch)))

  els.outSize.textContent = `输出 ${outW} × ${outH}`
  els.cropInfo.textContent = `裁剪 ${cw} × ${ch}`
  els.outInfo.textContent = `输出 ${outW} × ${outH}`
}

/* ------------------------------------------------------------------ */
/* 载入视频                                                            */
/* ------------------------------------------------------------------ */

async function loadVideo (file) {
  if (!file) return
  try {
    const info = await window.xc.probe(file)
    state.file = file
    state.info = info
    state.outHeightManual = false

    els.empty.hidden = true
    els.frame.hidden = false

    els.video.src = toXcUrl(file)
    els.video.load()

    els.btnPlay.disabled = false
    els.btnExport.disabled = false
    els.outHeight.disabled = false

    els.srcInfo.textContent = `${info.width} × ${info.height} · ${info.fps ? info.fps.toFixed(2) + ' fps' : '—'} · ${fmtTime(info.duration)}`

    layoutFrame()
    state.preset = els.ratio.value
    state.ratio = presetRatio(state.preset)
    fitPreset(state.preset)
    renderCrop()
    updateTime()
  } catch (err) {
    toast('无法读取这个视频：\n' + (err.message || err))
  }
}

/* ------------------------------------------------------------------ */
/* 拖拽裁剪                                                             */
/* ------------------------------------------------------------------ */

function beginDrag (e, mode, dir) {
  if (!state.info || state.exporting) return
  e.preventDefault()
  e.stopPropagation()

  const { W, H } = frameRect()
  state.drag = {
    mode,
    dir,
    startX: e.clientX,
    startY: e.clientY,
    start: selToPx(state.sel, W, H),
    W,
    H
  }
  els.crop.classList.add('active')
  try { els.crop.setPointerCapture?.(e.pointerId) } catch {}
}

function onPointerMove (e) {
  const d = state.drag
  if (!d) return

  const dx = e.clientX - d.startX
  const dy = e.clientY - d.startY
  const W = d.W
  const H = d.H
  const ratio = state.ratio

  if (d.mode === 'move') {
    const x = clamp(d.start.x + dx, 0, W - d.start.w)
    const y = clamp(d.start.y + dy, 0, H - d.start.h)
    state.sel = pxToSel({ x, y, w: d.start.w, h: d.start.h }, W, H)
    renderCrop()
    return
  }

  const r = resizeRect(d.start, d.dir, dx, dy, ratio, W, H)
  state.sel = pxToSel(r, W, H)
  renderCrop()
}

function resizeRect (start, dir, dx, dy, ratio, W, H) {
  const { x, y, w, h } = start
  let l = x
  let t = y
  let r = x + w
  let b = y + h

  if (dir.includes('w')) l = x + dx
  if (dir.includes('e')) r = x + w + dx
  if (dir.includes('n')) t = y + dy
  if (dir.includes('s')) b = y + h + dy

  l = clamp(l, 0, W - MIN_PX)
  t = clamp(t, 0, H - MIN_PX)
  r = clamp(r, l + MIN_PX, W)
  b = clamp(b, t + MIN_PX, H)

  if (!ratio) {
    return { x: l, y: t, w: r - l, h: b - t }
  }

  const isCorner = dir.length === 2

  if (isCorner) {
    const anchorX = dir.includes('w') ? x + w : x
    const anchorY = dir.includes('n') ? y + h : y

    let wpx = Math.abs((dir.includes('w') ? l : r) - anchorX)
    let hpx = Math.abs((dir.includes('n') ? t : b) - anchorY)

    // 取满足比例的较小尺寸，避免框跳得比鼠标还大
    if (wpx / hpx > ratio) wpx = hpx * ratio
    else hpx = wpx / ratio

    const maxW = dir.includes('w') ? anchorX : W - anchorX
    const maxH = dir.includes('n') ? anchorY : H - anchorY

    if (wpx > maxW) { wpx = maxW; hpx = wpx / ratio }
    if (hpx > maxH) { hpx = maxH; wpx = hpx * ratio }
    if (wpx < MIN_PX) { wpx = MIN_PX; hpx = wpx / ratio }
    if (hpx < MIN_PX) { hpx = MIN_PX; wpx = hpx * ratio }
    if (wpx > maxW) { wpx = maxW; hpx = wpx / ratio }
    if (hpx > maxH) { hpx = maxH; wpx = hpx * ratio }

    return {
      x: dir.includes('w') ? anchorX - wpx : anchorX,
      y: dir.includes('n') ? anchorY - hpx : anchorY,
      w: wpx,
      h: hpx
    }
  }

  // 边：另一维以原中心对称扩展
  const cx = x + w / 2
  const cy = y + h / 2

  if (dir === 'e' || dir === 'w') {
    let wpx = dir === 'e' ? r - x : x + w - l
    wpx = Math.max(MIN_PX, wpx)
    let hpx = wpx / ratio
    const maxH = 2 * Math.min(cy, H - cy)
    if (hpx > maxH) { hpx = maxH; wpx = hpx * ratio }
    const maxW = dir === 'e' ? W - x : x + w
    if (wpx > maxW) { wpx = maxW; hpx = wpx / ratio }
    const nx = dir === 'e' ? x : x + w - wpx
    const ny = clamp(cy - hpx / 2, 0, H - hpx)
    return { x: nx, y: ny, w: wpx, h: hpx }
  }

  let hpx = dir === 's' ? b - y : y + h - t
  hpx = Math.max(MIN_PX, hpx)
  let wpx = hpx * ratio
  const maxW = 2 * Math.min(cx, W - cx)
  if (wpx > maxW) { wpx = maxW; hpx = wpx / ratio }
  const maxH = dir === 's' ? H - y : y + h
  if (hpx > maxH) { hpx = maxH; wpx = hpx * ratio }
  const ny = dir === 's' ? y : y + h - hpx
  const nx = clamp(cx - wpx / 2, 0, W - wpx)
  return { x: nx, y: ny, w: wpx, h: hpx }
}

function endDrag (e) {
  if (!state.drag) return
  state.drag = null
  els.crop.classList.remove('active')
  try { els.crop.releasePointerCapture?.(e.pointerId) } catch {}
  renderCrop()
}

/* ------------------------------------------------------------------ */
/* 播放与时间                                                           */
/* ------------------------------------------------------------------ */

function togglePlay () {
  if (!state.info) return
  if (els.video.paused) els.video.play().catch(() => {})
  else els.video.pause()
}

function updatePlayState () {
  const paused = els.video.paused
  els.btnPlay.textContent = paused ? '▶' : '❚❚'
}

function updateTime () {
  const cur = els.video.currentTime || 0
  const dur = state.info ? state.info.duration : 0
  els.timeInfo.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

function defaultOutputPath (input) {
  const dir = input.replace(/[\\/][^\\/]+$/, '')
  const name = input.replace(/^.*[\\/]/, '').replace(/\.\w+$/, '')
  return dir + '\\' + name + '_裁剪.mp4'
}

async function doExport () {
  if (!state.info || state.exporting) return
  if (els.video.paused === false) els.video.pause()

  const vw = state.info.width
  const vh = state.info.height
  const s = state.sel
  const crop = {
    x: Math.round(s.x * vw),
    y: Math.round(s.y * vh),
    w: Math.round(s.w * vw),
    h: Math.round(s.h * vh)
  }

  const output = await window.xc.chooseOutput(defaultOutputPath(state.file))
  if (!output) return

  state.exporting = true
  els.btnExport.disabled = true
  els.btnOpen.disabled = true
  els.progress.hidden = false
  els.progressBar.style.width = '0%'
  els.progressText.textContent = '0%'

  const off = window.xc.onProgress(data => {
    els.progressBar.style.width = data.percent.toFixed(1) + '%'
    els.progressText.textContent = data.percent.toFixed(0) + '%'
  })

  try {
    const res = await window.xc.exportVideo({
      input: state.file,
      output,
      crop,
      outHeight: even(state.outHeight),
      duration: state.info.duration
    })
    els.progressBar.style.width = '100%'
    els.progressText.textContent = '100%'
    toast('导出完成：\n' + res.output + `\n${res.outH ? '高度 ' + res.outH : ''}`, true)
  } catch (err) {
    toast('导出失败：\n' + (err.message || err))
  } finally {
    off()
    state.exporting = false
    els.btnExport.disabled = false
    els.btnOpen.disabled = false
    setTimeout(() => { els.progress.hidden = true }, 900)
  }
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

els.btnOpen.addEventListener('click', async () => {
  const file = await window.xc.openVideo()
  if (file) loadVideo(file)
})

els.btnPlay.addEventListener('click', togglePlay)
els.video.addEventListener('click', togglePlay)
els.video.addEventListener('play', updatePlayState)
els.video.addEventListener('pause', updatePlayState)
els.video.addEventListener('timeupdate', updateTime)
els.video.addEventListener('loadedmetadata', layoutFrame)

els.ratio.addEventListener('change', () => {
  state.preset = els.ratio.value
  state.ratio = presetRatio(state.preset)
  fitPreset(state.preset)
})

els.outHeight.addEventListener('input', () => {
  const v = parseInt(els.outHeight.value, 10)
  if (Number.isFinite(v) && v >= 2) {
    state.outHeightManual = true
    state.outHeight = v
    renderCrop()
  }
})

els.crop.addEventListener('pointerdown', e => {
  const handle = e.target.closest('.handle')
  if (handle) beginDrag(e, 'resize', handle.dataset.dir)
  else beginDrag(e, 'move', null)
})
els.crop.addEventListener('dblclick', () => {
  els.ratio.value = 'source'
  state.preset = 'source'
  state.ratio = presetRatio('source')
  fitPreset('source')
})

document.addEventListener('pointermove', onPointerMove)
document.addEventListener('pointerup', endDrag)
document.addEventListener('pointercancel', endDrag)

window.addEventListener('resize', layoutFrame)

// 键盘
window.addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return

  if (e.code === 'Space') {
    e.preventDefault()
    togglePlay()
    return
  }

  if (!state.info) return

  const step = e.shiftKey ? 10 : 1
  const { W, H } = frameRect()
  const s = selToPx(state.sel, W, H)
  let handled = true

  if (e.key === 'ArrowLeft') s.x -= step
  else if (e.key === 'ArrowRight') s.x += step
  else if (e.key === 'ArrowUp') s.y -= step
  else if (e.key === 'ArrowDown') s.y += step
  else handled = false

  if (handled) {
    e.preventDefault()
    s.x = clamp(s.x, 0, W - s.w)
    s.y = clamp(s.y, 0, H - s.h)
    state.sel = pxToSel(s, W, H)
    renderCrop()
  }
})

// 拖放
els.stage.addEventListener('dragover', e => {
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
})
els.stage.addEventListener('drop', e => {
  e.preventDefault()
  const file = e.dataTransfer.files && e.dataTransfer.files[0]
  if (!file) return
  let path = ''
  try {
    path = window.xc.getPathForFile ? window.xc.getPathForFile(file) : (file.path || '')
  } catch {
    path = file.path || ''
  }
  if (path) loadVideo(path)
  else toast('没能获取拖入文件的路径，请用「打开视频」按钮。')
})

// 启动参数里的视频
// 切到片段剪辑页
const tabEdit = document.getElementById('tabEdit')
if (tabEdit) {
  tabEdit.addEventListener('click', () => {
    const q = state.file ? '?video=' + encodeURIComponent(state.file) : ''
    location.href = 'edit.html' + q
  })
}

const initialVideo = new URLSearchParams(location.search).get('video')
if (initialVideo) loadVideo(initialVideo)
