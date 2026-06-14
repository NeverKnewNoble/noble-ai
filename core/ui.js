import chalk from "chalk"

// ─── Brand palette ────────────────────────────────────────────────────────────
// A 3-stop gradient — cyan → periwinkle → soft violet — used for the logo, panel
// accents, and anywhere we want a premium, non-flat look. Tweak these to reskin
// the whole UI.
export const BRAND = ["#4FC3F7", "#6AA9FF", "#9D7CFF"]

export const c = {
  primary: chalk.hex(BRAND[0]),
  accent: chalk.hex(BRAND[1]),
  violet: chalk.hex(BRAND[2]),
  label: chalk.hex("#7C8AA5"),   // muted slate for labels
  value: chalk.hex("#E6EDF3"),   // near-white for values
  dim: chalk.hex("#5A6577"),
  faint: chalk.hex("#3C4453")
}

function hexToRgb(hex) {
  const h = hex.replace("#", "")
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t)
}

// Sample a multi-stop gradient at position t ∈ [0,1] → "#rrggbb".
export function sampleGradient(stops, t) {
  if (t <= 0) return stops[0]
  if (t >= 1) return stops[stops.length - 1]
  const seg = t * (stops.length - 1)
  const i = Math.floor(seg)
  const lt = seg - i
  const [r1, g1, b1] = hexToRgb(stops[i])
  const [r2, g2, b2] = hexToRgb(stops[i + 1])
  return "#" + [lerp(r1, r2, lt), lerp(g1, g2, lt), lerp(b1, b2, lt)]
    .map(v => v.toString(16).padStart(2, "0")).join("")
}

// Color a string left-to-right along the gradient. `width` lets several lines
// share one horizontal gradient (pass the widest line's length) so a stacked
// logo gets a consistent diagonal sheen.
export function gradient(text, stops = BRAND, width = text.length) {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === " ") { out += ch; continue }
    out += chalk.hex(sampleGradient(stops, width > 1 ? i / (width - 1) : 0))(ch)
  }
  return out
}
