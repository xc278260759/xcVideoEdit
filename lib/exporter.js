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

// 单轨片段导出：逐段切割，再按顺序合并（视频合并、音频合并共用一套流程）
const AUDIO_CONTAINERS = ['m4a', 'mp3', 'wav', 'flac', 'ogg', 'oga', 'opus']

function audioEncodeArgs (container, mode, srcCodec) {
  const copyOK = {
    m4a: ['aac', 'alac', 'mp3'],
    mp3: ['mp3'],
    wav: ['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8'],
    flac: ['flac'],
    ogg: ['vorbis', 'opus'],
    oga: ['vorbis', 'opus'],
    opus: ['opus']
  }[container] || []

  if (mode !== 'precise' && copyOK.includes(srcCodec)) {
    return { args: ['-vn', '-c:a', 'copy'], encoded: false }
  }
  const encoded = {
    m4a: ['-vn', '-c:a', 'aac', '-b:a', '192k'],
    mp3: ['-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-ar', '44100'],
    wav: ['-vn', '-c:a', 'pcm_s16le'],
    flac: ['-vn', '-c:a', 'flac'],
    ogg: ['-vn', '-c:a', 'libvorbis', '-q:a', '5'],
    oga: ['-vn', '-c:a', 'libvorbis', '-q:a', '5'],
    opus: ['-vn', '-c:a', 'libopus', '-b:a', '128k']
  }[container] || ['-vn', '-c:a', 'aac', '-b:a', '192k']
  return { args: encoded, encoded: true }
}

async function exportSegments (opts, onProgress = () => {}) {
  const { input, output, segments, mode, ffmpeg, vf, audio, sourceCodec } = opts
  if (!Array.isArray(segments) || !segments.length) throw new Error('没有可导出的片段')

  const ext = path.extname(output).slice(1).toLowerCase()
  const isAudio = !!audio || AUDIO_CONTAINERS.includes(ext)
  if (isAudio && !AUDIO_CONTAINERS.includes(ext)) {
    throw new Error('音频导出请选择 m4a / mp3 / wav / flac / ogg 格式')
  }
  if (!isAudio && vf && mode !== 'precise') throw new Error('带取景裁切或缩放的导出必须使用精确重编码模式')

  const container = isAudio ? ext : 'mp4'
  const partExt = '.' + container
  const au = isAudio ? audioEncodeArgs(container, mode, sourceCodec) : null

  const tmpDir = path.join(path.dirname(output), '.xcVideoEdit_tmp_' + Date.now())
  fs.mkdirSync(tmpDir, { recursive: true })

  const total = segments.reduce((sum, s) => sum + Math.max(0.02, s.end - s.start), 0)
  let done = 0
  const parts = []

  try {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const dur = Math.max(0.02, seg.end - seg.start)
      const part = path.join(tmpDir, `part_${String(i).padStart(3, '0')}${partExt}`)

      const base = ['-y', '-ss', String(seg.start), '-i', input, '-t', String(dur)]
      const encode = isAudio
        ? au.args
        : mode === 'precise'
          ? [...(vf ? ['-vf', vf] : []), '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k']
          : ['-c', 'copy', '-avoid_negative_ts', 'make_zero']
      const mux = isAudio ? [] : ['-movflags', '+faststart']

      await runFfmpeg(
        ffmpeg,
        [...base, ...encode, ...mux, '-progress', 'pipe:1', '-nostats', part],
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
        ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', ...(isAudio ? [] : ['-movflags', '+faststart']), '-progress', 'pipe:1', '-nostats', output],
        () => onProgress(99)
      )
    }

    onProgress(100)
    return { output, count: parts.length, audio: isAudio, reencoded: isAudio ? !!au.encoded : mode === 'precise' }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

module.exports = { exportSegments, runFfmpeg, extractError }
