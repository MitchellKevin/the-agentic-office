import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daylight, isNight, fmtHour, phaseName, hourOf, SUNRISE, SUNSET } from '../public/daylight.js';

test('day is light, night is dark, with the switch at sunrise and sunset', () => {
  assert.equal(isNight(SUNRISE - 0.01), true);
  assert.equal(isNight(SUNRISE), false);
  assert.equal(isNight(12), false);
  assert.equal(isNight(SUNSET - 0.01), false);
  assert.equal(isNight(SUNSET), true);
  assert.equal(isNight(0), true);
  assert.equal(isNight(24), true, '24:00 is midnight');
  assert.equal(isNight(-1), true, 'wraps around');
});

test('the sun is highest and whitest at noon, low and golden near sunset', () => {
  const noon = daylight(13), evening = daylight(18.6), morning = daylight(7.3);
  assert.ok(noon.env.lightDir[1] > evening.env.lightDir[1]);
  assert.ok(noon.env.lightDir[1] > morning.env.lightDir[1]);
  assert.ok(evening.golden > 0.6 && noon.golden < 0.05);
  // late-afternoon light is warmer (redder against blue) than midday light
  const warmth = (d) => d.env.sun[0] / d.env.sun[2];
  assert.ok(warmth(daylight(17.8)) > warmth(noon) + 0.3);
  // the sun moves: morning and afternoon shadows point different ways
  const am = daylight(9).env.lightDir, pm = daylight(17).env.lightDir;
  assert.ok(Math.sign(am[0]) !== Math.sign(pm[0]) || Math.sign(am[2]) !== Math.sign(pm[2]));
  for (const h of [7, 9.5, 13, 16, 18.99]) {
    const L = daylight(h).env.lightDir;
    assert.ok(Math.abs(Math.hypot(...L) - 1) < 1e-9, 'light direction is normalised');
    assert.ok(L[1] > 0.15, `sun stays above the horizon at ${h}`);
  }
});

test('night has the moon, stars and a twilight glow right after sunset', () => {
  const dusk = daylight(SUNSET + 0.1), midnight = daylight(1);
  assert.equal(dusk.sunGlow, null);
  assert.ok(midnight.stars > dusk.stars);
  assert.notEqual(dusk.sky.hor, midnight.sky.hor);
  assert.equal(daylight(3).sky.hor, '#26324f', 'deep night matches the original night sky');
  assert.equal(daylight(13).sky.hor, '#d4e6f4', 'midday matches the original day sky');
});

test('no jump at sunset or sunrise: light, sky and shadows meet in the middle', () => {
  const close = (a, b, tol, what) => a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < tol, `${what}[${i}]: ${x} vs ${b[i]}`));
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  for (const [before, after] of [[SUNSET - 0.01, SUNSET + 0.01], [SUNRISE - 0.01, SUNRISE + 0.01].reverse()]) {
    const a = daylight(before), b = daylight(after);
    assert.notEqual(a.night, b.night, 'this is the switch');
    close(a.env.sun, b.env.sun, 0.06, 'sun');
    close(a.env.sky, b.env.sky, 0.06, 'ambient');
    close(a.env.lightDir, b.env.lightDir, 0.15, 'lightDir');
    assert.ok(Math.abs(a.env.exposure - b.env.exposure) < 0.03);
    for (const k of ['top', 'mid', 'hor']) close(rgb(a.sky[k]), rgb(b.sky[k]), 30, `sky.${k}`);
    // sun has all but faded out, moon has barely come up
    const sunA = (a.sunGlow || b.sunGlow).alpha, moonA = a.moonAlpha || b.moonAlpha;
    assert.ok(sunA < 0.15 && moonA < 0.2, `sun ${sunA}, moon ${moonA}`);
  }
  // an hour into the day nothing of the night is left
  assert.equal(daylight(SUNRISE + 1).dusk, 0);
  assert.equal(daylight(SUNSET - 1).sunGlow.alpha, 1);
});

test('formatting helpers', () => {
  assert.equal(fmtHour(0), '00:00');
  assert.equal(fmtHour(14.5), '14:30');
  assert.equal(fmtHour(23.999), '00:00');
  assert.equal(fmtHour(24), '00:00');
  assert.equal(phaseName(13), 'Midday');
  assert.equal(phaseName(20), 'Evening');
  assert.equal(phaseName(SUNSET - 0.5), 'Sunset');
  assert.equal(hourOf(new Date(2026, 0, 1, 18, 45)), 18.75);
});
