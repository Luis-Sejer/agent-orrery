'use strict'

document.documentElement.classList.remove('no-js')

// The hero orrery. It stands still for people who prefer less motion (handled in orrery.js).
const orrery = document.getElementById('orrery')
if (orrery && window.Orrery) window.Orrery.mount(orrery)

// Copy buttons: copy the text of the element they point at, then say so for a moment.
const COPIED_MS = 1600
for (const button of document.querySelectorAll('[data-copy-from]')) {
  const label = button.textContent
  let timer = 0
  button.addEventListener('click', async () => {
    const text = document.getElementById(button.dataset.copyFrom).textContent
    try {
      await navigator.clipboard.writeText(text)
      button.textContent = 'Copied'
      button.dataset.copied = ''
    } catch {
      button.textContent = 'Select and copy'
    }
    clearTimeout(timer)
    timer = setTimeout(() => {
      button.textContent = label
      delete button.dataset.copied
    }, COPIED_MS)
  })
}

// Install tabs, with the arrow keys moving between them as in any tab list.
for (const tabs of document.querySelectorAll('[data-tabs]')) {
  const buttons = [...tabs.querySelectorAll('[role="tab"]')]
  const select = (chosen, focus) => {
    for (const button of buttons) {
      const selected = button === chosen
      button.setAttribute('aria-selected', String(selected))
      button.tabIndex = selected ? 0 : -1
      document.getElementById(button.getAttribute('aria-controls')).hidden = !selected
    }
    if (focus) chosen.focus()
  }
  buttons.forEach((button, index) => {
    button.addEventListener('click', () => select(button, false))
    button.addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key]
      if (step) select(buttons[(index + step + buttons.length) % buttons.length], true)
      else if (event.key === 'Home') select(buttons[0], true)
      else if (event.key === 'End') select(buttons.at(-1), true)
      else return
      event.preventDefault()
    })
  })
  select(buttons.find((button) => button.getAttribute('aria-selected') === 'true') ?? buttons[0], false)
}
