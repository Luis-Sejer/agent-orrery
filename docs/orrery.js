// Draws the Agent Orrery motif: the demo's five repositories as orbits, their agents as orbs
// drawn with thinking-orbs and coloured by what they're doing, and messages travelling between rooms.
// Used by the site's hero and by the banner and video cards in src/ (pass ?t=seconds to freeze a frame).
// Orrery.orbs() paints single orbs, such as the site's legend, the same way.
'use strict'
;(() => {
  const NS = 'http://www.w3.org/2000/svg'
  const ENGINE = new URL('vendor/thinking-orbs-0.3.2.js', document.currentScript.src)
  // The same thinking-orbs states the app gives each kind of work.
  const ORB_STATES = { reading: 'searching', writing: 'composing', running: 'working', talking: 'connecting', waiting: 'listening', finished: 'breathing' }
  const ORB_PRESET = 64
  // How far an orb reaches, in multiples of its sphere's radius; the dotted orbs need more room than a solid sphere.
  const ORB_REACH = 1.7
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
  // [room, agent] pairs. Two lanes take turns through the list, so the talk moves around the rooms.
  const MESSAGES = [
    [[1, 1], [0, 0]],
    [[2, 0], [4, 0]],
    [[0, 1], [2, 1]],
    [[3, 0], [1, 1]],
    [[2, 1], [0, 0]],
    [[4, 0], [1, 0]],
  ]
  const MESSAGE_SECONDS = 3.2
  const LANES = 2

  const dark = matchMedia('(prefers-color-scheme: dark)')
  let engine = null
  const loadEngine = () => (engine ??= import(ENGINE))

  // One orb's painter: draws its state at ORB_PRESET pixels into whatever transform the context has.
  function orbPainter({ M: MODE_FRAMES, r: resolvePreset, a: scaleRadii, p: paintFrame }, state, dotScale, speed) {
    const { mode, speed: base, opts } = resolvePreset(ORB_STATES[state], ORB_PRESET)
    const frameFor = MODE_FRAMES[mode]
    const scaled = scaleRadii(opts, dotScale)
    // Finished orbs hold still, as they do in the app.
    return (context, seconds, tint) =>
      paintFrame(context, frameFor(ORB_PRESET, state === 'finished' ? 0.6 : seconds * base * speed, scaled), dark.matches, tint)
  }

  const toTint = (hex) => {
    const [r, g, b] = hex.trim().match(/[\da-f]{2}/gi).map((pair) => parseInt(pair, 16))
    return { r, g, b }
  }

  // Sizes a canvas's backing store to its box, and returns its context scaled to CSS pixels.
  function fit(canvas) {
    const ratio = Math.min(2, devicePixelRatio || 1)
    const { clientWidth: width, clientHeight: height } = canvas
    if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio)
    if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio)
    const context = canvas.getContext('2d')
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)
    return { context, width, height, ratio }
  }

  // Runs frame(seconds) every animation frame while target is on screen, or once for reduced motion.
  function animate(frame, target) {
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
    new IntersectionObserver(([entry]) => (entry.isIntersecting ? update() : cancelAnimationFrame(request))).observe(target)
    update()
  }

  // Paints a live orb into each <canvas data-orb="state">, in the colour of its --orb property.
  // The canvas keeps its CSS look until the engine has loaded, and keeps it if the engine never does.
  function orbs(canvases, { dotScale = 2.2 } = {}) {
    if (canvases.length === 0) return
    loadEngine().then((loaded) => {
      const items = [...canvases].map((canvas, index) => {
        canvas.classList.add('is-live')
        return { canvas, paint: orbPainter(loaded, canvas.dataset.orb, dotScale, 0.8 + ((index * 0.37) % 0.4)) }
      })
      animate((seconds) => {
        for (const { canvas, paint } of items) {
          const { context, width } = fit(canvas)
          context.scale(width / ORB_PRESET, width / ORB_PRESET)
          paint(context, seconds, toTint(getComputedStyle(canvas).getPropertyValue('--orb')))
        }
      }, canvases[0].parentElement.parentElement)
    }, () => {})
  }

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
    const lanes = Array.from({ length: LANES }, () => ({
      line: el('line', { class: 'orrery-message' }, svg),
      packet: el('circle', { class: 'orrery-packet', r: 3.5 }, svg),
    }))
    el('circle', { r: 46, fill: `url(#${id}-core)` }, svg)
    const agents = []
    ROOMS.forEach((room) => {
      for (const [state, angle, base] of room.agents) {
        const size = base * 1.3
        const group = el('g', {}, svg)
        if (state === 'waiting') el('circle', { class: 'orrery-halo', r: size * ORB_REACH + 5, stroke: COLOURS.waiting }, group)
        el('circle', { r: size * ORB_REACH + 2, class: 'orrery-gap' }, group)
        // A plain sphere until the orb engine has loaded, and if it never does.
        const sphere = el('circle', { r: size, fill: `url(#${id}-${state})` }, group)
        agents.push({ group, sphere, room, angle, state, size, tint: toTint(COLOURS[state]), speed: 0.75 + ((agents.length * 0.37) % 0.5) })
      }
    })
    const byRoom = (room, agent) => agents.filter((orb) => orb.room === ROOMS[room])[agent]

    // The orbs are painted on a canvas laid over the SVG; it takes the SVG's classes so it gets the same box.
    const canvas = document.createElement('canvas')
    canvas.setAttribute('class', svg.getAttribute('class') ?? '')
    canvas.setAttribute('aria-hidden', 'true')
    canvas.style.pointerEvents = 'none'
    svg.after(canvas)
    let paintOrbs = null
    let positions = new Map()
    let lastSeconds = 0
    loadEngine().then((loaded) => {
      for (const orb of agents) {
        orb.paint = orbPainter(loaded, orb.state, 2, orb.speed)
        orb.sphere.remove()
      }
      paintOrbs = (seconds) => {
        const { context, width, height, ratio } = fit(canvas)
        const unit = Math.min(width, height) / 800
        for (const orb of agents) {
          const [x, y] = positions.get(orb)
          const scale = (orb.size * 2 * ORB_REACH * unit) / ORB_PRESET
          context.setTransform(ratio * scale, 0, 0, ratio * scale, ratio * (width / 2 + x * unit), ratio * (height / 2 + y * unit))
          context.translate(-ORB_PRESET / 2, -ORB_PRESET / 2)
          orb.paint(context, seconds, orb.tint)
        }
      }
      paintOrbs(lastSeconds)
    }, () => {})

    function frame(seconds) {
      positions = new Map()
      lastSeconds = seconds
      for (const orb of agents) {
        const radians = ((orb.angle + (seconds / orb.room.period) * 360) * Math.PI) / 180
        const x = Math.cos(radians) * orb.room.r
        const y = Math.sin(radians) * orb.room.r
        positions.set(orb, [x, y])
        orb.group.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`)
      }
      lanes.forEach(({ line, packet }, lane) => {
        const shifted = seconds + (lane * MESSAGE_SECONDS) / LANES
        const turn = Math.floor(shifted / MESSAGE_SECONDS)
        const [from, to] = MESSAGES[(turn * LANES + lane) % MESSAGES.length]
        const [x1, y1] = positions.get(byRoom(...from))
        const [x2, y2] = positions.get(byRoom(...to))
        for (const [key, value] of Object.entries({ x1, y1, x2, y2 })) line.setAttribute(key, value.toFixed(2))
        const progress = (shifted % MESSAGE_SECONDS) / MESSAGE_SECONDS
        const eased = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2
        const visible = Math.min(1, Math.sin(progress * Math.PI) * 3).toFixed(2)
        line.setAttribute('opacity', visible)
        packet.setAttribute('cx', (x1 + (x2 - x1) * eased).toFixed(2))
        packet.setAttribute('cy', (y1 + (y2 - y1) * eased).toFixed(2))
        packet.setAttribute('opacity', visible)
      })
      paintOrbs?.(seconds)
      svg.style.setProperty('--pulse', (0.5 + 0.5 * Math.sin(seconds * 2.4)).toFixed(3))
    }

    if (t !== null) return frame(t)
    animate(frame, svg)
  }

  window.Orrery = { mount, orbs, COLOURS }
})()
