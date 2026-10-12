import { ago } from '../status'

const STEP_MS = 60_000
const PLAY_PATH = 'M8 5v14l11-7z'
const PAUSE_PATH = 'M8 5v14M16 5v14'

interface ReplayBarProps {
  at: number
  // The live clock: the slider ends here.
  now: number
  windowMs: number
  playing: boolean
  onSeek: (at: number) => void
  onTogglePlay: () => void
  onLive: () => void
}

export function replayLabel(at: number, now: number): string {
  const time = new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return `${time}, ${ago(at, now)} ago`
}

function ReplayBanner({ at, now }: { at: number; now: number }) {
  return (
    <p className="replay-banner" role="status">
      Replay: this is {replayLabel(at, now)}. Notifications are paused.
    </p>
  )
}

export function ReplayBar({ at, now, windowMs, playing, onSeek, onTogglePlay, onLive }: ReplayBarProps) {
  const label = playing ? 'Pause' : 'Play'
  return (
    <div className="replay">
      <ReplayBanner at={at} now={now} />
      <div className="replay-bar" role="group" aria-label="Replay">
        <button type="button" className="icon-button" aria-label={label} title={label} onClick={onTogglePlay}>
          <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d={playing ? PAUSE_PATH : PLAY_PATH} />
          </svg>
        </button>
        <input
          type="range"
          aria-label="Time to show"
          min={now - windowMs}
          max={now}
          step={STEP_MS}
          value={Math.min(Math.max(at, now - windowMs), now)}
          onChange={(event) => onSeek(Number(event.target.value))}
        />
        <time className="replay-time" dateTime={new Date(at).toISOString()}>
          {replayLabel(at, now)}
        </time>
        <button type="button" className="button quiet" onClick={onLive}>
          Back to live
        </button>
      </div>
    </div>
  )
}
