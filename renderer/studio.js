'use strict'

const $ = id => document.getElementById(id)

const els = {
  preview: $('preview'),
  empty: $('empty'),
  frame: $('frame'),
  video: $('video'),
  crop: $('crop'),
  cropLabel: $('cropLabel'),
  audioStage: $('audioStage'),
  audioName: $('audioName'),
  audioMeta: $('audioMeta'),
  audioWaveInfo: $('audioWaveInfo'),
  audioNow: $('audioNow'),
  audioCursor: $('audioCursor'),
  wave: $('wave'),
  btnOpen: $('btnOpen'),
  btnOpenProj: $('btnOpenProj'),
  btnSaveProj: $('btnSaveProj'),
  btnUndo: $('btnUndo'),
  btnRedo: $('btnRedo'),
  btnPlay: $('btnPlay'),
  btnPrev: $('btnPrev'),
  btnNext: $('btnNext'),
  btnMute: $('btnMute'),
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
  thumbs: $('thumbs'),
  ruler: $('ruler'),
  track: $('track'),
  playhead: $('playhead'),
  viewInfo: $('viewInfo'),
  btnFitAll: $('btnFitAll'),
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
  muted: true,
  isAudio: false,
  projectPath: null,

  preset: 'source',
  ratio: null,
  sel: { x: 0, y: 0, w: 1, h: 1 },
  outHeight: 1080,
  outHeightManual: false,
  outHeightDirty: false,
  view: { start: 0, span: 0 },
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
  if (Math.abs(sec - Math.round(sec)) > 0.001) return sec.toFixed(1) + 's'
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
/* 时间轴视窗：缩放与平移                                              */
/* ------------------------------------------------------------------ */

function viewSpan () {
  const dur = duration()
  const span = state.view.span
  return span > 0 ? Math.min(span, dur) : dur
}

function viewStart () {
  const dur = duration()
  return clamp(state.view.start || 0, 0, Math.max(0, dur - viewSpan()))
}

function tToPct (t) {
  const span = viewSpan()
  if (!span) return 0
  return (t - viewStart()) / span * 100
}

function pctToT (p) {
  return viewStart() + p * viewSpan()
}

function minViewSpan () {
  return Math.max(0.35, duration() / 1500)
}

function setView (start, span) {
  const dur = duration()
  if (!dur) return
  span = clamp(span, Math.min(minViewSpan(), dur), dur)
  start = clamp(start, 0, Math.max(0, dur - span))
  state.view = { start, span }
  if (els.viewInfo) {
    els.viewInfo.textContent = span >= dur - 0.001
      ? '全片'
      : `${fmtTime(start)} – ${fmtTime(start + span)}`
    els.viewInfo.title = '当前视图范围：Shift+滚轮缩放，Alt+滚轮平移，双击时间轴回到全片'
  }
  if (els.btnFitAll) {
    const fitted = span >= dur - 0.001
    els.btnFitAll.disabled = fitted
    els.btnFitAll.textContent = fitted ? '已显示全部' : '显示全部'
    els.btnFitAll.title = fitted ? '当前已是完整时间轴（Home）' : '显示完整片段（Home）'
  }
  refreshTimelineViews()
}

function refreshTimelineViews () {
  renderRuler()
  renderTimeline()
  renderThumbs()
  updatePlayhead()
  drawWaveform()
}

function zoomAt (pct, factor) {
  const span = viewSpan()
  const dur = duration()
  const anchor = viewStart() + pct * span
  const next = clamp(span * factor, Math.min(minViewSpan(), dur), dur)
  setView(anchor - pct * next, next)
}

function followPlayhead (t) {
  const span = viewSpan()
  const dur = duration()
  if (span >= dur - 0.001) return
  const rel = (t - state.view.start) / span
  if (rel > 0.94) setView(t - span * 0.7, span)
  else if (rel < 0.02) setView(t - span * 0.1, span)
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

/* ------------------------------------------------------------------ */
/* 撤销 / 重做                                                         */
/* ------------------------------------------------------------------ */

const hist = { past: [], future: [], limit: 100 }

function snapshotState () {
  return {
    cuts: state.cuts.slice(),
    selected: [...state.selected],
    sel: { ...state.sel },
    outHeight: state.outHeight,
    outHeightManual: state.outHeightManual,
    preset: state.preset,
    mode: state.mode,
    playhead: state.playhead
  }
}

function pushUndo () {
  if (state.exporting || !state.info) return
  hist.past.push(snapshotState())
  if (hist.past.length > hist.limit) hist.past.shift()
  hist.future.length = 0
  updateHistoryUI()
}

function restoreSnapshot (s) {
  state.cuts = s.cuts.slice()
  state.selected = new Set(s.selected)
  state.sel = { ...s.sel }
  state.outHeight = s.outHeight
  state.outHeightManual = s.outHeightManual
  state.preset = s.preset
  state.ratio = state.isAudio ? null : presetRatio(s.preset)
  state.mode = s.mode

  if (els.ratio) els.ratio.value = s.preset
  if (els.mode) els.mode.value = s.mode
  if (els.outHeight) els.outHeight.value = String(s.outHeight)
  updateModeHint()

  seekTo(s.playhead)
  renderAll()
  renderCrop()
}

function updateHistoryUI () {
  if (els.btnUndo) els.btnUndo.disabled = !hist.past.length
  if (els.btnRedo) els.btnRedo.disabled = !hist.future.length
}

function undo () {
  if (!hist.past.length) return
  hist.future.push(snapshotState())
  restoreSnapshot(hist.past.pop())
  updateHistoryUI()
  toast('已撤销')
}

function redo () {
  if (!hist.future.length) return
  hist.past.push(snapshotState())
  restoreSnapshot(hist.future.pop())
  updateHistoryUI()
  toast('已重做')
}

function clearHistory () {
  hist.past.length = 0
  hist.future.length = 0
  updateHistoryUI()
}

function reselectAll () {
  state.selected = new Set(segments().map(s => s.index))
}

// 修饰键点选：Alt 只留当前片段，Shift 追加选中
function applyClickSelect (i, e) {
  let next = null
  if (e.altKey) next = new Set([i])
  else if (e.shiftKey) next = new Set([...state.selected, i])
  else return false

  const before = [...state.selected].sort((a, b) => a - b).join(',')
  const after = [...next].sort((a, b) => a - b).join(',')
  if (before !== after) {
    pushUndo()
    state.selected = next
  }
  renderTimeline()
  renderList()
  renderStatus()
  return true
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
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800]
  for (const s of steps) {
    if (dur / s <= 14) return s
  }
  return 3600
}

function renderRuler () {
  const dur = duration()
  els.ruler.innerHTML = ''
  if (!dur) return

  const span = viewSpan()
  const start = viewStart()
  const step = chooseStep(span)
  const first = Math.floor(start / step) * step

  for (let t = first; t <= start + span + 0.0001; t += step) {
    if (t < start - 0.0001) continue

    const tick = document.createElement('div')
    tick.className = 'tick' + (t % (step * 2) === 0 ? ' major' : '')
    tick.style.left = tToPct(t) + '%'
    els.ruler.appendChild(tick)

    const pct = tToPct(t)
    if (pct >= 0 && pct < 97) {
      const label = document.createElement('div')
      label.className = 'tick-label'
      label.style.left = pct + '%'
      label.textContent = fmtRuler(t)
      els.ruler.appendChild(label)
    }
  }
}

function renderTimeline () {
  const dur = duration()
  const span = viewSpan()
  els.track.innerHTML = ''
  if (!dur || !span) return

  segments().forEach((seg, i) => {
    const el = document.createElement('div')
    el.className = 'clip' + (i % 2 ? ' alt' : '') + (seg.selected ? ' on' : ' no')
    el.style.left = tToPct(seg.start) + '%'
    el.style.width = ((seg.end - seg.start) / span * 100) + '%'
    if (seg.start < viewStart() - 0.001) el.classList.add('head-cut')
    el.title = `片段 ${i + 1}  ${fmtTime(seg.start)} → ${fmtTime(seg.end)}`

    const no = document.createElement('span')
    no.className = 'clip-no'
    no.textContent = i + 1

    const d = document.createElement('span')
    d.className = 'clip-dur'
    d.textContent = fmtDur(seg.end - seg.start)

    el.append(no, d)

    // Alt / Shift 点选：只改选择，不触发时间轴拖动
    el.addEventListener('pointerdown', e => {
      if (e.altKey || e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
      }
    })
    el.addEventListener('click', e => {
      if (!(e.altKey || e.shiftKey)) return
      e.stopPropagation()
      applyClickSelect(i, e)
      seekTo(seg.start)
    })

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
      pushUndo()
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
      applyClickSelect(i, e)
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
    if (state.isAudio) {
      const a = state.info.audio || {}
      els.srcInfo.textContent = `${a.codec || '音频'} · ${a.sampleRate ? (a.sampleRate / 1000) + ' kHz' : '—'} · ${a.channels ? a.channels + ' 声道' : ''} · ${fmtTime(duration(), false)}`.replace(' ·  · ', ' · ')
      els.cropInfo.textContent = '裁剪 —（音频无画面）'
      els.outInfo.textContent = `输出 ${fmtDur(duration())} 音频`
    } else {
      els.srcInfo.textContent = `${state.info.width} × ${state.info.height} · ${state.info.fps ? state.info.fps.toFixed(2) + ' fps' : '—'} · ${fmtTime(duration(), false)}`
    }
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
  const span = viewSpan()
  if (!dur || !span) {
    els.playhead.hidden = true
    return
  }
  const pct = (state.playhead - viewStart()) / span * 100
  const visible = pct >= -0.01 && pct <= 100.01
  els.playhead.hidden = !visible
  els.playhead.style.left = clamp(pct, 0, 100) + '%'
  els.playheadInfo.textContent = fmtTime(state.playhead)
  if (state.isAudio && els.audioCursor) {
    els.audioCursor.hidden = !visible
    els.audioCursor.style.left = clamp(pct, 0, 100) + '%'
  }
}

function updateTimeLabels () {
  els.timeNow.textContent = fmtTime(state.playhead)
  els.timeDur.textContent = fmtTime(duration())
  if (state.isAudio && els.audioNow) els.audioNow.textContent = fmtTime(state.playhead)
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
  seekTo(pctToT(x))
}

/* ------------------------------------------------------------------ */
/* 取景框                                                              */
/* ------------------------------------------------------------------ */

function layoutFrame () {
  if (!state.info) return
  if (state.isAudio) {
    els.frame.style.width = ''
    els.frame.style.height = ''
    drawWaveform()
    return
  }
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
  if (!state.info || state.isAudio) return null
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
  if (state.isAudio) return
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
  pushUndo()
  const guard = { sel: { ...state.sel }, undoIndex: hist.past.length }
  e.preventDefault()
  e.stopPropagation()

  const { W, H } = frameRect()
  state.drag = {
    mode,
    dir,
    guard,
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
  const d = state.drag
  state.drag = null
  els.crop.classList.remove('active')
  try { els.crop.releasePointerCapture?.(e.pointerId) } catch {}
  renderCrop()

  // 只是点了一下没拖动：撤掉这条空历史
  if (d.guard && hist.past.length === d.guard.undoIndex) {
    const a = d.guard.sel
    const b = state.sel
    if (Math.abs(a.x - b.x) < 0.0005 && Math.abs(a.y - b.y) < 0.0005 &&
        Math.abs(a.w - b.w) < 0.0005 && Math.abs(a.h - b.h) < 0.0005) {
      hist.past.pop()
      updateHistoryUI()
    }
  }
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
    state.isAudio = !!info.isAudio
    state.cuts = []
    state.playhead = 0
    state.selected = new Set([0])
    state.outHeightManual = false
    state.outHeightDirty = false
    state.preset = 'source'
    state.ratio = state.isAudio ? null : presetRatio('source')
    state.sel = { x: 0, y: 0, w: 1, h: 1 }

    els.empty.hidden = true
    els.frame.hidden = false
    document.body.classList.toggle('audio-mode', state.isAudio)
    els.audioStage.hidden = !state.isAudio
    els.crop.hidden = state.isAudio

    els.video.src = toXcUrl(file)
    els.video.load()
    els.video.muted = state.muted

    els.btnPlay.disabled = false
    els.btnPrev.disabled = false
    els.btnNext.disabled = false
    els.btnCutTop.disabled = false
    els.btnExport.disabled = false
    els.btnSelectAll.disabled = false
    els.btnSelectNone.disabled = false
    els.outHeight.disabled = state.isAudio

    if (state.isAudio) {
      const a = info.audio || {}
      const parts = [
        a.codec || '音频',
        a.sampleRate ? (a.sampleRate / 1000).toFixed(1).replace('.0', '') + ' kHz' : '',
        a.channels ? a.channels + ' 声道' : '',
        fmtTime(info.duration, false)
      ].filter(Boolean)
      els.audioName.textContent = file.split(/[\\/]/).pop()
      els.audioMeta.textContent = parts.join(' · ')
      els.audioWaveInfo.textContent = '正在解析波形…'
      els.outSize.textContent = `音频 ${fmtTime(info.duration, false)}`
      buildWaveform(file, info)
    } else {
      els.audioName.textContent = '—'
      els.audioMeta.textContent = ''
      els.audioWaveInfo.textContent = ''
      els.outSize.textContent = '最终 —'
      waveData = null
      els.wave.style.opacity = '1'
    }

    els.ratio.value = state.preset
    updateModeHint()
    setView(0, info.duration || 0)
    layoutFrame()
    if (!state.isAudio) fitPreset(state.preset)
    renderAll()
    clearHistory()
    state.projectPath = null
    buildThumbs(file)
    return true
  } catch (err) {
    toast('无法读取这个文件：\n' + (err.message || err))
    return false
  }
}

/* ------------------------------------------------------------------ */
/* 工程文件                                                            */
/* ------------------------------------------------------------------ */

function defaultProjectPath (file) {
  const dir = file.replace(/[\\/][^\\/]+$/, '')
  const name = file.replace(/^.*[\\/]/, '').replace(/\.\w+$/, '')
  return dir + '\\' + name + '.xcproj'
}

function collectProject () {
  return {
    app: 'xcVideoEdit',
    version: 2,
    file: state.file,
    mediaName: state.file ? state.file.replace(/^.*[\\/]/, '') : '',
    cuts: state.cuts.slice(),
    selected: [...state.selected].sort((a, b) => a - b),
    sel: { ...state.sel },
    preset: state.preset,
    outHeight: state.outHeight,
    outHeightManual: state.outHeightManual,
    mode: state.mode,
    muted: state.muted,
    playhead: state.playhead,
    savedAt: new Date().toISOString()
  }
}

async function saveProject (asNew = false) {
  if (!state.info) {
    toast('先打开视频或音频，再保存工程')
    return
  }
  try {
    const data = collectProject()
    if (state.projectPath && !asNew) {
      await window.xc.writeProject(state.projectPath, data)
      toast('工程已保存：\n' + state.projectPath, true)
      return
    }
    const p = await window.xc.saveProject(data, defaultProjectPath(state.file))
    if (!p) return
    state.projectPath = p
    toast('工程已保存：\n' + p, true)
  } catch (e) {
    toast('保存工程失败：\n' + (e.message || e))
  }
}

async function openProjectFile () {
  try {
    const res = await window.xc.openProject()
    if (!res) return
    const d = res.data || {}
    if (!d.file) {
      toast('工程文件缺少素材路径，无法打开')
      return
    }
    const ok = await loadVideo(d.file)
    if (!ok) return
    applyProject(d)
    state.projectPath = res.path
    toast('已打开工程：\n' + res.path, true)
  } catch (e) {
    toast('打开工程失败：\n' + (e.message || e))
  }
}

function applyProject (d) {
  const dur = duration()
  state.cuts = (d.cuts || [])
    .map(Number)
    .filter(n => Number.isFinite(n) && n > 0.02 && n < dur - 0.02)
    .sort((a, b) => a - b)

  const list = segments()
  const picked = new Set((d.selected || []).map(Number).filter(n => n >= 0 && n < list.length))
  state.selected = picked.size ? picked : new Set(list.map(s => s.index))

  if (d.sel && Number.isFinite(d.sel.x)) {
    state.sel = {
      x: clamp(Number(d.sel.x), 0, 1),
      y: clamp(Number(d.sel.y), 0, 1),
      w: clamp(Number(d.sel.w), 0.01, 1),
      h: clamp(Number(d.sel.h), 0.01, 1)
    }
  }

  if (Number.isFinite(d.outHeight) && d.outHeight >= 2) state.outHeight = even(d.outHeight)
  state.outHeightManual = !!d.outHeightManual
  state.preset = d.preset || 'source'
  state.ratio = state.isAudio ? null : presetRatio(state.preset)
  state.mode = d.mode === 'precise' ? 'precise' : 'lossless'

  if (els.ratio) els.ratio.value = state.preset
  if (els.mode) els.mode.value = state.mode
  if (els.outHeight) els.outHeight.value = String(state.outHeight)
  if (d.muted !== undefined) setMuted(!!d.muted)
  updateModeHint()

  if (Number.isFinite(d.playhead)) {
    const target = d.playhead
    seekTo(target)
    // 视频元数据还没就绪时，等 loadedmetadata 再定位一次
    if (Math.abs((els.video.currentTime || 0) - target) > 0.2) {
      els.video.addEventListener('loadedmetadata', () => seekTo(target), { once: true })
    }
  }
  renderAll()
  renderCrop()
  clearHistory()
}

/* ------------------------------------------------------------------ */
/* 时间轴缩略图                                                        */
/* ------------------------------------------------------------------ */

let thumbToken = 0

async function buildThumbs (file) {
  const token = ++thumbToken
  state.thumbData = null
  els.thumbs.innerHTML = ''
  if (state.isAudio || !file) return
  try {
    const res = await window.xc.getThumbs(file)
    if (token !== thumbToken) return
    state.thumbData = res
    renderThumbs()
  } catch {
    if (token !== thumbToken) return
    els.thumbs.innerHTML = '<span class="thumbs-fail">缩略图不可用</span>'
  }
}

function renderThumbs () {
  els.thumbs.innerHTML = ''
  const data = state.thumbData
  if (!data || !data.files || !data.files.length) return

  const dur = duration()
  const span = viewSpan()
  const start = viewStart()
  if (!dur || !span) return

  const n = data.files.length
  data.files.forEach((name, i) => {
    const t0 = i * dur / n
    const t1 = (i + 1) * dur / n
    const a = Math.max(t0, start)
    const b = Math.min(t1, start + span)
    if (b <= a) return

    const img = document.createElement('img')
    img.className = 'thumb'
    img.draggable = false
    img.src = toXcUrl(data.dir + '\\' + name)
    img.style.left = ((a - start) / span * 100) + '%'
    img.style.width = ((b - a) / span * 100) + '%'
    img.title = `跳到 ${fmtTime((t0 + t1) / 2)}`
    img.addEventListener('click', e => {
      e.stopPropagation()
      seekTo((t0 + t1) / 2)
    })
    els.thumbs.appendChild(img)
  })
}

/* ------------------------------------------------------------------ */
/* 波形                                                                */
/* ------------------------------------------------------------------ */

let waveData = null
let waveToken = 0

async function buildWaveform (file, info) {
  const token = ++waveToken
  waveData = null
  els.wave.style.opacity = '0.3'
  if (info.size > 400 * 1024 * 1024) {
    els.audioWaveInfo.textContent = '文件较大，已跳过波形解析（不影响切割与导出）'
    return
  }
  try {
    const buf = await window.xc.readAudioBinary(file)
    if (token !== waveToken) return
    const AC = window.AudioContext || window.webkitAudioContext
    const ac = new AC()
    let audio = null
    try {
      audio = await ac.decodeAudioData(buf.slice(0))
    } finally {
      ac.close().catch?.(() => {})
    }
    if (token !== waveToken) return

    const data = audio.getChannelData(0)
    const N = 4000
    const block = Math.max(1, Math.floor(data.length / N))
    const peaks = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      let max = 0
      const s = i * block
      const e = Math.min(data.length, s + block)
      for (let j = s; j < e; j++) {
        const v = Math.abs(data[j])
        if (v > max) max = v
      }
      peaks[i] = max
    }
    // 按峰值归一化，避免小音量音频在界面上只剩一条细线
    let maxPeak = 0
    for (let i = 0; i < peaks.length; i++) if (peaks[i] > maxPeak) maxPeak = peaks[i]
    if (maxPeak > 0.0005) {
      for (let i = 0; i < peaks.length; i++) peaks[i] = Math.min(1, peaks[i] / maxPeak)
    }

    waveData = peaks
    els.wave.style.opacity = '1'
    els.audioWaveInfo.textContent = `波形已就绪 · ${audio.duration.toFixed(2)} 秒 · ${audio.numberOfChannels} 声道`
    drawWaveform()
    updatePlayhead()
  } catch (e) {
    if (token !== waveToken) return
    els.audioWaveInfo.textContent = '波形解析失败（不影响切割与导出）：' + (e.message || e)
  }
}

function drawWaveform () {
  const cv = els.wave
  if (!cv) return
  if (!waveData) {
    const c = cv.getContext('2d')
    c.clearRect(0, 0, cv.width, cv.height)
    return
  }
  const rect = cv.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.floor(rect.width))
  const h = Math.max(1, Math.floor(rect.height))
  if (cv.width !== Math.floor(w * dpr) || cv.height !== Math.floor(h * dpr)) {
    cv.width = Math.floor(w * dpr)
    cv.height = Math.floor(h * dpr)
  }
  const ctx = cv.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  ctx.strokeStyle = 'rgba(255,255,255,0.12)'
  ctx.beginPath()
  ctx.moveTo(0, h / 2)
  ctx.lineTo(w, h / 2)
  ctx.stroke()

  const dur = duration()
  const span = viewSpan()
  const start = viewStart()
  if (!dur || !span) return

  const px = Math.max(1, Math.floor(w))
  const N = waveData.length
  const i0 = Math.max(0, Math.floor((start / dur) * N))
  const i1 = Math.min(N, Math.ceil(((start + span) / dur) * N))
  const count = Math.max(1, i1 - i0)

  const grad = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, 'rgba(122,178,255,0.95)')
  grad.addColorStop(0.5, 'rgba(96,150,240,0.95)')
  grad.addColorStop(1, 'rgba(122,178,255,0.95)')
  ctx.fillStyle = grad

  // 按屏幕像素取样，缩放后波形依然贴合时间轴
  for (let x = 0; x < px; x++) {
    const a = Math.min(N, i0 + Math.floor(x * count / px))
    const b = Math.min(N, Math.max(a + 1, i0 + Math.floor((x + 1) * count / px)))
    let m = 0
    for (let j = a; j < b; j++) if (waveData[j] > m) m = waveData[j]
    const amp = m * (h / 2 - 4)
    ctx.fillRect(x, h / 2 - amp, 1.2, Math.max(1, amp * 2))
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

  pushUndo()
  state.cuts.push(t)
  state.cuts.sort((a, b) => a - b)
  reselectAll()
  renderAll()
}

function removeCut (t) {
  if (!t) return
  pushUndo()
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

function setMuted (m) {
  state.muted = !!m
  els.video.muted = state.muted
  els.btnMute.textContent = state.muted ? '🔇' : '🔊'
  els.btnMute.title = state.muted ? '静音开关（当前：静音）' : '静音开关（当前：有声）'
  els.btnMute.classList.toggle('mute-on', state.muted)
}

function stepFrame (dir) {
  if (!state.info) return
  els.video.pause()
  if (state.isAudio) {
    seekTo(els.video.currentTime + dir * 0.1)
    return
  }
  const fps = state.info.fps || 25
  seekTo(els.video.currentTime + dir / fps)
}

function updateModeHint () {
  if (state.isAudio) {
    els.modeHint.textContent = state.mode === 'precise'
      ? '逐帧精确，重新编码音频'
      : '切点对齐音频包，秒出（误差通常 < 0.05 秒）'
  } else {
    els.modeHint.textContent = state.mode === 'precise'
      ? '逐帧精确，需重编码，耗时较长'
      : '切点对齐关键帧，秒出片（起点可能前后偏移）'
  }
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

function defaultOutputPath (input, isAudio) {
  const dir = input.replace(/[\\/][^\\/]+$/, '')
  const name = input.replace(/^.*[\\/]/, '').replace(/\.\w+$/, '')
  const ext = (input.match(/\.(\w+)$/) || [])[1] || ''
  if (isAudio) {
    const keep = ['mp3', 'wav', 'flac', 'ogg', 'm4a']
    const e = keep.includes(ext.toLowerCase()) ? ext.toLowerCase() : 'm4a'
    return dir + '\\' + name + '_剪好.' + e
  }
  return dir + '\\' + name + '_成片.mp4'
}

async function doExport () {
  if (!state.info || state.exporting) return

  const picked = segments().filter(s => s.selected)
  if (!picked.length) {
    toast('至少勾选一个片段再导出')
    return
  }

  const geom = state.isAudio
    ? { vf: null, outW: null, outH: null, ch: null }
    : calcGeom()
  if (!geom) return

  const output = await window.xc.chooseOutput(
    defaultOutputPath(state.file, state.isAudio),
    state.isAudio ? 'audio' : 'video'
  )
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
      audio: state.isAudio,
      sourceCodec: (state.info.audio && state.info.audio.codec) || '',
      segments: picked.map(s => ({ start: s.start, end: s.end }))
    })
    els.progressBar.style.width = '100%'
    els.progressText.textContent = '100%'
    const pickedDur = picked.reduce((a, s) => a + (s.end - s.start), 0)
    if (state.isAudio) {
      toast(
        `导出完成：${res.count} 段 · ${fmtDur(pickedDur)}` +
        (res.reencoded ? '\n（目标格式需要转换，已重新编码音频）' : '') +
        `\n${res.output}`,
        true
      )
    } else {
      toast(
        `导出完成：${res.count} 段 · ${geom.outW} × ${geom.outH}` +
        (switched ? '\n（含取景裁切，已自动改用精确重编码）' : '') +
        `\n${res.output}`,
        true
      )
    }
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

els.btnUndo.addEventListener('click', undo)
els.btnRedo.addEventListener('click', redo)
els.btnFitAll.addEventListener('click', () => {
  if (state.info) setView(0, duration())
})
els.btnSaveProj.addEventListener('click', () => saveProject(false))
els.btnOpenProj.addEventListener('click', openProjectFile)

els.btnPlay.addEventListener('click', togglePlay)
els.btnMute.addEventListener('click', () => setMuted(!state.muted))
els.btnPrev.addEventListener('click', () => stepFrame(-1))
els.btnNext.addEventListener('click', () => stepFrame(1))
els.btnCutTop.addEventListener('click', cutAtPlayhead)
els.btnExport.addEventListener('click', doExport)

els.btnSelectAll.addEventListener('click', () => {
  pushUndo()
  state.selected = new Set(segments().map(s => s.index))
  renderTimeline()
  renderList()
  renderStatus()
})

els.btnSelectNone.addEventListener('click', () => {
  pushUndo()
  state.selected = new Set()
  renderTimeline()
  renderList()
  renderStatus()
})

els.ratio.addEventListener('change', () => {
  pushUndo()
  state.preset = els.ratio.value
  state.ratio = presetRatio(state.preset)
  fitPreset(state.preset)
})

els.outHeight.addEventListener('input', () => {
  const v = parseInt(els.outHeight.value, 10)
  if (Number.isFinite(v) && v >= 2) {
    // 一次连续输入只记一条历史
    if (!state.outHeightDirty) {
      pushUndo()
      state.outHeightDirty = true
    }
    state.outHeightManual = true
    state.outHeight = v
    renderCrop()
  }
})

els.outHeight.addEventListener('change', () => {
  state.outHeightDirty = false
})

els.scalePct.addEventListener('change', () => {
  const v = Number(els.scalePct.value)
  if (!Number.isFinite(v)) return // 选了「自定义」，交给高度输入框决定

  const g = calcGeom()
  if (!g) return
  pushUndo()
  state.outHeightManual = true
  state.outHeight = Math.max(2, even(g.ch * v / 100))
  els.outHeight.value = String(state.outHeight)
  renderCrop()
})

els.mode.addEventListener('change', () => {
  pushUndo()
  state.mode = els.mode.value
  updateModeHint()
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
  if (!els.video.paused) followPlayhead(els.video.currentTime)
})
els.video.addEventListener('play', () => { els.btnPlay.textContent = '❚❚' })
els.video.addEventListener('pause', () => { els.btnPlay.textContent = '▶' })
els.video.addEventListener('click', togglePlay)

// 时间轴缩放与平移：Alt+滚轮左右移，Shift/Ctrl+滚轮以光标为锚点缩放
els.timeline.addEventListener('wheel', e => {
  if (!state.info) return
  e.preventDefault()
  const rect = els.track.getBoundingClientRect()
  if (e.altKey) {
    const span = viewSpan()
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    setView(viewStart() + delta * span / 900, span)
  } else if (e.shiftKey || e.ctrlKey || e.metaKey) {
    const pct = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1)
    zoomAt(pct, e.deltaY > 0 ? 1.25 : 0.8)
  }
}, { passive: false })

els.timeline.addEventListener('dblclick', () => {
  if (state.info) setView(0, duration())
})

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
  const typing = tag === 'input' || tag === 'select' || tag === 'textarea'
  const ctrl = e.ctrlKey || e.metaKey

  if (ctrl && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault()
    if (e.shiftKey) redo()
    else undo()
    return
  }
  if (ctrl && (e.key === 'y' || e.key === 'Y')) {
    e.preventDefault()
    redo()
    return
  }
  if (ctrl && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault()
    saveProject(false)
    return
  }
  if (ctrl && e.shiftKey && (e.key === 'S' || e.key === 's')) {
    e.preventDefault()
    saveProject(true)
    return
  }
  if (ctrl && e.shiftKey && (e.key === 'o' || e.key === 'O')) {
    e.preventDefault()
    openProjectFile()
    return
  }

  if (typing) return

  if (e.code === 'Space') {
    e.preventDefault()
    togglePlay()
    return
  }

  if (!state.info) return

  if (e.key === 'c' || e.key === 'C') {
    e.preventDefault()
    cutAtPlayhead()
  } else if (e.key === 'Home') {
    e.preventDefault()
    setView(0, duration())
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
  else toast('没能获取拖入文件的路径，请用「打开文件」按钮。')
})

// 启动参数
const initialVideo = new URLSearchParams(location.search).get('video')
if (initialVideo) loadVideo(initialVideo)

els.modeHint.textContent = '切点对齐关键帧，秒出片（起点可能前后偏移）'
updateModeHint()
updateHistoryUI()
setMuted(true)
