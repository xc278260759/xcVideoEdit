'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function extractError (stderr) {
  const lines = stderr.split(/\r?\n/).filter(Boolean)
  const bad = lines.filter(l => /error|invalid|failed|unable|no such|not found/i.test(l))
  return (bad.length ? bad.slice(-6) : lines.slice(-6)).join('\n')
}

function runFfmpeg (ffmpeg, args, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { windowsHide: true })
    let stderr = ''
    let lastUs = 0

    proc.stdout.on('data', chunk => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        const i = line.indexOf('=')
        if (i < 0) continue
        const key = line.slice(0, i)
        const val = line.slice(i + 1).trim()
        if (key === 'out_time_us' || key === 'out_time_ms') {
          const n = parseInt(val, 10)
          if (Number.isFinite(n)) lastUs = n
        }
      }
      if (onProgress) onProgress(lastUs / 1e6)
    })

    proc.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-6000) })
    proc.on('error', reject)
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(extractError(stderr) || `ffmpeg 退出码 ${code}`))
    })
  })
}

// 单轨片段导出：逐段切割，再按顺序无损合并
async function exportSegments (opts, onProgress = () => {}) {
  const { input, output, segments, mode, ffmpeg, vf } = opts
  if (!Array.isArray(segments) || !segments.length) throw new Error('没有可导出的片段')
  if (vf && mode !== 'precise') throw new Error('带取景裁切或缩放的导出必须使用精确重编码模式')

  const tmpDir = path.join(path.dirname(output), '.xcVideoEdit_tmp_' + Date.now())
  fs.mkdirSync(tmpDir, { recursive: true })

  const total = segments.reduce((sum, s) => sum + Math.max(0.02, s.end - s.start), 0)
  let done = 0
  const parts = []

  try {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const dur = Math.max(0.02, seg.end - seg.start)
      const part = path.join(tmpDir, `part_${String(i).padStart(3, '0')}.mp4`)

      const base = ['-y', '-ss', String(seg.start), '-i', input, '-t', String(dur)]
      const encode = mode === 'precise'
        ? [...(vf ? ['-vf', vf] : []), '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k']
        : ['-c', 'copy', '-avoid_negative_ts', 'make_zero']

      await runFfmpeg(
        ffmpeg,
        [...base, ...encode, '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', part],
        sec => {
          const p = Math.min(1, sec / dur)
          onProgress(((done + p * dur) / total) * 100)
        }
      )

      parts.push(part)
      done += dur
    }

    if (parts.length === 1) {
      fs.copyFileSync(parts[0], output)
    } else {
      const listFile = path.join(tmpDir, 'concat.txt')
      fs.writeFileSync(
        listFile,
        parts.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
        'utf8'
      )
      await runFfmpeg(
        ffmpeg,
        ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output],
        () => onProgress(99)
      )
    }

    onProgress(100)
    return { output, count: parts.length }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

module.exports = { exportSegments, runFfmpeg, extractError }
