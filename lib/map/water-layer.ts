import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import type { Bounds } from '../config';
import { cellBox, type DemGrid } from '../sim/dem';
import { type FloodField, wetCount } from '../sim/flood';
import { createProgram, type GridFrame, gridFrame, relativeMatrix } from './gl';

const VERTEX = `#version 300 es
in vec2 aPos;    // Web Mercator position, relative to the area's north-west corner
in float aElev;  // ground elevation, metres
in vec2 aCell;   // position in grid cells
uniform mat4 uMatrix;
uniform float uElevScale;
out vec2 vCell;
void main() {
  vCell = aCell;
  gl_Position = uMatrix * vec4(aPos, aElev * uElevScale, 1.0);
}`;

/*
 * Per grid cell the data texture holds (rank, threshold, p, q) as described on FloodField.
 * A cell is under water once the front has passed its rank.
 *
 * The shoreline comes from a continuous "how far inside the water" value per cell, blended over the
 * 4x4 nearest cells with a cubic B-spline. A wet/dry flag blended bilinearly would give the
 * staircase or diamond teeth of the 37 m cells; this gives a smooth curve, anti-aliased to the pixel.
 *
 * The look is clear water: colour deepens continuously with depth (no bands), a slow swell moves
 * through the tone, thin light ripples drift and meander across the surface, and a soft light line
 * runs along the waterline.
 */
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uData;
uniform vec2 uGrid;
uniform float uFront;   // rank the water has reached
uniform float uBand;    // width of one ring behind the front, in rank
uniform float uSetting; // water surface (m) or rainfall (mm)
uniform float uTime;
uniform float uArrive;  // 0 = settled, 1 = flood front on the move
uniform int uRain;
in vec2 vCell;
out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

// x: how far inside the water, -1 dry .. 0 waterline .. 1 well inside; y: depth in metres
vec2 cell(ivec2 c) {
  c = clamp(c, ivec2(0), ivec2(uGrid) - 1);
  vec4 d = texelFetch(uData, c, 0);
  float inside = d.r < 1.5 ? clamp((uFront - d.r) / uBand, -1.0, 1.0) : -1.0;
  float depth = uRain == 1 ? min(d.a, d.b * max(uSetting - d.g, 0.0)) : max(uSetting - d.b, 0.0);
  return vec2(inside, inside > 0.0 ? depth : 0.0);
}

// cubic B-spline weights for the four samples around fraction t
vec4 bspline(float t) {
  float t2 = t * t;
  float t3 = t2 * t;
  return vec4(1.0 - 3.0 * t + 3.0 * t2 - t3, 4.0 - 6.0 * t2 + 3.0 * t3, 1.0 + 3.0 * t + 3.0 * t2 - 3.0 * t3, t3) / 6.0;
}

// one layer of light ripples at 'scale' per cell: thin lines where two drifting noise fields cross
// the middle together, bent by a slower third so they meander instead of sliding. Stretched along
// one direction, so they read as wind ripples rather than a net.
float ripples(vec2 at, float scale, float t, float pxWidth) {
  vec2 p = mat2(0.88, 0.47, -0.47, 0.88) * at * scale * vec2(0.55, 1.6);
  vec2 bend = vec2(noise(p * 0.4 + vec2(t * 0.05, 0.0)), noise(p * 0.4 + vec2(9.1, -t * 0.04)));
  p += (bend - 0.5) * 1.4;
  float a = noise(p + vec2(t * 0.22, t * 0.08));
  float b = noise(p * 1.3 + vec2(-t * 0.16, t * 0.2) + 4.7);
  float v = abs(a + b - 1.0);
  // lines only where both fields agree on a crest, so they come and go in patches
  float clump = smoothstep(0.35, 0.75, noise(p * 0.3 - vec2(t * 0.04, 0.0)));
  return (1.0 - smoothstep(0.0, 0.045 + pxWidth, v)) * clump;
}

void main() {
  // derivatives first, while every pixel of the quad still runs the same code
  float cellsPerPx = length(fwidth(vCell));

  vec2 g = vCell - 0.5;
  ivec2 i = ivec2(floor(g));
  vec2 f = fract(g);
  vec4 wx = bspline(f.x);
  vec4 wy = bspline(f.y);
  vec2 m = vec2(0.0);
  for (int y = 0; y < 4; y++) {
    vec2 row = vec2(0.0);
    for (int x = 0; x < 4; x++) row += wx[x] * cell(i + ivec2(x - 1, y - 1));
    m += wy[y] * row;
  }

  float t = uTime;
  // the waterline sways a little, slowly
  float sway = noise(vCell * 0.18 + vec2(t * 0.05, -t * 0.04)) - 0.5;
  float edge = m.x + sway * 0.2;
  float aa = max(fwidth(edge), 0.015);
  float cover = smoothstep(-aa, aa, edge);
  if (cover <= 0.0) { outColor = vec4(0.0); return; }

  // colour deepens smoothly with depth
  float tone = 1.0 - exp(-max(m.y, 0.0) / 1.4);
  vec3 color = mix(vec3(0.60, 0.84, 0.95), vec3(0.26, 0.58, 0.89), smoothstep(0.0, 0.6, tone));
  color = mix(color, vec3(0.10, 0.32, 0.70), smoothstep(0.45, 1.0, tone));

  // a broad swell rolling slowly through the tone
  float swell = noise(vCell * 0.07 + vec2(t * 0.035, t * 0.02)) * 0.6 + noise(vCell * 0.16 - vec2(t * 0.05, 0.0)) * 0.4;
  color *= 0.93 + 0.14 * swell;

  // light ripples, two sizes; each fades out before its lines get finer than about 3 pixels
  float light = 0.0;
  float coarse = 0.55;
  float fine = 1.7;
  float fadeCoarse = smoothstep(0.34, 0.12, coarse * cellsPerPx);
  float fadeFine = smoothstep(0.34, 0.12, fine * cellsPerPx);
  if (fadeCoarse > 0.0) light += ripples(vCell, coarse, t, coarse * cellsPerPx * 2.0) * fadeCoarse * 0.5;
  if (fadeFine > 0.0) light += ripples(vCell + 31.0, fine, t * 1.3, fine * cellsPerPx * 2.0) * fadeFine * 0.3;
  light *= 0.7 + 0.6 * swell;

  // a soft light line along the waterline, breathing gently
  float shore = smoothstep(0.3, 0.0, edge) * (0.8 + 0.2 * sin(t * 1.1 + sway * 9.0));
  color = mix(color, vec3(0.93, 0.98, 1.0), shore * 0.3);

  // the arriving front runs pale and foamy
  float lead = uArrive * smoothstep(0.8, 0.0, m.x);
  color = mix(color, vec3(0.96, 0.99, 1.0), lead * 0.6);

  float alpha = mix(0.55, 0.85, tone) * cover;
  // ripples are added light (premultiplied), so they read on shallow water too
  outColor = vec4(color * alpha + vec3(0.95, 0.99, 1.0) * light * 0.45 * cover, alpha);
}`;

type UniformName = 'uMatrix' | 'uElevScale' | 'uData' | 'uGrid' | 'uFront' | 'uBand' | 'uSetting' | 'uTime' | 'uArrive' | 'uRain';
const UNIFORMS: readonly UniformName[] = ['uMatrix', 'uElevScale', 'uData', 'uGrid', 'uFront', 'uBand', 'uSetting', 'uTime', 'uArrive', 'uRain'];

interface Resources {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  vertices: WebGLBuffer;
  indices: WebGLBuffer;
  texture: WebGLTexture;
  uniform: Record<UniformName, WebGLUniformLocation | null>;
}

interface Pending {
  grid: DemGrid;
  field: FloodField;
  /** the simulated area: water is drawn inside it only */
  clip: Bounds | null;
}

/** The mesh has a vertex every this many grid cells: enough to follow the terrain. */
const MESH_STEP = 4;

/** Mesh lines from `a` to `b`: both ends, and every multiple of MESH_STEP between. */
function meshSteps(a: number, b: number): number[] {
  const out = [a];
  for (let c = (Math.floor(a / MESH_STEP) + 1) * MESH_STEP; c < b; c += MESH_STEP) out.push(c);
  out.push(Math.max(b, a + 1e-3));
  return out;
}
/** The front never crawls slower than this, in rank per second, so a small change still finishes promptly. */
const MIN_SPEED = 0.07;
/** Fraction of the remaining distance covered per second: large jumps move fast at first, then settle. */
const CHASE = 2.2;

/**
 * Draws the flood inside the map's own WebGL context, as one mesh laid over the terrain.
 * Nothing is recomputed on the CPU when the water moves: the level, the travelling front and the
 * rolling layers are all uniforms of the fragment shader, so every frame costs one draw call.
 *
 * A custom layer rather than an image over the terrain, because the map would otherwise have to
 * re-render every terrain tile on each frame of animation.
 */
export class WaterLayer implements CustomLayerInterface {
  readonly id = 'fs-water';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  /** called once if the water cannot be drawn on this device */
  onFail: ((message: string) => void) | null = null;

  private map: MapLibreMap | null = null;
  private res: Resources | null = null;
  private pending: Pending | null = null;
  private field: FloodField | null = null;
  private frame: GridFrame | null = null;
  private webgl2 = false;
  private indexCount = 0;
  private cells = 1;
  private terrain = true;
  private front = 0;
  private frontTarget = 0;
  private setting = 0;
  private settingTarget = 0;
  private arrive = 0;
  private last = 0;
  private failed = false;
  private readonly still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly matrix = new Float32Array(16);

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    this.webgl2 = gl instanceof WebGL2RenderingContext;
    if (!this.webgl2) this.fail('เบราว์เซอร์นี้ไม่มี WebGL2 จึงวาดน้ำท่วมไม่ได้');
  }

  onRemove(): void {
    const r = this.res;
    if (r) {
      r.gl.deleteProgram(r.program);
      r.gl.deleteBuffer(r.vertices);
      r.gl.deleteBuffer(r.indices);
      r.gl.deleteTexture(r.texture);
      r.gl.deleteVertexArray(r.vao);
    }
    this.res = null;
    this.map = null;
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.onFail?.(message);
  }

  private createResources(gl: WebGL2RenderingContext): Resources {
    const program = createProgram(gl, VERTEX, FRAGMENT, 'Water shader');
    const vao = gl.createVertexArray();
    const vertices = gl.createBuffer();
    const indices = gl.createBuffer();
    const texture = gl.createTexture();
    if (!vao || !vertices || !indices || !texture) throw new Error('WebGL resources could not be created');

    const uniform: Record<UniformName, WebGLUniformLocation | null> = { uMatrix: null, uElevScale: null, uData: null, uGrid: null, uFront: null, uBand: null, uSetting: null, uTime: null, uArrive: null, uRain: null };
    for (const name of UNIFORMS) uniform[name] = gl.getUniformLocation(program, name);

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
    const stride = 5 * 4;
    const attribute = (name: string, size: number, offset: number): void => {
      const location = gl.getAttribLocation(program, name);
      if (location < 0) return;
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
    };
    attribute('aPos', 2, 0);
    attribute('aElev', 1, 8);
    attribute('aCell', 2, 12);
    gl.bindVertexArray(null);

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { gl, program, vao, vertices, indices, texture, uniform };
  }

  /**
   * Loads a new area or cause. The water starts from nothing, so the first level arrives as a wave.
   * It is worked out over the whole grid but drawn only inside `clip`, the area the app simulates.
   */
  setField(grid: DemGrid, field: FloodField, clip: Bounds | null): void {
    this.pending = { grid, field, clip };
    this.field = field;
    this.cells = Math.max(1, field.sorted.length);
    this.front = 0;
    this.setting = field.zero;
    this.arrive = 0;
    this.map?.triggerRepaint();
  }

  clear(): void {
    this.field = null;
    this.pending = null;
    this.map?.triggerRepaint();
  }

  /** Where the water should end up. It travels there over the following frames. */
  setTarget(setting: number): void {
    const field = this.field;
    if (!field) return;
    this.settingTarget = setting;
    this.frontTarget = wetCount(field, setting) / this.cells;
    if (this.still) {
      this.front = this.frontTarget;
      this.setting = setting;
    }
    this.map?.triggerRepaint();
  }

  /** With 3D relief off the map is flat, and so is the water. */
  setTerrain(on: boolean): void {
    this.terrain = on;
    this.map?.triggerRepaint();
  }

  private upload(r: Resources, { grid, field, clip }: Pending): void {
    const { gl } = r;
    const n = grid.width * grid.height;
    const data = new Float32Array(n * 4);
    const rain = field.mode === 'rain';
    for (let i = 0; i < n; i++) {
      data[i * 4] = field.rank[i];
      data[i * 4 + 1] = field.thr[i];
      data[i * 4 + 2] = field.p[i];
      data[i * 4 + 3] = rain ? field.q[i] : 0;
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D, r.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, grid.width, grid.height, 0, gl.RGBA, gl.FLOAT, data);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Mesh: positions are relative to the area's corner (see GridFrame).
    const frame = gridFrame(grid);
    this.frame = frame;
    const cellSize = frame.cell;

    // The mesh covers the simulated area only; the texture keeps the whole grid, so the water's
    // smoothing still reads the cells just outside and the cut edge stays clean.
    const span = clip ? cellBox(grid, clip) : { x0: 0, y0: 0, x1: grid.width, y1: grid.height };
    const xs = meshSteps(span.x0, span.x1);
    const ys = meshSteps(span.y0, span.y1);
    const cols = xs.length - 1;
    const rows = ys.length - 1;
    const vertices = new Float32Array(xs.length * ys.length * 5);
    let v = 0;
    for (const cy of ys) {
      for (const cx of xs) {
        const sample = Math.min(grid.height - 1, Math.floor(cy)) * grid.width + Math.min(grid.width - 1, Math.floor(cx));
        vertices[v++] = cx * cellSize;
        vertices[v++] = cy * cellSize;
        vertices[v++] = grid.elev[sample];
        vertices[v++] = cx;
        vertices[v++] = cy;
      }
    }
    const index = new Uint32Array(cols * rows * 6);
    let q = 0;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const a = j * (cols + 1) + i;
        const b = a + 1;
        const c = a + cols + 1;
        const d = c + 1;
        index[q++] = a;
        index[q++] = c;
        index[q++] = b;
        index[q++] = b;
        index[q++] = c;
        index[q++] = d;
      }
    }
    gl.bindVertexArray(r.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, r.vertices);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, r.indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.indexCount = index.length;

    gl.useProgram(r.program);
    gl.uniform2f(r.uniform.uGrid, grid.width, grid.height);
    gl.uniform1i(r.uniform.uRain, rain ? 1 : 0);
    gl.uniform1i(r.uniform.uData, 0);
  }

  /** Moves the water one frame closer to its target. Returns true while the front is travelling. */
  private advance(now: number): boolean {
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const gap = this.frontTarget - this.front;
    const moving = Math.abs(gap) > 1e-5 || Math.abs(this.settingTarget - this.setting) > 1e-3;
    if (moving) {
      const travel = Math.max(Math.abs(gap) * CHASE, MIN_SPEED) * dt;
      const share = Math.abs(gap) <= travel ? 1 : travel / Math.abs(gap);
      this.front += gap * share;
      // Depth follows the front, so the two arrive together.
      this.setting += (this.settingTarget - this.setting) * (Math.abs(gap) > 1e-5 ? share : Math.min(1, dt * 6));
      this.arrive = Math.min(1, this.arrive + dt * 5);
    } else {
      this.front = this.frontTarget;
      this.setting = this.settingTarget;
      this.arrive = Math.max(0, this.arrive - dt * 1.2);
    }
    return moving || this.arrive > 0;
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    if (this.failed || !this.field || !this.webgl2 || !(gl instanceof WebGL2RenderingContext)) return;
    let r = this.res;
    try {
      // Created here rather than in onAdd: the map resets its WebGL state tracking after render only.
      if (!r || r.gl !== gl) r = this.res = this.createResources(gl);
      if (this.pending) {
        this.upload(r, this.pending);
        this.pending = null;
      }
    } catch (error) {
      this.fail(`วาดน้ำท่วมไม่ได้ (${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    const now = performance.now();
    const travelling = this.advance(now);

    const frame = this.frame;
    if (!frame) return;
    relativeMatrix(this.matrix, args.defaultProjectionData.mainMatrix, frame.x0, frame.y0);
    const terrain = this.terrain ? this.map?.getTerrain() : null;

    r.gl.useProgram(r.program);
    r.gl.uniformMatrix4fv(r.uniform.uMatrix, false, this.matrix);
    r.gl.uniform1f(r.uniform.uElevScale, terrain ? frame.metre * (terrain.exaggeration ?? 1) : 0);
    // about 2.5 cells per ring, along a front whose length grows with the square root of the wet area
    r.gl.uniform1f(r.uniform.uBand, Math.max(1e-5, (10 * Math.sqrt(Math.max(this.front, 0.002))) / Math.sqrt(this.cells)));
    r.gl.uniform1f(r.uniform.uFront, this.front);
    r.gl.uniform1f(r.uniform.uSetting, this.setting);
    r.gl.uniform1f(r.uniform.uTime, this.still ? 0 : (now / 1000) % 3600);
    r.gl.uniform1f(r.uniform.uArrive, this.arrive);

    r.gl.activeTexture(r.gl.TEXTURE0);
    r.gl.bindTexture(r.gl.TEXTURE_2D, r.texture);
    r.gl.disable(r.gl.DEPTH_TEST);
    r.gl.disable(r.gl.STENCIL_TEST);
    r.gl.disable(r.gl.CULL_FACE);
    r.gl.enable(r.gl.BLEND);
    r.gl.blendFunc(r.gl.ONE, r.gl.ONE_MINUS_SRC_ALPHA); // colours are premultiplied
    r.gl.bindVertexArray(r.vao);
    r.gl.drawElements(r.gl.TRIANGLES, this.indexCount, r.gl.UNSIGNED_INT, 0);
    r.gl.bindVertexArray(null);

    // Water on screen keeps rolling; with reduced motion it only redraws while the level changes.
    if (travelling || (!this.still && this.front > 0)) this.map?.triggerRepaint();
  }
}
