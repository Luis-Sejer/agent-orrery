import AppKit

// The Agent Orrery mark for the menu bar: a dotted orbit around a core, with one planet
// riding the orbit. A template image, so macOS tints it for light and dark menu bars.
func orreryMark(size: CGFloat = 18) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
        let centre = NSPoint(x: rect.midX, y: rect.midY)
        let orbit = size * 0.40
        let planetAngle = CGFloat.pi / 4
        let planet = NSPoint(x: centre.x + cos(planetAngle) * orbit, y: centre.y + sin(planetAngle) * orbit)

        // The orbit leaves a gap around the planet, as the logo does.
        let ring = NSBezierPath()
        ring.appendArc(withCenter: centre, radius: orbit, startAngle: 72, endAngle: 378)
        ring.lineWidth = size * 0.075
        ring.lineCapStyle = .round
        ring.setLineDash([0, size * 0.155], count: 2, phase: 0)
        NSColor.black.setStroke()
        ring.stroke()

        NSColor.black.setFill()
        let core = size * 0.16
        NSBezierPath(ovalIn: NSRect(x: centre.x - core, y: centre.y - core, width: core * 2, height: core * 2)).fill()
        let moon = size * 0.105
        NSBezierPath(ovalIn: NSRect(x: planet.x - moon, y: planet.y - moon, width: moon * 2, height: moon * 2)).fill()
        return true
    }
    image.isTemplate = true
    return image
}
