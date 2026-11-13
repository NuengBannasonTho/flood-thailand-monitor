import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { latToTileY, lngToTileX } from '../geo';
import type { DemGrid } from '../sim/dem';
import { createProgram, elevationAt, type GridFrame, gridFrame, relativeMatrix } from './gl';

export type Rgb = readonly [number, number, number];
export type Line = readonly (readonly [number, number])[];

/** Lines drawn with one colour and width. `width` is in CSS pixels at zoom 14. */
export interface LineBatch {
  lines: readonly Line[];
  color: Rgb;
  width: number;
}

/** Slots are drawn in this order, so routes always sit on top of the road status. */
const SLOTS = ['roads', 'routes'] as const;
export type LineSlot = (typeof SLOTS)[number];

/*
 * One instance per line segment, expanded to a quad in screen space. The quad is a little longer
 * and wider than the segment and the fragment shader cuts a capsule out of it, which gives round
 * caps and joins and a smooth edge without any join geometry.
 *
 * The perspective divide is done here rather than by the GPU (w is written as 1) so the varyings
 * interpolate linearly across the screen, which the capsule maths relies on.
 */
const VERTEX = `#version 300 es
in vec2 aCorner;  // x: 0 at the segment's start, 1 at its end; y: -1 or 1 across it
in vec3 aStart;   // Mercator x, y relative to the area's corner, and ground height in metres
in vec3 aEnd;
in vec3 aColor;
in float aWidth;
uniform mat4 uMatrix;
uniform float uElevScale;
uniform vec2 uHalfViewport; // device pixels
uniform float uWidthScale;
uniform float uNear;
out vec2 vAt;
out float vLength;
out float vHalfWidth;
out vec3 vColor;
void main() {
  vec4 a = uMatrix * vec4(aStart.xy, aStart.z * uElevScale, 1.0);
  vec4 b = uMatrix * vec4(aEnd.xy, aEnd.z * uElevScale, 1.0);
  if (a.w < uNear && b.w < uNear) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  // a segment that passes behind the camera is cut where it meets the near plane
  if (a.w < uNear) a = mix(a, b, (uNear - a.w) / (b.w - a.w));
  if (b.w < uNear) b = mix(b, a, (uNear - b.w) / (a.w - b.w));
  vec2 sa = a.xy / a.w * uHalfViewport;
  vec2 sb = b.xy / b.w * uHalfViewport;
  vec2 d = sb - sa;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  float halfWidth = aWidth * uWidthScale * 0.5;
  float pad = halfWidth + 1.0;
  float along = mix(-pad, len + pad, aCorner.x);
  float across = aCorner.y * pad;
  vec2 s = sa + dir * along + vec2(-dir.y, dir.x) * across;
  gl_Position = vec4(s / uHalfViewport, 0.0, 1.0);
  vAt = vec2(along, across);
  vLength = len;
  vHalfWidth = halfWidth;
  vColor = aColor;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vAt;
in float vLength;
in float vHalfWidth;
in vec3 vColor;
out vec4 outColor;
void main() {
  float dx = vAt.x - clamp(vAt.x, 0.0, vLength);
  float alpha = clamp(vHalfWidth + 0.5 - length(vec2(dx, vAt.y)), 0.0, 1.0);
  if (alpha <= 0.0) discard;
  outColor = vec4(vColor * alpha, alpha);
}`;

type UniformName = 'uMatrix' | 'uElevScale' | 'uHalfViewport' | 'uWidthScale' | 'uNear';
const UNIFORMS: readonly UniformName[] = ['uMatrix', 'uElevScale', 'uHalfViewport', 'uWidthScale', 'uNear'];

/** floats per instance: start xyz, end xyz, colour rgb, width */
const STRIDE = 10;

interface Resources {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  corners: WebGLBuffer;
  instances: WebGLBuffer;
  uniform: Record<UniformName, WebGLUniformLocation | null>;
}

/** The same curve the map's own road lines use: thin when zoomed out, wide at street level. */
function widthScale(zoom: number): number {
  const stops: readonly (readonly [number, number])[] = [
    [10, 0.35],
    [14, 1],
    [18, 3.2],
  ];
  if (zoom <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [z1, v1] = stops[i];
    if (zoom > z1) continue;
    const [z0, v0] = stops[i - 1];
    const base = 1.6;
    const t = (base ** (zoom - z0) - 1) / (base ** (z1 - z0) - 1);
    return v0 + (v1 - v0) * t;
  }
  return stops[stops.length - 1][1];
}

/**
 * Road status and routes, drawn in the map's own WebGL context above the water.
 *
 * These are not ordinary map line layers on purpose. With 3D terrain the map bakes ordinary line
 * and fill layers into per-tile textures, and it can only keep those textures between frames while
 * all such layers are adjacent in the layer order. Lines that have to sit above the animated water
 * would split them in two, and the map would then redraw every terrain tile on every frame.
 */
export class LineLayer implements CustomLayerInterface {
  readonly id = 'fs-lines';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  onFail: ((message: string) => void) | null = null;

  private map: MapLibreMap | null = null;
  private res: Resources | null = null;
  private grid: DemGrid | null = null;
  private frame: GridFrame | null = null;
  private readonly batches: Record<LineSlot, readonly LineBatch[]> = { roads: [], routes: [] };
  /** Segment geometry per line, kept while the line object lives: road edges are reused between updates. */
  private geometry = new WeakMap<Line, Float32Array>();
  private data = new Float32Array(0);
  private count = 0;
  private dirty = false;
  private terrain = true;
  private failed = false;
  private webgl2 = false;
  private readonly matrix = new Float32Array(16);

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    this.webgl2 = gl instanceof WebGL2RenderingContext; // the water layer reports a missing WebGL2
  }

  onRemove(): void {
    const r = this.res;
    if (r) {
      r.gl.deleteProgram(r.program);
      r.gl.deleteBuffer(r.corners);
      r.gl.deleteBuffer(r.instances);
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
    const program = createProgram(gl, VERTEX, FRAGMENT, 'Line shader');
    const vao = gl.createVertexArray();
    const corners = gl.createBuffer();
    const instances = gl.createBuffer();
    if (!vao || !corners || !instances) throw new Error('WebGL resources could not be created');
    const uniform: Record<UniformName, WebGLUniformLocation | null> = { uMatrix: null, uElevScale: null, uHalfViewport: null, uWidthScale: null, uNear: null };
    for (const name of UNIFORMS) uniform[name] = gl.getUniformLocation(program, name);

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const corner = gl.getAttribLocation(program, 'aCorner');
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, instances);
    const perInstance = (name: string, size: number, offset: number): void => {
      const location = gl.getAttribLocation(program, name);
      if (location < 0) return;
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, STRIDE * 4, offset * 4);
      gl.vertexAttribDivisor(location, 1);
    };
    perInstance('aStart', 3, 0);
    perInstance('aEnd', 3, 3);
    perInstance('aColor', 3, 6);
    perInstance('aWidth', 1, 9);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return { gl, program, vao, corners, instances, uniform };
  }

  /** The area the lines belong to. Its elevation grid puts them on the terrain. */
  setGrid(grid: DemGrid | null): void {
    if (grid === this.grid) return;
    this.grid = grid;
    this.frame = grid ? gridFrame(grid) : null;
    this.geometry = new WeakMap();
    this.dirty = true;
    this.map?.triggerRepaint();
  }

  set(slot: LineSlot, batches: readonly LineBatch[]): void {
    this.batches[slot] = batches;
    this.dirty = true;
    this.map?.triggerRepaint();
  }

  setTerrain(on: boolean): void {
    this.terrain = on;
    this.map?.triggerRepaint();
  }

  /** x, y, height for both ends of every segment of a line; computed once per line object. */
  private segments(line: Line, grid: DemGrid, frame: GridFrame): Float32Array {
    const cached = this.geometry.get(line);
    if (cached) return cached;
    const world = 2 ** grid.zoom;
    const out = new Float32Array(Math.max(0, line.length - 1) * 6);
    let px = 0;
    let py = 0;
    let pz = 0;
    for (let i = 0; i < line.length; i++) {
      const [lng, lat] = line[i];
      const x = lngToTileX(lng, grid.zoom) / world - frame.x0;
      const y = latToTileY(lat, grid.zoom) / world - frame.y0;
      const height = elevationAt(grid, lng, lat);
      const z = Number.isNaN(height) ? pz : height;
      if (i > 0) out.set([px, py, pz, x, y, z], (i - 1) * 6);
      px = x;
      py = y;
      pz = z;
    }
    this.geometry.set(line, out);
    return out;
  }

  private rebuild(r: Resources): void {
    this.dirty = false;
    const { grid, frame } = this;
    this.count = 0;
    if (!grid || !frame) return;

    let total = 0;
    for (const slot of SLOTS) for (const batch of this.batches[slot]) for (const line of batch.lines) total += Math.max(0, line.length - 1);
    if (this.data.length < total * STRIDE) this.data = new Float32Array(Math.ceil(total * 1.25) * STRIDE);

    const data = this.data;
    let at = 0;
    for (const slot of SLOTS) {
      for (const batch of this.batches[slot]) {
        const [red, green, blue] = batch.color;
        for (const line of batch.lines) {
          const seg = this.segments(line, grid, frame);
          for (let s = 0; s < seg.length; s += 6) {
            for (let k = 0; k < 6; k++) data[at + k] = seg[s + k];
            data[at + 6] = red;
            data[at + 7] = green;
            data[at + 8] = blue;
            data[at + 9] = batch.width;
            at += STRIDE;
          }
        }
      }
    }
    this.count = total;
    r.gl.bindBuffer(r.gl.ARRAY_BUFFER, r.instances);
    r.gl.bufferData(r.gl.ARRAY_BUFFER, data.subarray(0, total * STRIDE), r.gl.DYNAMIC_DRAW);
    r.gl.bindBuffer(r.gl.ARRAY_BUFFER, null);
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    const map = this.map;
    const frame = this.frame;
    if (!map || !frame || this.failed || !this.webgl2 || !(gl instanceof WebGL2RenderingContext)) return;
    let r = this.res;
    try {
      // Created here rather than in onAdd: the map resets its WebGL state tracking after render only.
      if (!r || r.gl !== gl) r = this.res = this.createResources(gl);
      if (this.dirty) this.rebuild(r);
    } catch (error) {
      this.fail(`วาดเส้นทางไม่ได้ (${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    if (this.count === 0) return;

    relativeMatrix(this.matrix, args.defaultProjectionData.mainMatrix, frame.x0, frame.y0);
    const terrain = this.terrain ? map.getTerrain() : null;
    r.gl.useProgram(r.program);
    r.gl.uniformMatrix4fv(r.uniform.uMatrix, false, this.matrix);
    r.gl.uniform1f(r.uniform.uElevScale, terrain ? frame.metre * (terrain.exaggeration ?? 1) : 0);
    r.gl.uniform2f(r.uniform.uHalfViewport, r.gl.drawingBufferWidth / 2, r.gl.drawingBufferHeight / 2);
    r.gl.uniform1f(r.uniform.uWidthScale, widthScale(map.getZoom()) * map.getPixelRatio());
    r.gl.uniform1f(r.uniform.uNear, args.nearZ * 1.02);

    r.gl.disable(r.gl.DEPTH_TEST);
    r.gl.disable(r.gl.STENCIL_TEST);
    r.gl.disable(r.gl.CULL_FACE);
    r.gl.enable(r.gl.BLEND);
    r.gl.blendFunc(r.gl.ONE, r.gl.ONE_MINUS_SRC_ALPHA); // colours are premultiplied
    r.gl.bindVertexArray(r.vao);
    r.gl.drawArraysInstanced(r.gl.TRIANGLE_STRIP, 0, 4, this.count);
    r.gl.bindVertexArray(null);
  }
}
