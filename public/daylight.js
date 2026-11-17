// Time of day → light. Pure functions (no DOM), so they can be tested in Node.
//
// Day runs from SUNRISE to SUNSET: the UI is light and the city is in daylight. Outside that
// it is night: dark UI, stars, lit windows and street lamps. Within a day the sun moves from
// east to west, and it is warm and low around sunrise and sunset ("golden hour"). Just after
// sunset and just before sunrise the night sky keeps a twilight glow on the horizon.

export const SUNRISE = 7;
export const SUNSET = 19;
const TWILIGHT = 1.25; // hours of afterglow on each side of the night
const DUSK = 0.9;      // hours before sunset / after sunrise in which the day fades towards night
const DUSK_BLEND = 0.9; // how far the day goes towards the night's edge values right at sunset
const MOON_DIR = [-0.5 / Math.hypot(-0.5, 1, 0.7), 1 / Math.hypot(-0.5, 1, 0.7), 0.7 / Math.hypot(-0.5, 1, 0.7)];
// Light at the edge of the night (right after sunset / right before sunrise). Day and night both
// meet these values at the switch, so the light is continuous across it.
const EDGE = {
  sky: { top: '#141a3c', mid: '#43305e', hor: '#8a4f5c' },
  sun: [0.42, 0.36, 0.48], ambient: [0.22, 0.19, 0.3], ground: [0.1, 0.09, 0.11],
  bloom: 0.68, exposure: 1.02, vignette: 0.29, threshold: 1.0,
};

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };

function hex(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function toHex(c) { return '#' + c.map((x) => Math.round(clamp(x, 0, 255)).toString(16).padStart(2, '0')).join(''); }
const mixHex = (a, b, t) => toHex(mix3(hex(a), hex(b), t));
const srgbToLin = (c) => c.map((x) => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });

/** Hours (0–24, fractional) for a Date, in local time. */
export function hourOf(date = new Date()) {
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

export function isNight(hour) {
  const h = ((hour % 24) + 24) % 24;
  return h < SUNRISE || h >= SUNSET;
}

/** "14:30" */
export function fmtHour(hour) {
  const h = ((hour % 24) + 24) % 24;
  let hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  if (mm === 60) { hh = (hh + 1) % 24; mm = 0; }
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function phaseName(hour) {
  const h = ((hour % 24) + 24) % 24;
  if (h < 5) return 'Night';
  if (h < SUNRISE) return 'Before dawn';
  if (h < 8.5) return 'Sunrise';
  if (h < 12) return 'Morning';
  if (h < 14) return 'Midday';
  if (h < 17.5) return 'Afternoon';
  if (h < SUNSET) return 'Sunset';
  if (h < 22) return 'Evening';
  return 'Night';
}

/**
 * Everything the renderer needs for one moment of the day.
 * `env` is in linear light (like Renderer env), `sky` is sRGB hex for the sky-dome canvas.
 */
export function daylight(hour) {
  const h = ((hour % 24) + 24) % 24;
  const night = isNight(h);
  if (!night) {
    const a = (h - SUNRISE) / (SUNSET - SUNRISE);           // 0 at sunrise, 1 at sunset
    const height = Math.sin(a * Math.PI);                    // 0 at the horizon, 1 at noon
    const golden = 1 - smooth(0.05, 0.55, height);          // 1 when the sun is low
    const strength = 0.55 + 0.45 * smooth(0, 0.35, height);
    // Elevation stays above ~10° so shadows never stretch across the whole city.
    const elev = 0.18 + 0.82 * height;
    // Noon matches the original light direction; the sun sweeps from east to west.
    const az = 2.19 + (a - 0.5) * Math.PI * 0.9;
    const sunDir = norm([Math.cos(elev) * Math.cos(az), Math.sin(elev), Math.cos(elev) * Math.sin(az)]);
    // Dusk: in the last stretch before sunset (and the first after sunrise) everything slides
    // towards the values the night starts with, so the switch to night has almost nothing left
    // to jump. 1 right at sunset/sunrise, 0 from DUSK hours inside the day.
    const dusk = 1 - smooth(0, DUSK, Math.min(h - SUNRISE, SUNSET - h));
    const k = dusk * DUSK_BLEND;
    const sky = {
      top: mixHex(mixHex('#2f6fc0', '#3b4e8c', golden), EDGE.sky.top, k),
      mid: mixHex(mixHex('#7fb3e6', '#e7a07a', golden), EDGE.sky.mid, k),
      hor: mixHex(mixHex('#d4e6f4', '#ffcf94', golden), EDGE.sky.hor, k),
    };
    return {
      hour: h, night, golden, dusk, stars: 0, sky,
      env: {
        sun: mix3(mix3([1.15, 1.06, 0.92], [1.3, 0.74, 0.42], golden).map((x) => x * strength), EDGE.sun, k),
        sky: mix3(mix3([0.6, 0.64, 0.72], [0.48, 0.44, 0.52], golden), EDGE.ambient, k),
        ground: mix3(mix3([0.32, 0.3, 0.26], [0.3, 0.22, 0.18], golden), EDGE.ground, k),
        // shadows swing round to where the moon will be
        lightDir: norm(mix3(sunDir, MOON_DIR, k)),
        fog: srgbToLin(hex(sky.hor)), clear: srgbToLin(hex(sky.hor)),
        bloom: mix(mix(0.45, 0.6, golden), EDGE.bloom, k), exposure: mix(mix(0.82, 0.9, golden), EDGE.exposure, k),
        vignette: mix(mix(0.2, 0.26, golden), EDGE.vignette, k), threshold: mix(mix(1.35, 1.15, golden), EDGE.threshold, k),
      },
      sunGlow: { color: mix3([3, 2.8, 2.3], [3.2, 1.9, 1.0], golden), halo: mix3([1, 0.9, 0.7], [1, 0.6, 0.35], golden), size: mix(60, 80, golden), alpha: 1 - k },
      moonAlpha: 0,
    };
  }
  // Night: how close are we to sunset or sunrise? 1 right at the edge, 0 in the middle of the night.
  const sinceSunset = h >= SUNSET ? h - SUNSET : h + 24 - SUNSET;
  const toSunrise = h < SUNRISE ? SUNRISE - h : SUNRISE + 24 - h;
  const twilight = Math.max(1 - smooth(0, TWILIGHT, sinceSunset), 1 - smooth(0, TWILIGHT, toSunrise));
  const sky = {
    top: mixHex('#060a1c', EDGE.sky.top, twilight),
    mid: mixHex('#16224a', EDGE.sky.mid, twilight),
    hor: mixHex('#26324f', EDGE.sky.hor, twilight),
  };
  return {
    hour: h, night, golden: 0, dusk: twilight, stars: 1 - twilight * 0.7, sky,
    env: {
      sun: mix3([0.32, 0.36, 0.5], EDGE.sun, twilight),
      sky: mix3([0.16, 0.18, 0.28], EDGE.ambient, twilight),
      ground: mix3([0.06, 0.06, 0.08], EDGE.ground, twilight),
      lightDir: MOON_DIR, fog: srgbToLin(hex(sky.hor)), clear: srgbToLin(hex(sky.hor)),
      bloom: mix(0.7, EDGE.bloom, twilight), exposure: mix(1.1, EDGE.exposure, twilight),
      vignette: mix(0.3, EDGE.vignette, twilight), threshold: mix(0.95, EDGE.threshold, twilight),
    },
    sunGlow: null, // the moon is drawn instead; it rises out of the twilight
    moonAlpha: 0.95 * (1 - twilight * 0.85),
  };
}
