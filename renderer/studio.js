'use strict'

const $ = id => document.getElementById(id)

const els = {
  preview: $('preview'),
  empty: $('empty'),
  frame: $('frame'),
  video: $('video'),
  crop: $('crop'),
  cropLabel: $('cropLabel'),
  btnOpen: $('btnOpen'),
  btnPlay: $('btnPlay'),
  btnPrev: $('btnPrev'),
  btnNext: $('btnNext'),
  btnCutTop: $('btnCutTop'),
  btnExport: $('btnExport'),
  btnSelectAll: $('btnSelectAll'),
  btnSelectNone: $('btnSelectNone'),
  ratio: $('ratio'),
  scalePct: $('scalePct'),
  outHeight: $('outHeight'),
  outSize: $('outSize'),
  mode: $('mode'),
  modeHint: $('modeHint'),
  timeline: $('timeline'),
  ruler: $('ruler'),
  track: $('track'),
  playhead: $('playhead'),
  timeNow: $('timeNow'),
  timeDur: $('timeDur'),
  playheadInfo: $('playheadInfo'),
  clipList: $('clipList'),
  clipSummary: $('clipSummary'),
  srcInfo: $('srcInfo'),
  cropInfo: $('cropInfo'),
  outInfo: $('outInfo'),
  segmentInfo: $('segmentInfo'),
  selectedInfo: $('selectedInfo'),
  modeInfo: $('modeInfo'),
  progress: $('progress'),
  progressBar: $('progressBar'),
  progressText: $('progressText'),
  toast: $('toast')
}

const MIN_PX = 24

const state = {
  file: null,
  info: null,
  cuts: [],
  selected: new Set(),
  playhead: 0,
  mode: 'lossless',
  exporting: false,
  dragging: false,

  preset: 'source',
  ratio: null,
  sel: { x: 0, y: 0, w: 1, h: 1 },
  outHeight: 1080,
  outHeightManual: false,
  drag: null
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function clamp (v, a, b) { return Math.max(a, Math.min(b, v)) }

// 向下取偶，ffmpeg 的 crop/scale 用偶数最稳
function even (n) {
  const v = Math.round(n)
  if (v <= 0) return 0
  return v - (v % 2)
}

function toXcUrl (path) {
  const parts = path.replace(/\\/g, '/').split('/')
  return 'xcfile:///' + parts.map((s, i) => {
    if (i === 0 && /^[A-Za-z]:$/.test(s)) return s
    return encodeURIComponent(s)
  }).join('/')
}

function fmtTime (sec, ms = true) {
  sec = Math.max(0, sec || 0)
  const h = Math.floor(sec / 3600)
  const m = Math.floor(sec / 60) % 60
  const s = sec % 60
  const base = (h ? String(h) + ':' : '') +
    String(m).padStart(2, '0') + ':' +
    String(Math.floor(s)).padStart(2, '0')
  if (!ms) return base
  return base + '.' + String(Math.floor((s % 1) * 100)).padStart(2, '0')
}

function fmtDur (sec) {
  sec = Math.max(0, sec)
  if (sec < 60) return sec.toFixed(2) + 's'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m + ':' + String(s.toFixed(1)).padStart(4, '0')
}

function fmtRuler (sec) {
  const h = Math.floor(sec / 3600)
  const m = Math.floor(sec / 60) % 60
  const s = Math.floor(sec) % 60
  if (h) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
  if (m) return m + ':' + String(s).padStart(2, '0')
  return s + 's'
}

function toast (msg, ok = false) {
  els.toast.textContent = msg
  els.toast.classList.toggle('ok', ok)
  els.toast.hidden = false
  clearTimeout(toast._timer)
  toast._timer = setTimeout(() => { els.toast.hidden = true }, ok ? 6000 : 8000)
}

function duration () {
  const v = els.video.duration
  if (Number.isFinite(v) && v > 0) return v
  return (state.info && state.info.duration) || 0
}

/* ------------------------------------------------------------------ */
/* 片段模型                                                            */
/* ------------------------------------------------------------------ */

function segments () {
  const dur = duration()
  if (!dur) return []
  const cuts = state.cuts.filter(t => t > 0.02 && t < dur - 0.02).sort((a, b) => a - b)
  const pts = [0, ...cuts, dur]
  const list = []
  for (let i = 0; i < pts.length - 1; i++) {
    list.push({
      index: i,
      start: pts[i],
      end: pts[i + 1],
      selected: state.selected.has(i)
    })
  }
  return list
}

function reselectAll () {
  state.selected = new Set(segments().map(s => s.index))
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function renderAll () {
  renderRuler()
  renderTimeline()
  renderList()
  renderStatus()
  updatePlayhead()
  updateTimeLabels()
  renderCrop()
}

function chooseStep (dur) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800]
  for (const s of steps) {
    if (dur / s <= 14) return s
  }
  return 3600
}

function renderRuler () {
  const dur = duration()
  els.ruler.innerHTML = ''
  if (!dur) return

  const step = chooseStep(dur)
  for (let t = 0; t <= dur + 0.0001; t += step) {
    const tick = document.createElement('div')
    tick.className = 'tick' + (t % (step * 2) === 0 ? ' major' : '')
    tick.style.left = (t / dur * 100) + '%'
    els.ruler.appendChild(tick)

    if (t / dur < 0.985) {
      const label = document.createElement('div')
      label.className = 'tick-label'
      label.style.left = (t / dur * 100) + '%'
      label.textContent = fmtRuler(t)
      els.ruler.appendChild(label)
    }
  }
}

function renderTimeline () {
  const dur = duration()
  els.track.innerHTML = ''
  if (!dur) return

  segments().forEach((seg, i) => {
    const el = document.createElement('div')
    el.className = 'clip' + (i % 2 ? ' alt' : '') + (seg.selected ? ' on' : ' no')
    el.style.left = (seg.start / dur * 100) + '%'
    el.style.width = ((seg.end - seg.start) / dur * 100) + '%'
    el.title = `片段 ${i + 1}  ${fmtTime(seg.start)} → ${fmtTime(seg.end)}`

    const no = document.createElement('span')
    no.className = 'clip-no'
    no.textContent = i + 1

    const d = document.createElement('span')
    d.className = 'clip-dur'
    d.textContent = fmtDur(seg.end - seg.start)

    el.append(no, d)
    els.track.appendChild(el)
  })

  updatePlayhead()
}

function renderList () {
  const list = segments()
  els.clipList.innerHTML = ''

  if (!list.length) {
    els.clipList.innerHTML = '<div class="clip-placeholder">还没有片段</div>'
    return
  }

  list.forEach((seg, i) => {
    const row = document.createElement('div')
    row.className = 'clip-row' + (seg.selected ? '' : ' off')

    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = seg.selected
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(i)
      else state.selected.delete(i)
      renderTimeline()
      renderStatus()
      row.classList.toggle('off', !cb.checked)
    })

    const idx = document.createElement('span')
    idx.className = 'idx'
    idx.textContent = String(i + 1).padStart(2, '0')

    const start = document.createElement('span')
    start.className = 'range'
    start.textContent = fmtTime(seg.start)

    const end = document.createElement('span')
    end.className = 'range'
    end.textContent = fmtTime(seg.end)

    const d = document.createElement('span')
    d.className = 'dur'
    d.textContent = fmtDur(seg.end - seg.start)

    const drop = document.createElement('button')
    drop.className = 'drop'
    drop.textContent = '×'
    drop.title = '删除这个切点，与相邻片段合并'
    drop.disabled = i === 0
    drop.addEventListener('click', e => {
      e.stopPropagation()
      removeCut(seg.start)
    })

    row.append(cb, idx, start, end, d, drop)

    row.addEventListener('click', e => {
      if (e.target === cb || e.target === drop) return
      seekTo(seg.start)
    })

    els.clipList.appendChild(row)
  })
}

function renderStatus () {
  const list = segments()
  const picked = list.filter(s => s.selected)
  const pickedDur = picked.reduce((a, s) => a + (s.end - s.start), 0)

  if (state.info) {
    els.srcInfo.textContent = `${state.info.width} × ${state.info.height} · ${state.info.fps ? state.info.fps.toFixed(2) + ' fps' : '—'} · ${fmtTime(duration(), false)}`
  }
  els.segmentInfo.textContent = `片段 ${list.length} 段`
  els.selectedInfo.textContent = `已选 ${picked.length} 段 · ${fmtDur(pickedDur)}`
  els.clipSummary.textContent = list.length
    ? `${list.length} 段，已选 ${picked.length} 段 · ${fmtDur(pickedDur)}`
    : ''
  els.modeInfo.textContent = state.mode === 'precise' ? '精确重编码模式' : '无损快速模式'
}

/* ------------------------------------------------------------------ */
/* 播放头                                                              */
/* ------------------------------------------------------------------ */

function updatePlayhead () {
  const dur = duration()
  if (!dur) {
    els.playhead.hidden = true
    return
  }
  els.playhead.hidden = false
  els.playhead.style.left = clamp(state.playhead / dur * 100, 0, 100) + '%'
  els.playheadInfo.textContent = fmtTime(state.playhead)
}

function updateTimeLabels () {
  els.timeNow.textContent = fmtTime(state.playhead)
  els.timeDur.textContent = fmtTime(duration())
}

function seekTo (t) {
  const dur = duration()
  if (!dur) return
  t = clamp(t, 0, dur)
  try { els.video.currentTime = t } catch {}
  state.playhead = t
  updatePlayhead()
  updateTimeLabels()
}

function seekFromEvent (e) {
  const rect = els.track.getBoundingClientRect()
  if (!rect.width) return
  const x = clamp((e.clientX - rect.left) / rect.width, 0, 1)
  seekTo(x * duration())
}

/* ------------------------------------------------------------------ */
/* 取景框                                                              */
/* ------------------------------------------------------------------ */

function layoutFrame () {
  if (!state.info) return
  const pad = 26 * 2
  const availW = Math.max(100, els.preview.clientWidth - pad)
  const availH = Math.max(100, els.preview.clientHeight - pad)
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
  let x = clamp(rectPx.x, 0, W - MIN_PX)
  let y = clamp(rectPx.y, 0, H - MIN_PX)
  let w = clamp(rectPx.w, MIN_PX, W - x)
  let h = clamp(rectPx.h, MIN_PX, H - y)

  if (ratio) {
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
    x = clamp(cx - w / 2, 0, W - w)
    y = clamp(cy - h / 2, 0, H - h)
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

// 归一化裁剪框 -> 实际裁切像素与输出尺寸
function calcGeom () {
  if (!state.info) return null
  const vw = state.info.width
  const vh = state.info.height
  const s = state.sel

  const cx = clamp(even(s.x * vw), 0, Math.max(0, vw - 2))
  const cy = clamp(even(s.y * vh), 0, Math.max(0, vh - 2))
  const cw = Math.max(2, Math.min(even(s.w * vw), vw - cx))
  const ch = Math.max(2, Math.min(even(s.h * vh), vh - cy))

  const outH = Math.max(2, even(state.outHeight) || ch)
  const outW = Math.max(2, even(cw * (outH / ch)))

  const full = cx <= 0 && cy <= 0 && cw >= vw - 1 && ch >= vh - 1
  let vf = null
  if (!(full && outH === ch)) {
    vf = `crop=${cw}:${ch}:${cx}:${cy},scale=${outW}:${outH}:flags=lanczos`
  }

  return { cx, cy, cw, ch, outW, outH, vf, full }
}

function syncScaleUI (g) {
  if (!els.scalePct || !g || !g.ch) return
  const pct = Math.round(g.outH / g.ch * 100)
  els.scalePct.value = ['100', '75', '50', '33', '25'].includes(String(pct))
    ? String(pct)
    : 'custom'
}

function renderCrop () {
  const { W, H } = frameRect()
  const s = state.sel

  els.crop.style.left = (s.x * 100) + '%'
  els.crop.style.top = (s.y * 100) + '%'
  els.crop.style.width = (s.w * 100) + '%'
  els.crop.style.height = (s.h * 100) + '%'

  if (!state.info) return

  const g = calcGeom()

  els.cropLabel.textContent = `${g.cw} × ${g.ch}`

  if (!state.outHeightManual) {
    state.outHeight = g.ch
    els.outHeight.value = String(g.ch)
  }

  syncScaleUI(g)
  els.outSize.textContent = `最终 ${g.outW} × ${g.outH}`
  els.cropInfo.textContent = `裁剪 ${g.cw} × ${g.ch}`
  els.outInfo.textContent = `输出 ${g.outW} × ${g.outH}`
}

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
/* 载入                                                                */
/* ------------------------------------------------------------------ */

async function loadVideo (file) {
  if (!file) return
  try {
    const info = await window.xc.probe(file)
    state.file = file
    state.info = info
    state.cuts = []
    state.playhead = 0
    state.selected = new Set([0])
    state.outHeightManual = false

    els.empty.hidden = true
    els.frame.hidden = false

    els.video.src = toXcUrl(file)
    els.video.load()

    els.btnPlay.disabled = false
    els.btnPrev.disabled = false
    els.btnNext.disabled = false
    els.btnCutTop.disabled = false
    els.btnExport.disabled = false
    els.btnSelectAll.disabled = false
    els.btnSelectNone.disabled = false
    els.outHeight.disabled = false

    state.preset = els.ratio.value
    state.ratio = presetRatio(state.preset)
    layoutFrame()
    fitPreset(state.preset)
    renderAll()
  } catch (err) {
    toast('无法读取这个视频：\n' + (err.message || err))
  }
}

/* ------------------------------------------------------------------ */
/* 切割                                                                */
/* ------------------------------------------------------------------ */

function cutAtPlayhead () {
  const dur = duration()
  const t = els.video.currentTime
  if (!state.info || state.exporting) return
  if (t < 0.05 || t > dur - 0.05) {
    toast('切点离首尾太近，无法切割')
    return
  }
  if (state.cuts.some(c => Math.abs(c - t) < 0.03)) {
    toast('这个位置已经切过了')
    return
  }

  state.cuts.push(t)
  state.cuts.sort((a, b) => a - b)
  reselectAll()
  renderAll()
}

function removeCut (t) {
  if (!t) return
  state.cuts = state.cuts.filter(c => Math.abs(c - t) > 0.05)
  reselectAll()
  renderAll()
}

/* ------------------------------------------------------------------ */
/* 播放                                                                */
/* ------------------------------------------------------------------ */

function togglePlay () {
  if (!state.info) return
  if (els.video.paused) els.video.play().catch(() => {})
  else els.video.pause()
}

function stepFrame (dir) {
  if (!state.info) return
  els.video.pause()
  const fps = state.info.fps || 25
  seekTo(els.video.currentTime + dir / fps)
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

function defaultOutputPath (input) {
  const dir = input.replace(/[\\/][^\\/]+$/, '')
  const name = input.replace(/^.*[\\/]/, '').replace(/\.\w+$/, '')
  return dir + '\\' + name + '_成片.mp4'
}

async function doExport () {
  if (!state.info || state.exporting) return

  const picked = segments().filter(s => s.selected)
  if (!picked.length) {
    toast('至少勾选一个片段再导出')
    return
  }

  const geom = calcGeom()
  if (!geom) return

  const output = await window.xc.chooseOutput(defaultOutputPath(state.file))
  if (!output) return

  let mode = state.mode
  let switched = false
  if (geom.vf && mode === 'lossless') {
    mode = 'precise'
    switched = true
  }

  els.video.pause()
  state.exporting = true
  els.btnExport.disabled = true
  els.btnOpen.disabled = true
  els.btnCutTop.disabled = true
  els.progress.hidden = false
  els.progressBar.style.width = '0%'
  els.progressText.textContent = '0%'

  const off = window.xc.onProgress(data => {
    const p = Number.isFinite(data.percent) ? data.percent : 0
    els.progressBar.style.width = p.toFixed(1) + '%'
    els.progressText.textContent = p.toFixed(0) + '%'
  })

  try {
    const res = await window.xc.exportSegments({
      input: state.file,
      output,
      mode,
      vf: geom.vf,
      segments: picked.map(s => ({ start: s.start, end: s.end }))
    })
    els.progressBar.style.width = '100%'
    els.progressText.textContent = '100%'
    toast(
      `导出完成：${res.count} 段 · ${geom.outW} × ${geom.outH}` +
      (switched ? '\n（含取景裁切，已自动改用精确重编码）' : '') +
      `\n${res.output}`,
      true
    )
  } catch (err) {
    toast('导出失败：\n' + (err.message || err))
  } finally {
    off()
    state.exporting = false
    els.btnExport.disabled = false
    els.btnOpen.disabled = false
    els.btnCutTop.disabled = false
    setTimeout(() => { els.progress.hidden = true }, 900)
  }
}

/* ------------------------------------------------------------------ */
/* 事件                                                                */
/* ------------------------------------------------------------------ */

els.btnOpen.addEventListener('click', async () => {
  const file = await window.xc.openVideo()
  if (file) loadVideo(file)
})

els.btnPlay.addEventListener('click', togglePlay)
els.btnPrev.addEventListener('click', () => stepFrame(-1))
els.btnNext.addEventListener('click', () => stepFrame(1))
els.btnCutTop.addEventListener('click', cutAtPlayhead)
els.btnExport.addEventListener('click', doExport)

els.btnSelectAll.addEventListener('click', () => {
  state.selected = new Set(segments().map(s => s.index))
  renderTimeline()
  renderList()
  renderStatus()
})

els.btnSelectNone.addEventListener('click', () => {
  state.selected = new Set()
  renderTimeline()
  renderList()
  renderStatus()
})

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

els.scalePct.addEventListener('change', () => {
  const v = Number(els.scalePct.value)
  if (!Number.isFinite(v)) return // 选了「自定义」，交给高度输入框决定

  const g = calcGeom()
  if (!g) return
  state.outHeightManual = true
  state.outHeight = Math.max(2, even(g.ch * v / 100))
  els.outHeight.value = String(state.outHeight)
  renderCrop()
})

els.mode.addEventListener('change', () => {
  state.mode = els.mode.value
  els.modeHint.textContent = state.mode === 'precise'
    ? '逐帧精确，需重编码，耗时较长'
    : '切点对齐关键帧，秒出片（起点可能前后偏移）'
  renderStatus()
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

els.video.addEventListener('loadedmetadata', () => {
  layoutFrame()
  renderAll()
})
els.video.addEventListener('timeupdate', () => {
  if (state.dragging) return
  state.playhead = els.video.currentTime
  updatePlayhead()
  updateTimeLabels()
})
els.video.addEventListener('play', () => { els.btnPlay.textContent = '❚❚' })
els.video.addEventListener('pause', () => { els.btnPlay.textContent = '▶' })
els.video.addEventListener('click', togglePlay)

els.timeline.addEventListener('pointerdown', e => {
  if (!state.info || state.exporting) return
  e.preventDefault()
  state.dragging = true
  seekFromEvent(e)
  try { els.timeline.setPointerCapture(e.pointerId) } catch {}
})

document.addEventListener('pointermove', e => {
  if (!state.dragging) return
  seekFromEvent(e)
})

document.addEventListener('pointerup', () => {
  if (state.dragging) {
    state.dragging = false
    state.playhead = els.video.currentTime
    updatePlayhead()
  }
})

window.addEventListener('resize', layoutFrame)

window.addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return

  if (e.code === 'Space') {
    e.preventDefault()
    togglePlay()
    return
  }

  if (!state.info) return

  if (e.key === 'c' || e.key === 'C') {
    e.preventDefault()
    cutAtPlayhead()
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    stepFrame(e.shiftKey ? -10 : -1)
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    stepFrame(e.shiftKey ? 10 : 1)
  }
})

// 拖放
els.preview.addEventListener('dragover', e => {
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
})
els.preview.addEventListener('drop', e => {
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

// 启动参数
const initialVideo = new URLSearchParams(location.search).get('video')
if (initialVideo) loadVideo(initialVideo)

els.modeHint.textContent = '切点对齐关键帧，秒出片（起点可能前后偏移）'
