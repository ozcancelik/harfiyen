import type { CaptionImage } from "../captions/renderer";
import { AURA_SHADER, auraUniforms, type AuraFrame } from "./aura";

// Draws a video picture with its caption on top. The same code renders the
// on-screen player (HTMLVideoElement -> <canvas>) and the burn-in encoder
// (VideoFrame -> OffscreenCanvas), so the preview is pixel-identical to the
// exported video and fullscreen shows the captions too.
//
// WebGPU path: the picture is imported as an external texture (zero-copy on
// most platforms) and drawn full screen; the caption image is uploaded only
// when its pixels change and blended on top, with placement and pop-in scale
// as a uniform. A 2D-canvas path covers browsers without WebGPU.

export type Picture = VideoFrame | HTMLVideoElement | AuraFrame | null;
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

export interface Compositor {
  readonly kind: "webgpu" | "2d";
  readonly canvas: AnyCanvas;
  /** Set the output size (the picture is stretched to it). */
  resize(width: number, height: number): void;
  /** Draw a picture (black when null) and an optional caption. */
  render(picture: Picture, caption: CaptionImage | null): void;
  destroy(): void;
}

const SHADER = /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

// Full-screen triangle.
@vertex fn vs_video(@builtin(vertex_index) i: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VsOut;
  o.pos = vec4f(p[i], 0, 1);
  o.uv = vec2f((p[i].x + 1) * 0.5, (1 - p[i].y) * 0.5);
  return o;
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var video: texture_external;

@fragment fn fs_video(in: VsOut) -> @location(0) vec4f {
  return vec4f(textureSampleBaseClampToEdge(video, samp, in.uv).rgb, 1);
}

// Subtitle quad; rect = (x0, y0, x1, y1) in clip space.
@group(0) @binding(2) var<uniform> rect: vec4f;
@group(0) @binding(3) var overlay: texture_2d<f32>;

@vertex fn vs_overlay(@builtin(vertex_index) i: u32) -> VsOut {
  var c = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
  let t = c[i];
  var o: VsOut;
  o.pos = vec4f(mix(rect.x, rect.z, t.x), mix(rect.y, rect.w, t.y), 0, 1);
  o.uv = vec2f(t.x, 1 - t.y);
  return o;
}

@fragment fn fs_overlay(in: VsOut) -> @location(0) vec4f {
  return textureSample(overlay, samp, in.uv); // premultiplied alpha
}
`;

let devicePromise: Promise<GPUDevice> | null = null;

/** One device per JS context, shared by all compositors in it. */
function getDevice(): Promise<GPUDevice> {
  devicePromise ??= (async () => {
    if (!navigator.gpu) throw new Error("Bu tarayıcı WebGPU desteklemiyor.");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("WebGPU için uygun bir GPU bulunamadı.");
    const device = await adapter.requestDevice();
    device.lost.then(() => (devicePromise = null));
    return device;
  })().catch((e) => {
    devicePromise = null;
    throw e;
  });
  return devicePromise;
}

const isAura = (p: Picture): p is AuraFrame => !!p && "kind" in p && p.kind === "aura";

/** Video elements can only be sampled once they have a current frame (and a picture at all). */
const pictureReady = (p: Picture): p is VideoFrame | HTMLVideoElement =>
  !!p && !isAura(p) && (!("readyState" in p) || (p.readyState >= 2 && p.videoWidth > 0));

class GpuCompositor implements Compositor {
  readonly kind = "webgpu" as const;
  private ctx: GPUCanvasContext;
  private videoPipeline: GPURenderPipeline;
  private overlayPipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private rectBuffer: GPUBuffer;
  private overlay: { key: string; texture: GPUTexture; bind: GPUBindGroup } | null = null;
  private auraPipeline: GPURenderPipeline;
  private auraBuffer: GPUBuffer;
  private auraBind: GPUBindGroup;

  constructor(
    private device: GPUDevice,
    readonly canvas: AnyCanvas,
  ) {
    this.ctx = canvas.getContext("webgpu") as GPUCanvasContext;
    const format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device, format, alphaMode: "opaque" });

    const module = device.createShaderModule({ code: SHADER });
    this.videoPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs_video" },
      fragment: { module, entryPoint: "fs_video", targets: [{ format }] },
    });
    this.overlayPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs_overlay" },
      fragment: {
        module,
        entryPoint: "fs_overlay",
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          },
        ],
      },
    });
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.rectBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const auraModule = device.createShaderModule({ code: AURA_SHADER });
    this.auraPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: auraModule, entryPoint: "vs_aura" },
      fragment: { module: auraModule, entryPoint: "fs_aura", targets: [{ format }] },
    });
    this.auraBuffer = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.auraBind = device.createBindGroup({
      layout: this.auraPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.auraBuffer } }],
    });
  }

  resize(width: number, height: number) {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  render(picture: Picture, caption: CaptionImage | null) {
    const d = this.device;
    const overlayBind = caption ? this.prepareOverlay(caption) : null;
    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        { view: this.ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] },
      ],
    });
    if (isAura(picture)) {
      d.queue.writeBuffer(this.auraBuffer, 0, auraUniforms(picture, this.canvas.width, this.canvas.height));
      pass.setPipeline(this.auraPipeline);
      pass.setBindGroup(0, this.auraBind);
      pass.draw(3);
    } else if (pictureReady(picture)) {
      // A media element can lose its frame (seeking, source change); draw
      // black for that frame instead of throwing out of the render loop.
      let external: GPUExternalTexture | null = null;
      try {
        external = d.importExternalTexture({ source: picture });
      } catch {
        external = null;
      }
      if (external) {
        pass.setPipeline(this.videoPipeline);
        pass.setBindGroup(
          0,
          d.createBindGroup({
            layout: this.videoPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: this.sampler },
              { binding: 1, resource: external },
            ],
          }),
        );
        pass.draw(3);
      }
    }
    if (overlayBind) {
      pass.setPipeline(this.overlayPipeline);
      pass.setBindGroup(0, overlayBind);
      pass.draw(6);
    }
    pass.end();
    d.queue.submit([enc.finish()]);
  }

  private prepareOverlay(c: CaptionImage): GPUBindGroup {
    if (this.overlay?.key !== c.key) {
      const old = this.overlay?.texture;
      let texture = old && old.width === c.w && old.height === c.h ? old : null;
      if (!texture) {
        old?.destroy();
        texture = this.device.createTexture({
          size: [c.w, c.h],
          format: "rgba8unorm",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
      }
      this.device.queue.copyExternalImageToTexture({ source: c.source }, { texture, premultipliedAlpha: true }, [c.w, c.h]);
      const bind =
        texture === old && this.overlay
          ? this.overlay.bind
          : this.device.createBindGroup({
              layout: this.overlayPipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: this.sampler },
                { binding: 2, resource: { buffer: this.rectBuffer } },
                { binding: 3, resource: texture.createView() },
              ],
            });
      this.overlay = { key: c.key, texture, bind };
    }

    // Placement (and pop-in scale around the centre) in clip space. Caption
    // coordinates are in caption-layout pixels; map them onto the canvas.
    const sx = this.canvas.width / c.frameW;
    const sy = this.canvas.height / c.frameH;
    const cx = (c.x + c.w / 2) * sx;
    const cy = (c.y + c.h / 2) * sy;
    const hw = (c.w * c.scale * sx) / 2;
    const hh = (c.h * c.scale * sy) / 2;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const rect = new Float32Array([
      ((cx - hw) / W) * 2 - 1,
      1 - ((cy + hh) / H) * 2,
      ((cx + hw) / W) * 2 - 1,
      1 - ((cy - hh) / H) * 2,
    ]);
    this.device.queue.writeBuffer(this.rectBuffer, 0, rect);
    return this.overlay!.bind;
  }

  destroy() {
    this.overlay?.texture.destroy();
    this.rectBuffer.destroy();
    this.auraBuffer.destroy();
    this.ctx.unconfigure();
  }
}

/** Fallback for browsers without WebGPU (preview only). */
class CanvasCompositor implements Compositor {
  readonly kind = "2d" as const;
  private g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

  constructor(readonly canvas: AnyCanvas) {
    this.g = canvas.getContext("2d") as CanvasRenderingContext2D;
  }

  resize(width: number, height: number) {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  render(picture: Picture, c: CaptionImage | null) {
    const { width: W, height: H } = this.canvas;
    this.g.fillStyle = "#000";
    this.g.fillRect(0, 0, W, H);
    if (isAura(picture)) this.drawAura(picture);
    else if (pictureReady(picture)) this.g.drawImage(picture, 0, 0, W, H);
    if (c) {
      const sx = W / c.frameW;
      const sy = H / c.frameH;
      const w = c.w * c.scale * sx;
      const h = c.h * c.scale * sy;
      this.g.drawImage(c.source, (c.x + c.w / 2) * sx - w / 2, (c.y + c.h / 2) * sy - h / 2, w, h);
    }
  }

  /** Simplified aura: soft colour fields and one gentle wave line. */
  private drawAura(a: AuraFrame) {
    const { width: W, height: H } = this.canvas;
    const g = this.g;
    const lv = [a.levels.low, a.levels.mid, a.levels.high];
    a.palette.forEach((c, i) => {
      const t = a.time * (0.04 + i * 0.012) + i * 2;
      const x = W / 2 + Math.sin(t) * W * 0.35;
      const y = H / 2 + Math.cos(t * 0.8) * H * 0.3;
      const r = Math.max(W, H) * 0.7;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, c + "bb");
      grad.addColorStop(1, c + "00");
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
    });
    const energy = (lv[0] + lv[1] + lv[2]) / 3;
    g.strokeStyle = "rgba(255,255,255,0.45)";
    g.lineWidth = Math.max(1, H / 600);
    g.beginPath();
    for (let x = 0; x <= W; x += 4) {
      const u = x / W;
      const env = Math.pow(Math.sin(Math.PI * u), 1.6);
      const y = H / 2 + (0.006 + 0.11 * energy) * H * env * Math.sin(u * 5 + a.time * 0.5);
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }

  destroy() {}
}

export async function createCompositor(canvas: AnyCanvas, allowFallback = true): Promise<Compositor> {
  try {
    return new GpuCompositor(await getDevice(), canvas);
  } catch (e) {
    if (!allowFallback) throw e;
    console.warn("[harfiyen] WebGPU unavailable for the player, using 2D canvas", e);
    return new CanvasCompositor(canvas);
  }
}
