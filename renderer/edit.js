'use strict'

const $ = id => document.getElementById(id)

const els = {
  video: $('video'),
  preview: $('preview'),
  empty: $('empty'),
  btnOpen: $('btnOpen'),
  btnCutTop: $('btnCutTop'),
  btnExport: $('btnExport'),
  tabCrop: $('tabCrop'),
  btnPlay: $('btnPlay'),
  btnPrev: $('btnPrev'),
  btnNext: $('btnNext'),
  btnSelectAll: $('btnSelectAll'),
  btnSelectNone: $('btnSelectNone'),
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
  segmentInfo: $('segmentInfo'),
  selectedInfo: $('selectedInfo'),
  modeInfo: $('modeInfo'),
  progress: $('progress'),
  progressBar: $('progressBar'),
  progressText: $('progressText'),
  toast: $('toast')
}

const state = {
  file: null,
  info: null,
  cuts: [],
  selected: new Set(),
  playhead: 0,
  mode: 'lossless',
  exporting: false,
  dragging: false
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function clamp (v, a, b) { return Math.max(a, Math.min(b, v)) }

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
/* 载入                                                               */
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

    els.empty.hidden = true
    els.video.src = toXcUrl(file)
    els.video.load()

    els.btnPlay.disabled = false
    els.btnPrev.disabled = false
    els.btnNext.disabled = false
    els.btnCutTop.disabled = false
    els.btnExport.disabled = false
    els.btnSelectAll.disabled = false
    els.btnSelectNone.disabled = false

    renderAll()
  } catch (err) {
    toast('无法读取这个视频：\n' + (err.message || err))
  }
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

function defaultOutputPath (input) {
  const dir = input.replace(/[\\/][^\\/]+$/, '')
  const name = input.replace(/^.*[\\/]/, '').replace(/\.\w+$/, '')
  return dir + '\\' + name + '_剪辑.mp4'
}

async function doExport () {
  if (!state.info || state.exporting) return

  const picked = segments().filter(s => s.selected)
  if (!picked.length) {
    toast('至少勾选一个片段再导出')
    return
  }

  const output = await window.xc.chooseOutput(defaultOutputPath(state.file))
  if (!output) return

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
      mode: state.mode,
      segments: picked.map(s => ({ start: s.start, end: s.end }))
    })
    els.progressBar.style.width = '100%'
    els.progressText.textContent = '100%'
    toast(`导出完成：${res.count} 个片段合并\n${res.output}`, true)
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

els.tabCrop.addEventListener('click', () => {
  const q = state.file ? '?video=' + encodeURIComponent(state.file) : ''
  location.href = 'index.html' + q
})

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

els.mode.addEventListener('change', () => {
  state.mode = els.mode.value
  els.modeHint.textContent = state.mode === 'precise'
    ? '逐帧精确，需重编码，耗时较长'
    : '切点对齐关键帧，秒出片（起点可能前后偏移）'
  renderStatus()
})

els.video.addEventListener('loadedmetadata', renderAll)
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
