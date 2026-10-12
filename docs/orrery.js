// Draws the Agent Orrery motif: the demo's five repositories as orbits, their agents as orbs
// coloured by what they're doing, and a message travelling between two of them.
// Used by the site's hero and by the banner and video cards in src/ (pass ?t=seconds to freeze a frame).
'use strict'
;(() => {
  const NS = 'http://www.w3.org/2000/svg'
  const COLOURS = {
    reading: '#3f7fae',
    writing: '#7d64a8',
    running: '#34955f',
    talking: '#b9822f',
    waiting: '#c0504a',
    finished: '#97a29f',
  }
  // Rooms from the demo data, inner to outer. Angles in degrees, periods in seconds per lap.
  const ROOMS = [
    { name: 'storefront-web', r: 112, period: 90, agents: [['writing', 20, 9], ['reading', 95, 6.5]] },
    { name: 'storefront-api', r: 176, period: 140, agents: [['waiting', -60, 9.5], ['talking', 95, 7]] },
    { name: 'mobile-app', r: 240, period: 200, agents: [['running', 205, 8.5], ['reading', 30, 6]] },
    { name: 'design-system', r: 304, period: 270, agents: [['waiting', 130, 9], ['finished', -20, 6]] },
    { name: 'infra', r: 368, period: 360, agents: [['waiting', 55, 9]] },
  ]
  // Colours come from the page's custom properties where it sets them, so the motif follows the theme.
  const STYLE = `
    .orrery-orbit { fill: none; stroke: var(--orrery-orbit, #34955f); stroke-opacity: 0.5; stroke-width: 1.4; stroke-linecap: round; stroke-dasharray: 0.34 0.66 }
    .orrery-label { fill: var(--orrery-label, #5b6763); font: italic 15px 'Instrument Serif', Georgia, serif; letter-spacing: 0.02em }
    .orrery-core-light { stop-color: var(--orrery-core-light, #46675e) }
    .orrery-core-mid { stop-color: var(--orrery-core, #162925) }
    .orrery-core-dark { stop-color: var(--orrery-core-dark, #0b1613) }
    .orrery-gap { fill: var(--orrery-ground, #f8f9fa) }
    .orrery-halo { fill: none; stroke-width: 1.5; opacity: calc(0.15 + var(--pulse, 0.5) * 0.55) }
    .orrery-message { stroke: #b9822f; stroke-width: 1.4; stroke-dasharray: 3 4; stroke-opacity: 0.7 }
    .orrery-packet { fill: #b9822f }
  `
  const MESSAGE = { from: [1, 1], to: [0, 0], seconds: 3.2 }

  const el = (name, attrs, parent) => {
    const node = document.createElementNS(NS, name)
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
    if (parent) parent.appendChild(node)
    return node
  }

  function mount(svg, { t = null, labels = true } = {}) {
    const id = `o${Math.random().toString(36).slice(2, 7)}`
    svg.setAttribute('viewBox', '-400 -400 800 800')
    el('style', {}, svg).textContent = STYLE
    const defs = el('defs', {}, svg)
    for (const [state, colour] of Object.entries(COLOURS)) {
      const gradient = el('radialGradient', { id: `${id}-${state}`, cx: '0.36', cy: '0.32', r: '0.75' }, defs)
      el('stop', { offset: '0', 'stop-color': '#fff', 'stop-opacity': '0.75' }, gradient)
      el('stop', { offset: '0.35', 'stop-color': colour }, gradient)
      el('stop', { offset: '1', 'stop-color': colour, 'stop-opacity': '0.85' }, gradient)
    }
    const core = el('radialGradient', { id: `${id}-core`, cx: '0.36', cy: '0.32', r: '0.75' }, defs)
    el('stop', { offset: '0', class: 'orrery-core-light' }, core)
    el('stop', { offset: '0.55', class: 'orrery-core-mid' }, core)
    el('stop', { offset: '1', class: 'orrery-core-dark' }, core)

    ROOMS.forEach((room, index) => {
      el('circle', { class: 'orrery-orbit', r: room.r, pathLength: Math.round(room.r / 4.4) * 2 }, svg)
      if (!labels) return
      // The label rides the left side of its orbit, reading upwards.
      const path = el('path', { id: `${id}-p${index}`, d: `M ${-room.r} 0 A ${room.r} ${room.r} 0 0 1 0 ${-room.r}`, fill: 'none' }, defs)
      const text = el('text', { class: 'orrery-label', dy: '-7' }, svg)
      const along = el('textPath', { href: `#${path.id}`, startOffset: `${8 + index * 3}%` }, text)
      along.textContent = room.name
    })
    const message = el('line', { class: 'orrery-message' }, svg)
    const packet = el('circle', { class: 'orrery-packet', r: 3.5 }, svg)
    el('circle', { r: 46, fill: `url(#${id}-core)` }, svg)
    const orbs = []
    ROOMS.forEach((room) => {
      for (const [state, angle, base] of room.agents) {
        const size = base * 1.3
        const group = el('g', {}, svg)
        if (state === 'waiting') el('circle', { class: 'orrery-halo', r: size + 6, stroke: COLOURS.waiting }, group)
        el('circle', { r: size + 3.5, class: 'orrery-gap' }, group)
        el('circle', { r: size, fill: `url(#${id}-${state})` }, group)
        orbs.push({ group, room, angle })
      }
    })
    const byRoom = (room, agent) => orbs.filter((orb) => orb.room === ROOMS[room])[agent]

    function frame(seconds) {
      const positions = new Map()
      for (const orb of orbs) {
        const radians = ((orb.angle + (seconds / orb.room.period) * 360) * Math.PI) / 180
        const x = Math.cos(radians) * orb.room.r
        const y = Math.sin(radians) * orb.room.r
        positions.set(orb, [x, y])
        orb.group.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`)
      }
      const [x1, y1] = positions.get(byRoom(...MESSAGE.from))
      const [x2, y2] = positions.get(byRoom(...MESSAGE.to))
      for (const [key, value] of Object.entries({ x1, y1, x2, y2 })) message.setAttribute(key, value.toFixed(2))
      const progress = (seconds % MESSAGE.seconds) / MESSAGE.seconds
      const eased = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2
      packet.setAttribute('cx', (x1 + (x2 - x1) * eased).toFixed(2))
      packet.setAttribute('cy', (y1 + (y2 - y1) * eased).toFixed(2))
      packet.setAttribute('opacity', Math.min(1, Math.sin(progress * Math.PI) * 3).toFixed(2))
      svg.style.setProperty('--pulse', (0.5 + 0.5 * Math.sin(seconds * 2.4)).toFixed(3))
    }

    if (t !== null) return frame(t)
    const still = matchMedia('(prefers-reduced-motion: reduce)')
    let start = null
    let request = 0
    const loop = (now) => {
      start ??= now - 40_000
      frame((now - start) / 1000)
      request = requestAnimationFrame(loop)
    }
    const update = () => {
      cancelAnimationFrame(request)
      if (still.matches) frame(40)
      else request = requestAnimationFrame(loop)
    }
    still.addEventListener('change', update)
    // Pause off screen, so the page costs nothing once you've scrolled past.
    new IntersectionObserver(([entry]) => (entry.isIntersecting ? update() : cancelAnimationFrame(request))).observe(svg)
    update()
  }

  window.Orrery = { mount, COLOURS }
})()
