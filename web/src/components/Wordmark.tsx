// The agent-graph mark: an orb on two dashed orbits, beside the name.
export function Wordmark() {
  return (
    <span className="wordmark">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <circle className="wordmark-orbit" cx="16" cy="16" r="14.5" />
        <circle className="wordmark-orbit" cx="16" cy="16" r="10" />
        <circle className="wordmark-core" cx="16" cy="16" r="5" />
        <circle className="wordmark-moon" cx="26.25" cy="5.75" r="2.25" />
      </svg>
      <span className="wordmark-name">
        <span className="serif">agent-graph</span>
        <span className="wordmark-by">by sejer</span>
      </span>
    </span>
  )
}
