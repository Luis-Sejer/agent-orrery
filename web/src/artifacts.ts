// Artifacts are links to claude.ai, the only thing Orrery opens from them; anything that isn't exactly
// such a link is never made clickable.
const ARTIFACT_URL = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]{6,80}$/

export const isArtifactUrl = (url: string) => ARTIFACT_URL.test(url)

// Opened in a new tab, with your claude.ai login: claude.ai pages can't be shown inside Orrery.
export function openArtifact(url: string) {
  if (isArtifactUrl(url)) window.open(url, '_blank', 'noopener,noreferrer')
}
