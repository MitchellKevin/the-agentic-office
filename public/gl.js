// A tiny WebGL2 renderer, written for Agent Office. No dependencies.
// Features: shared primitive meshes, node hierarchy, hemisphere + sun lighting,
// PCF shadow map, emissive / unlit / textured materials, additive billboards, fog.

// ---------------- math (column-major 4x4) ----------------
export const m4 = {
  create() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
  mul(out, a, b) {
    const r = out === a || out === b ? new Float32Array(16) : out;
    for (let c = 0; c < 4; c++) {
      for (let row = 0; row < 4; row++) {
        r[c * 4 + row] = a[row] * b[c * 4] + a[4 + row] * b[c * 4 + 1] + a[8 + row] * b[c * 4 + 2] + a[12 + row] * b[c * 4 + 3];
      }
    }
    if (r !== out) out.set(r);
    return out;
  },
  perspective(out, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    out.fill(0);
    out[0] = f / aspect; out[5] = f; out[10] = (far + near) * nf; out[11] = -1; out[14] = 2 * far * near * nf;
    return out;
  },
  ortho(out, l, r, b, t, n, f) {
    out.fill(0);
    out[0] = 2 / (r - l); out[5] = 2 / (t - b); out[10] = -2 / (f - n);
    out[12] = -(r + l) / (r - l); out[13] = -(t + b) / (t - b); out[14] = -(f + n) / (f - n); out[15] = 1;
    return out;
  },
  lookAt(out, eye, target, up) {
    let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    let len = Math.hypot(zx, zy, zz) || 1; zx /= len; zy /= len; zz /= len;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    len = Math.hypot(xx, xy, xz) || 1; xx /= len; xy /= len; xz /= len;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
    out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    out[15] = 1;
    return out;
  },
  // T * Ry * Rx * Rz * S
  compose(out, p, r, s) {
    const cx = Math.cos(r[0]), sx = Math.sin(r[0]);
    const cy = Math.cos(r[1]), sy = Math.sin(r[1]);
    const cz = Math.cos(r[2]), sz = Math.sin(r[2]);
    // R = Ry*Rx*Rz
    const m00 = cy * cz + sy * sx * sz, m01 = -cy * sz + sy * sx * cz, m02 = sy * cx;
    const m10 = cx * sz, m11 = cx * cz, m12 = -sx;
    const m20 = -sy * cz + cy * sx * sz, m21 = sy * sz + cy * sx * cz, m22 = cy * cx;
    out[0] = m00 * s[0]; out[1] = m10 * s[0]; out[2] = m20 * s[0]; out[3] = 0;
    out[4] = m01 * s[1]; out[5] = m11 * s[1]; out[6] = m21 * s[1]; out[7] = 0;
    out[8] = m02 * s[2]; out[9] = m12 * s[2]; out[10] = m22 * s[2]; out[11] = 0;
    out[12] = p[0]; out[13] = p[1]; out[14] = p[2]; out[15] = 1;
    return out;
  },
  // inverse-transpose of the upper 3x3 → mat3 (for normals)
  normal(out, m) {
    const a00 = m[0], a01 = m[1], a02 = m[2], a10 = m[4], a11 = m[5], a12 = m[6], a20 = m[8], a21 = m[9], a22 = m[10];
    const b01 = a22 * a11 - a12 * a21, b11 = -a22 * a10 + a12 * a20, b21 = a21 * a10 - a11 * a20;
    let det = a00 * b01 + a01 * b11 + a02 * b21;
    det = det ? 1 / det : 0;
    out[0] = b01 * det; out[3] = (-a22 * a01 + a02 * a21) * det; out[6] = (a12 * a01 - a02 * a11) * det;
    out[1] = b11 * det; out[4] = (a22 * a00 - a02 * a20) * det; out[7] = (-a12 * a00 + a02 * a10) * det;
    out[2] = b21 * det; out[5] = (-a21 * a00 + a01 * a20) * det; out[8] = (a11 * a00 - a01 * a10) * det;
    return out;
  },
  transform(m, x, y, z) {
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, (m[2] * x + m[6] * y + m[10] * z + m[14]) / w, w];
  },
};

// ---------------- colours ----------------
const parseCtx = document.createElement('canvas').getContext('2d');
const colorCache = new Map();
/** Any CSS colour → linear RGB [r,g,b] (0..1). */
export function lin(css) {
  if (Array.isArray(css)) return css;
  let c = colorCache.get(css);
  if (c) return c;
  parseCtx.fillStyle = '#000';
  parseCtx.fillStyle = css;
  const v = parseCtx.fillStyle;
  let r = 0, g = 0, b = 0;
  if (v.startsWith('#')) { const n = parseInt(v.slice(1), 16); r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255; }
  else { const m = v.match(/[\d.]+/g); if (m) [r, g, b] = m.map(Number); }
  const f = (x) => Math.pow(x / 255, 2.2);
  c = [f(r), f(g), f(b)];
  colorCache.set(css, c);
  return c;
}
export function scale3(c, k) { return [c[0] * k, c[1] * k, c[2] * k]; }
export function mix3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

// ---------------- geometry ----------------
export const STRIDE = 11;
function pushQuad(v, idx, p0, p1, p2, p3, n) {
  const base = v.length / STRIDE;
  const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
  [p0, p1, p2, p3].forEach((p, i) => v.push(p[0], p[1], p[2], n[0], n[1], n[2], uvs[i][0], uvs[i][1], 1, 1, 1));
  idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

export const geo = {
  box() {
    const v = [], i = [], h = 0.5;
    pushQuad(v, i, [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h], [0, 0, 1]);
    pushQuad(v, i, [h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h], [0, 0, -1]);
    pushQuad(v, i, [h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h], [1, 0, 0]);
    pushQuad(v, i, [-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h], [-1, 0, 0]);
    pushQuad(v, i, [-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h], [0, 1, 0]);
    pushQuad(v, i, [-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h], [0, -1, 0]);
    return { v, i };
  },
  plane() { // XY plane facing +z, 1x1
    const v = [], i = [];
    pushQuad(v, i, [-0.5, -0.5, 0], [0.5, -0.5, 0], [0.5, 0.5, 0], [-0.5, 0.5, 0], [0, 0, 1]);
    return { v, i };
  },
  sphere(seg = 14, rings = 10, thetaMax = Math.PI) {
    const v = [], i = [];
    for (let r = 0; r <= rings; r++) {
      const th = (r / rings) * thetaMax;
      for (let s = 0; s <= seg; s++) {
        const ph = (s / seg) * Math.PI * 2;
        const x = Math.sin(th) * Math.cos(ph), y = Math.cos(th), z = Math.sin(th) * Math.sin(ph);
        v.push(x, y, z, x, y, z, s / seg, r / rings, 1, 1, 1);
      }
    }
    for (let r = 0; r < rings; r++) for (let s = 0; s < seg; s++) {
      const a = r * (seg + 1) + s, b = a + seg + 1;
      i.push(a, a + 1, b, b, a + 1, b + 1);
    }
    return { v, i };
  },
  cylinder(seg = 14) { // radius 1, height 1, centred
    const v = [], i = [];
    for (let s = 0; s <= seg; s++) {
      const ph = (s / seg) * Math.PI * 2, x = Math.cos(ph), z = Math.sin(ph);
      v.push(x, -0.5, z, x, 0, z, s / seg, 0, 1, 1, 1, x, 0.5, z, x, 0, z, s / seg, 1, 1, 1, 1);
    }
    for (let s = 0; s < seg; s++) { const a = s * 2; i.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
    for (const y of [0.5, -0.5]) {
      const c = v.length / STRIDE; v.push(0, y, 0, 0, Math.sign(y), 0, 0.5, 0.5, 1, 1, 1);
      for (let s = 0; s <= seg; s++) {
        const ph = (s / seg) * Math.PI * 2;
        v.push(Math.cos(ph), y, Math.sin(ph), 0, Math.sign(y), 0, 0, 0, 1, 1, 1);
      }
      for (let s = 0; s < seg; s++) y > 0 ? i.push(c, c + s + 2, c + s + 1) : i.push(c, c + s + 1, c + s + 2);
    }
    return { v, i };
  },
};

// ---------------- static batching ----------------
/**
 * Merges many transformed primitives into one mesh with baked vertex colours, so a whole city
 * costs a single draw call. uvMode 'facade' scales box UVs by face size (tileW x tileH metres per tile).
 */
export class MeshBuilder {
  constructor(renderer, { tileW = 8, tileH = 14 } = {}) {
    this.r = renderer; this.tileW = tileW; this.tileH = tileH;
    this.v = []; this.i = [];
    this.m = new Float32Array(16); this.nm = new Float32Array(9);
  }
  get empty() { return this.i.length === 0; }
  add(kind, pos, rot, scl, color, uvMode = null) {
    const g = this.r.geos[kind];
    const m = m4.compose(this.m, pos, rot, scl), nm = m4.normal(this.nm, m);
    const base = this.v.length / STRIDE;
    const gv = g.v, out = this.v;
    const [cr, cg, cb] = color;
    for (let k = 0; k < gv.length; k += STRIDE) {
      const x = gv[k], y = gv[k + 1], z = gv[k + 2], a = gv[k + 3], b = gv[k + 4], c = gv[k + 5];
      let nx = nm[0] * a + nm[3] * b + nm[6] * c, ny = nm[1] * a + nm[4] * b + nm[7] * c, nz = nm[2] * a + nm[5] * b + nm[8] * c;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      let u = gv[k + 6], v = gv[k + 7];
      if (uvMode === 'facade') {
        if (Math.abs(a) > 0.5) { u *= scl[2] / this.tileW; v *= scl[1] / this.tileH; }
        else if (Math.abs(c) > 0.5) { u *= scl[0] / this.tileW; v *= scl[1] / this.tileH; }
        else { u *= scl[0] / this.tileW; v *= scl[2] / this.tileW; }
      }
      out.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14], nx, ny, nz, u, v, cr, cg, cb);
    }
    for (const idx of g.i) this.i.push(base + idx);
    return this;
  }
  box(color, x, y, z, w, h, d, rot = [0, 0, 0], uvMode = null) { return this.add('box', [x, y, z], rot, [w, h, d], color, uvMode); }
  cyl(color, x, y, z, r, h, rot = [0, 0, 0], low = true) { return this.add(low ? 'lowCyl' : 'cyl', [x, y, z], rot, [r, h, r], color); }
  ball(color, x, y, z, rx, ry = rx, rz = rx, low = true) { return this.add(low ? 'lowSphere' : 'sphere', [x, y, z], [0, 0, 0], [rx, ry, rz], color); }
  build() { return this.r.upload({ v: new Float32Array(this.v), i: new Uint32Array(this.i) }); }
}

// ---------------- scene graph ----------------
export class Node {
  constructor(mesh = null, mat = null) {
    this.mesh = mesh; this.mat = mat;
    this.pos = [0, 0, 0]; this.rot = [0, 0, 0]; this.scl = [1, 1, 1];
    this.children = []; this.visible = true;
    this.local = m4.create(); this.world = m4.create();
  }
  add(...nodes) { for (const n of nodes) { n.parent?.remove(n); n.parent = this; this.children.push(n); } return this; }
  remove(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.parent = null; return this; }
  detach() { this.parent?.remove(this); return this; }
  at(x, y, z) { this.pos = [x, y, z]; return this; }
  size(x, y, z) { this.scl = [x, y, z]; return this; }
  turn(x, y, z) { this.rot = [x, y, z]; return this; }
  update(parent) {
    m4.compose(this.local, this.pos, this.rot, this.scl);
    if (parent) m4.mul(this.world, parent, this.local); else this.world.set(this.local);
    for (const c of this.children) c.update(this.world);
  }
  collect(out) {
    if (!this.visible) return;
    if (this.mesh && this.mat) out.push(this);
    for (const c of this.children) c.collect(out);
  }
}

// ---------------- shaders ----------------
const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNor;
layout(location=2) in vec2 aUV;
layout(location=3) in vec3 aCol;
uniform mat4 uModel, uVP, uLightVP;
uniform mat3 uNM;
out vec3 vN; out vec3 vW; out vec2 vUV; out vec4 vSh; out vec3 vCol;
void main(){
  vec4 w = uModel * vec4(aPos,1.0);
  vW = w.xyz; vN = uNM * aNor; vUV = aUV; vSh = uLightVP * w; vCol = aCol;
  gl_Position = uVP * w;
}`;
const FS = `#version 300 es
precision highp float;
precision highp sampler2DShadow;
in vec3 vN; in vec3 vW; in vec2 vUV; in vec4 vSh; in vec3 vCol;
uniform vec3 uColor, uEmissive, uLightDir, uSun, uSky, uGround, uFog, uCam;
uniform vec2 uFogRange, uUvOff, uUvScale;
uniform float uAlpha, uUnlit, uUseTex, uShadowOn, uTexel, uRound, uNoFog, uSpec, uShine, uPost, uExposure, uTexEmit;
uniform sampler2D uTex;
uniform sampler2DShadow uShadow;
out vec4 o;
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
float shadow(){
  vec3 p = vSh.xyz / vSh.w * 0.5 + 0.5;
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0 || p.z > 1.0) return 1.0;
  float s = 0.0;
  for (int x=-1; x<=1; x++) for (int y=-1; y<=1; y++)
    s += texture(uShadow, vec3(p.xy + vec2(x,y)*uTexel, p.z - 0.0015));
  return s / 9.0;
}
void main(){
  vec3 base = uColor * vCol;
  float a = uAlpha;
  vec3 texEmit = vec3(0.0);
  if (uUseTex > 0.5) { vec4 t = texture(uTex, vUV * uUvScale + uUvOff); base *= t.rgb; a *= t.a; texEmit = t.rgb * vCol * uTexEmit; }
  if (uRound > 0.5) { float d = length(vUV - 0.5) * 2.0; a *= clamp(1.0 - d, 0.0, 1.0); a *= a; }
  vec3 col;
  if (uUnlit > 0.5) col = base + uEmissive;
  else {
    vec3 n = normalize(vN);
    vec3 V = normalize(uCam - vW);
    if (dot(n, V) < 0.0 && a < 1.0) n = -n;            // two-sided glass
    float ndl = max(dot(n, uLightDir), 0.0);
    float sh = uShadowOn > 0.5 ? shadow() : 1.0;
    vec3 hemi = mix(uGround, uSky, n.y * 0.5 + 0.5);
    vec3 Hh = normalize(uLightDir + V);
    float spec = uSpec * pow(max(dot(n, Hh), 0.0), uShine) * ndl * sh * (uShine + 8.0) / 25.0;
    float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
    col = base * (hemi + uSun * ndl * sh) + uSun * spec + uSky * rim * 0.18 + uEmissive + texEmit;
    a = min(1.0, a + spec * 0.5);
  }
  float f = uNoFog > 0.5 ? 0.0 : smoothstep(uFogRange.x, uFogRange.y, distance(vW, uCam));
  col = mix(col, uFog, f);
  if (uPost > 0.5) o = vec4(max(col, 0.0), a);
  else o = vec4(pow(aces(max(col, 0.0) * uExposure), vec3(1.0/2.2)), a);
}`;
const SVS = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uModel, uLightVP;
void main(){ gl_Position = uLightVP * uModel * vec4(aPos,1.0); }`;
const SFS = `#version 300 es
precision mediump float;
out vec4 o; void main(){ o = vec4(1.0); }`;

const FSQ = `#version 300 es
out vec2 vUV;
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUV = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
const BRIGHT = `#version 300 es
precision highp float;
in vec2 vUV; uniform sampler2D uTex; uniform float uThreshold; out vec4 o;
void main(){
  vec2 t = 1.0 / vec2(textureSize(uTex, 0));
  vec3 c = (texture(uTex, vUV + t * vec2(-0.5)).rgb + texture(uTex, vUV + t * vec2(0.5)).rgb + texture(uTex, vUV + t * vec2(0.5, -0.5)).rgb + texture(uTex, vUV + t * vec2(-0.5, 0.5)).rgb) * 0.25;
  float l = max(c.r, max(c.g, c.b));
  float k = smoothstep(uThreshold, uThreshold + 0.5, l);
  o = vec4(c * k, 1.0);
}`;
const BLUR = `#version 300 es
precision highp float;
in vec2 vUV; uniform sampler2D uTex; uniform vec2 uDir; out vec4 o;
void main(){
  vec3 c = texture(uTex, vUV).rgb * 0.227027;
  c += (texture(uTex, vUV + uDir * 1.3846).rgb + texture(uTex, vUV - uDir * 1.3846).rgb) * 0.316216;
  c += (texture(uTex, vUV + uDir * 3.2307).rgb + texture(uTex, vUV - uDir * 3.2307).rgb) * 0.070270;
  o = vec4(c, 1.0);
}`;
const COMPOSITE = `#version 300 es
precision highp float;
in vec2 vUV; uniform sampler2D uScene, uB1, uB2; uniform float uBloom, uExposure, uVignette; out vec4 o;
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
void main(){
  vec3 c = texture(uScene, vUV).rgb;
  c += (texture(uB1, vUV).rgb * 0.6 + texture(uB2, vUV).rgb * 1.0) * uBloom;
  c = aces(c * uExposure);
  float d = distance(vUV, vec2(0.5));
  c *= 1.0 - uVignette * smoothstep(0.4, 0.95, d);
  o = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
}`;

function compile(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let k = 0; k < n; k++) { const info = gl.getActiveUniform(p, k); u[info.name] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

// ---------------- renderer ----------------
export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl; this.canvas = canvas;
    this.main = compile(gl, VS, FS);
    this.depth = compile(gl, SVS, SFS);
    this.hdr = !!gl.getExtension('EXT_color_buffer_float');
    try {
      this.pp = { bright: compile(gl, FSQ, BRIGHT), blur: compile(gl, FSQ, BLUR), comp: compile(gl, FSQ, COMPOSITE) };
      this.emptyVao = gl.createVertexArray();
    } catch (e) { console.warn('post-processing disabled:', e.message); this.pp = null; }
    this.targets = null;
    this.meshes = {};
    this.geos = { box: geo.box(), plane: geo.plane(), sphere: geo.sphere(), cyl: geo.cylinder(), hemi: geo.sphere(14, 6, Math.PI * 0.56), lowSphere: geo.sphere(8, 6), lowCyl: geo.cylinder(8) };
    for (const [k, g] of Object.entries(this.geos)) {
      this.meshes[k] = this.upload(g);
    }
    this.shadowSize = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    this.shadowTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, this.shadowSize, this.shadowSize);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    this.shadowFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTex, 0);
    gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.white = this.texture(null);
    this.nm = new Float32Array(9);
    this.lightVP = m4.create();
    this.view = m4.create(); this.proj = m4.create(); this.vp = m4.create();
    this.bb = m4.create();
  }

  upload({ v, i }) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, v instanceof Float32Array ? v : new Float32Array(v), gl.STATIC_DRAW);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, i instanceof Uint32Array ? i : new Uint32Array(i), gl.STATIC_DRAW);
    const S = STRIDE * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, S, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, S, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, S, 24);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, S, 32);
    gl.bindVertexArray(null);
    return { vao, vb, ib, count: i.length };
  }

  deleteMesh(m) {
    if (!m || !m.vb) return;
    const gl = this.gl;
    gl.deleteVertexArray(m.vao); gl.deleteBuffer(m.vb); gl.deleteBuffer(m.ib);
    m.vb = null;
  }

  /** Texture from a canvas (sRGB). Pass null for a 1x1 white texture. */
  texture(canvas, { repeat = false, existing = null } = {}) {
    const gl = this.gl;
    const t = existing || gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    if (canvas) gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (canvas) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, canvas ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    return t;
  }

  deleteTexture(t) { if (t && t !== this.white) this.gl.deleteTexture(t); }

  /** Offscreen MSAA HDR target + bloom buffers. Returns false if unsupported (then we draw directly). */
  ensureTargets(W, H) {
    if (!this.pp || this.ppFailed) return false;
    if (this.targets && this.targets.W === W && this.targets.H === H) return true;
    const gl = this.gl;
    this.freeTargets();
    const fmt = this.hdr ? gl.RGBA16F : gl.RGBA8;
    const type = this.hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    const tex = (w, h) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, gl.RGBA, type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return { t, f, w, h };
    };
    try {
      const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 0);
      const msaa = gl.createFramebuffer();
      const color = gl.createRenderbuffer(), depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, color);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, fmt, W, H);
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, W, H);
      gl.bindFramebuffer(gl.FRAMEBUFFER, msaa);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      const ok1 = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      const scene = tex(W, H);
      const ok2 = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      const h2 = [Math.max(1, W >> 1), Math.max(1, H >> 1)], h4 = [Math.max(1, W >> 2), Math.max(1, H >> 2)];
      this.targets = { W, H, msaa, color, depth, scene, a1: tex(...h2), b1: tex(...h2), a2: tex(...h4), b2: tex(...h4) };
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!ok1 || !ok2) throw new Error('framebuffer incomplete');
      return true;
    } catch (e) {
      console.warn('post-processing disabled:', e.message);
      this.freeTargets();
      this.ppFailed = true;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return false;
    }
  }

  freeTargets() {
    const t = this.targets, gl = this.gl;
    if (!t) return;
    gl.deleteFramebuffer(t.msaa); gl.deleteRenderbuffer(t.color); gl.deleteRenderbuffer(t.depth);
    for (const k of ['scene', 'a1', 'b1', 'a2', 'b2']) { gl.deleteTexture(t[k].t); gl.deleteFramebuffer(t[k].f); }
    this.targets = null;
  }

  fsq(prog, target, uniforms) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.f : null);
    gl.viewport(0, 0, target ? target.w : this.canvas.width, target ? target.h : this.canvas.height);
    let unit = 0;
    for (const [k, v] of Object.entries(uniforms)) {
      if (v && v.t) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, v.t); gl.uniform1i(prog.u[k], unit++); }
      else if (Array.isArray(v)) gl.uniform2fv(prog.u[k], v);
      else gl.uniform1f(prog.u[k], v);
    }
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  postProcess(env) {
    const gl = this.gl, t = this.targets;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.msaa);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.scene.f);
    gl.blitFramebuffer(0, 0, t.W, t.H, 0, 0, t.W, t.H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    const P = this.pp;
    this.fsq(P.bright, t.a1, { uTex: t.scene, uThreshold: env.threshold ?? (this.hdr ? 0.9 : 0.78) });
    this.fsq(P.blur, t.b1, { uTex: t.a1, uDir: [1 / t.a1.w, 0] });
    this.fsq(P.blur, t.a1, { uTex: t.b1, uDir: [0, 1 / t.a1.h] });
    this.fsq(P.blur, t.a2, { uTex: t.a1, uDir: [0.5 / t.a2.w, 0.5 / t.a2.h] });
    for (let i = 0; i < 2; i++) {
      this.fsq(P.blur, t.b2, { uTex: t.a2, uDir: [(1 + i) / t.a2.w, 0] });
      this.fsq(P.blur, t.a2, { uTex: t.b2, uDir: [0, (1 + i) / t.a2.h] });
    }
    this.fsq(P.comp, null, { uScene: t.scene, uB1: t.a1, uB2: t.a2, uBloom: env.bloom ?? 0.6, uExposure: env.exposure ?? 1.0, uVignette: env.vignette ?? 0.22 });
    gl.enable(gl.DEPTH_TEST);
  }

  resize(w, h, dpr) {
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
  }

  /**
   * cam: { eye, target, fov, near, far }   env: { sun, sky, ground, lightDir, fog, fogRange, clear, shadowBox:{center,radius} }
   * root: Node   billboards: [{ pos, size, color, alpha }]
   */
  render(root, cam, env, billboards = []) {
    const gl = this.gl;
    const W = this.canvas.width, H = this.canvas.height;
    root.update(null);
    const items = [];
    root.collect(items);

    // light matrices
    const { center, radius } = env.shadowBox;
    const L = env.lightDir;
    const eye = [center[0] + L[0] * radius * 2, center[1] + L[1] * radius * 2, center[2] + L[2] * radius * 2];
    const lv = m4.lookAt(m4.create(), eye, center, [0, 1, 0]);
    const lp = m4.ortho(m4.create(), -radius, radius, -radius, radius, 0.1, radius * 4);
    m4.mul(this.lightVP, lp, lv);

    // shadow pass
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.viewport(0, 0, this.shadowSize, this.shadowSize);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(2, 3);
    gl.useProgram(this.depth.p);
    gl.uniformMatrix4fv(this.depth.u.uLightVP, false, this.lightVP);
    for (const n of items) {
      if (n.mat.noShadow || n.mat.sky || n.mat.alpha < 1 || n.mat.additive) continue;
      gl.uniformMatrix4fv(this.depth.u.uModel, false, n.world);
      gl.bindVertexArray(n.mesh.vao);
      gl.drawElements(gl.TRIANGLES, n.mesh.count, gl.UNSIGNED_INT, 0);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // main pass (into the MSAA HDR target when available)
    const post = this.ensureTargets(W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, post ? this.targets.msaa : null);
    gl.viewport(0, 0, W, H);
    const c = env.clear;
    if (post) gl.clearColor(c[0], c[1], c[2], 1);
    else gl.clearColor(Math.pow(c[0], 1 / 2.2), Math.pow(c[1], 1 / 2.2), Math.pow(c[2], 1 / 2.2), 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    m4.perspective(this.proj, cam.fov, W / H, cam.near, cam.far);
    m4.lookAt(this.view, cam.eye, cam.target, [0, 1, 0]);
    m4.mul(this.vp, this.proj, this.view);

    const u = this.main.u;
    gl.useProgram(this.main.p);
    gl.uniformMatrix4fv(u.uVP, false, this.vp);
    gl.uniformMatrix4fv(u.uLightVP, false, this.lightVP);
    gl.uniform3fv(u.uLightDir, L); gl.uniform3fv(u.uSun, env.sun); gl.uniform3fv(u.uSky, env.sky); gl.uniform3fv(u.uGround, env.ground);
    gl.uniform3fv(u.uFog, env.fog); gl.uniform2fv(u.uFogRange, env.fogRange); gl.uniform3fv(u.uCam, cam.eye);
    gl.uniform1f(u.uTexel, 1 / this.shadowSize);
    gl.uniform1f(u.uPost, post ? 1 : 0);
    gl.uniform1f(u.uExposure, env.exposure ?? 1.0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.shadowTex); gl.uniform1i(u.uShadow, 1);
    gl.uniform1i(u.uTex, 0);

    const opaque = [], blended = [], sky = [];
    for (const n of items) (n.mat.sky ? sky : n.mat.alpha < 1 || n.mat.additive ? blended : opaque).push(n);
    if (sky.length) {
      gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND); gl.depthMask(false);
      for (const n of sky) this.drawNode(n);
      gl.depthMask(true);
    }
    gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    gl.disable(gl.BLEND); gl.depthMask(true);
    for (const n of opaque) this.drawNode(n);

    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.depthMask(false);
    const dist = (n) => { const w = n.world; return -Math.hypot(w[12] - cam.eye[0], w[13] - cam.eye[1], w[14] - cam.eye[2]); };
    blended.sort((a, b) => dist(a) - dist(b));
    for (const n of blended) {
      gl.blendFuncSeparate(gl.SRC_ALPHA, n.mat.additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.drawNode(n);
    }
    // billboards (camera-facing, additive)
    if (billboards.length) {
      const v = this.view;
      const rx = [v[0], v[4], v[8]], uy = [v[1], v[5], v[9]], fz = [v[2], v[6], v[10]];
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const mat = { color: [1, 1, 1], alpha: 1, unlit: true, round: true };
      for (const b of billboards) {
        const s = b.size, m = this.bb;
        m[0] = rx[0] * s; m[1] = rx[1] * s; m[2] = rx[2] * s; m[3] = 0;
        m[4] = uy[0] * s; m[5] = uy[1] * s; m[6] = uy[2] * s; m[7] = 0;
        m[8] = fz[0]; m[9] = fz[1]; m[10] = fz[2]; m[11] = 0;
        m[12] = b.pos[0]; m[13] = b.pos[1]; m[14] = b.pos[2]; m[15] = 1;
        mat.color = b.color; mat.alpha = b.alpha; mat.noFog = !!b.noFog;
        this.drawRaw(this.meshes.plane, m, mat);
      }
    }
    gl.depthMask(true); gl.disable(gl.BLEND);
    if (post) this.postProcess(env);
  }

  drawNode(n) { this.drawRaw(n.mesh, n.world, n.mat); }

  drawRaw(mesh, world, mat) {
    const gl = this.gl, u = this.main.u;
    gl.uniformMatrix4fv(u.uModel, false, world);
    gl.uniformMatrix3fv(u.uNM, false, m4.normal(this.nm, world));
    gl.uniform3fv(u.uColor, mat.color);
    gl.uniform3fv(u.uEmissive, mat.emissive || [0, 0, 0]);
    gl.uniform1f(u.uAlpha, mat.alpha ?? 1);
    gl.uniform1f(u.uUnlit, mat.unlit ? 1 : 0);
    gl.uniform1f(u.uShadowOn, mat.noReceive ? 0 : 1);
    gl.uniform1f(u.uRound, mat.round ? 1 : 0);
    gl.uniform1f(u.uNoFog, mat.noFog || mat.sky ? 1 : 0);
    gl.uniform1f(u.uSpec, mat.spec ?? 0.06);
    gl.uniform1f(u.uShine, mat.shine ?? 18);
    gl.uniform1f(u.uTexEmit, mat.texEmit ?? 0);
    gl.activeTexture(gl.TEXTURE0);
    if (mat.tex) {
      gl.bindTexture(gl.TEXTURE_2D, mat.tex);
      gl.uniform1f(u.uUseTex, 1);
      gl.uniform2fv(u.uUvOff, mat.uvOff || [0, 0]);
      gl.uniform2fv(u.uUvScale, mat.uvScale || [1, 1]);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.white);
      gl.uniform1f(u.uUseTex, 0);
    }
    gl.bindVertexArray(mesh.vao);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
  }

  /** World point → CSS pixel coords (+ depth w). */
  project(p, cssW, cssH) {
    const r = m4.transform(this.vp, p[0], p[1], p[2]);
    return { x: (r[0] * 0.5 + 0.5) * cssW, y: (1 - (r[1] * 0.5 + 0.5)) * cssH, z: r[2], w: r[3], behind: r[3] <= 0 };
  }
}
