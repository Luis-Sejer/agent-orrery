// Makes the launch video's sound from nothing but ffmpeg's synthesis filters: a slow pad in
// C major 7 drifting to F major 7, and small effects placed on the moments the recording logged.
// No samples, no downloads. Writes build/audio/mix.wav for render.sh to put in the video.
//
//   node docs/src/audio.mjs <video seconds> <recording start> <recording end> <title seconds> <fade seconds> <end card at>

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BUILD = fileURLToPath(new URL('./build/', import.meta.url))
const OUT = `${BUILD}audio/`
const RATE = 48_000
const [duration, recStart, recEnd, titleSeconds, fade, endCardAt] = process.argv.slice(2).map(Number)
// Where a moment of the recording lands in the video: the recording fades in under the title card.
const recordingOffset = titleSeconds - fade - recStart
const MIN_BLIP_GAP = 0.5
const REDRAW_SECONDS = 0.6

mkdirSync(OUT, { recursive: true })

const ffmpeg = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args])
const synth = (name, seconds, expression, filters = 'anull') =>
  ffmpeg('-f', 'lavfi', '-i', `aevalsrc='${expression}':s=${RATE}:d=${seconds}`, '-af', filters, '-ac', '1', `${OUT}${name}.wav`)

// A pad note: a sine with a quieter detuned pair around it and a faint octave, swelling slowly
// at its own rate. Each note gets its own detune, so their beating never lines up into a pulse.
const note = (frequency, amp, swell, phase, detune) =>
  `${amp}*(0.62+0.38*sin(2*PI*${swell}*t+${phase}))*(sin(2*PI*${frequency}*t)+0.4*sin(2*PI*${frequency - detune}*t+1)+0.4*sin(2*PI*${frequency + detune}*t+2)+0.1*sin(2*PI*${frequency * 2}*t))`
const chord = (notes) => notes.map(([frequency, amp], index) => note(frequency, amp, 0.045 + index * 0.017, index * 1.3, 0.07 + index * 0.043)).join('+')
const CMAJ7 = [[130.81, 0.36], [196.0, 0.34], [246.94, 0.28], [329.63, 0.22], [493.88, 0.07]]
const FMAJ7 = [[87.31, 0.32], [220.0, 0.34], [261.63, 0.28], [329.63, 0.22], [440.0, 0.07]]
const turn = duration * 0.46
synth(
  'bed',
  duration,
  `0.05*(clip((${turn + 2}-t)/4,0,1)*(${chord(CMAJ7)})+clip((t-${turn - 2})/4,0,1)*(${chord(FMAJ7)}))`,
  `highpass=f=55,lowpass=f=1600,aecho=0.8:0.6:140|310:0.28|0.18,afade=t=in:d=2.5,afade=t=out:st=${duration - 3}:d=3`,
)
// Bring the pad to -24 LUFS with one fixed gain, so its swells stay as they are.
const BED_LUFS = -24
const measured = spawnSync('ffmpeg', ['-nostats', '-i', `${OUT}bed.wav`, '-af', 'ebur128', '-f', 'null', '-']).stderr.toString()
const integrated = Number(measured.match(/I:\s+(-?[\d.]+) LUFS/g).at(-1).match(/-?[\d.]+/)[0])
ffmpeg('-i', `${OUT}bed.wav`, '-af', `volume=${(BED_LUFS - integrated).toFixed(2)}dB`, `${OUT}bed-level.wav`)

// A small bell: E5 then B5, with quickly fading upper partials.
const bell = (frequency, delay) =>
  `gte(t,${delay})*exp(-2.4*(t-${delay}))*min((t-${delay})/0.004,1)*(sin(2*PI*${frequency}*(t-${delay}))+0.3*exp(-7*(t-${delay}))*sin(2*PI*${frequency * 2.0}*(t-${delay}))+0.12*exp(-12*(t-${delay}))*sin(2*PI*${frequency * 3.01}*(t-${delay})))`
synth('chime', 2.2, `0.32*(${bell(659.25, 0)}+0.8*${bell(987.77, 0.09)})`, 'lowpass=f=5200,aecho=0.8:0.55:90|190:0.22|0.12')
// A message blip, in two pitches so a run of them doesn't drone.
for (const [name, frequency] of [['blip-high', 1567.98], ['blip-low', 1318.51]]) {
  synth(name, 0.3, `0.22*exp(-26*t)*min(t/0.003,1)*(sin(2*PI*${frequency}*t)+0.35*sin(2*PI*${frequency / 2}*t))`, 'aecho=0.8:0.4:60:0.2')
}
// A muted click: a short low thump and a filtered tick of noise.
synth('click', 0.15, '0.5*exp(-48*t)*sin(2*PI*150*t)+0.35*exp(-140*t)*(2*random(0)-1)', 'lowpass=f=2400')
synth('tick', 0.06, '0.4*exp(-260*t)*(2*random(0)-1)', 'highpass=f=1800,lowpass=f=7000')
// A whoosh: pink noise in a soft band, swelling and falling away.
ffmpeg('-f', 'lavfi', '-i', `anoisesrc=color=pink:r=${RATE}:d=1.4:a=0.5`, '-af', "highpass=f=180,lowpass=f=1300,volume='0.6*sin(PI*t/1.4)^2':eval=frame", '-ac', '1', `${OUT}whoosh.wav`)

// Which sound plays when, in video time.
const SOUNDS = { select: ['click', 1], click: ['click', 0.8], key: ['tick', 1], type: ['tick', 0.45], waiting: ['chime', 1] }
const cues = [
  { sound: 'whoosh', at: 0, gain: 0.7 },
  { sound: 'whoosh', at: titleSeconds - fade - 0.45, gain: 0.8 },
  { sound: 'whoosh', at: endCardAt - 0.45, gain: 0.8 },
]
const events = JSON.parse(readFileSync(`${BUILD}rec/events.json`, 'utf8')).filter((event) => event.time >= recStart && event.time <= recEnd - 0.3)
let lastBlip = -Infinity
let lastInteraction = -Infinity
let blips = 0
for (const event of events) {
  const at = event.time + recordingOffset
  if (event.type !== 'message') lastInteraction = at
  if (event.type === 'message') {
    // A click or key redraws the lines, which restarts pulses that were already travelling.
    if (at - lastBlip < MIN_BLIP_GAP || at - lastInteraction < REDRAW_SECONDS) continue
    lastBlip = at
    cues.push({ sound: blips++ % 2 ? 'blip-low' : 'blip-high', at, gain: 1 })
  } else if (SOUNDS[event.type]) {
    const [sound, gain] = SOUNDS[event.type]
    cues.push({ sound, at, gain })
  }
}

const inputs = ['-i', `${OUT}bed-level.wav`, ...cues.flatMap((cue) => ['-i', `${OUT}${cue.sound}.wav`])]
const delayed = cues.map((cue, index) => {
  const ms = Math.max(0, Math.round(cue.at * 1000))
  return `[${index + 1}]volume=${cue.gain},adelay=${ms}:all=1[c${index}]`
})
const graph = [
  ...delayed,
  `[0]${cues.map((_, index) => `[c${index}]`).join('')}amix=inputs=${cues.length + 1}:normalize=0:duration=first,alimiter=limit=0.7,aformat=channel_layouts=stereo[out]`,
].join(';')
ffmpeg(...inputs, '-filter_complex', graph, '-map', '[out]', '-t', String(duration), `${OUT}mix.wav`)
console.log(`mixed ${cues.length} cues over the pad into docs/src/build/audio/mix.wav`)
