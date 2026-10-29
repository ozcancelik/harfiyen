import type { CaptionImage } from "../captions/renderer";
import type { Placement, Rect } from "../lib/crop";
import { AURA_SHADER, AURA_UNIFORM_BYTES, auraUniforms, type AuraFrame } from "./aura";
import { GlassBlur } from "./glass";
import { logoRect, type LogoLayer } from "./logoLayer";

// Draws a video picture with its caption on top. The same code renders the
// on-screen player (HTMLVideoElement -> <canvas>) and the burn-in encoder
// (VideoFrame -> OffscreenCanvas), so the preview is pixel-identical to the
// exported video and fullscreen shows the captions too.
//
// WebGPU path: the picture is imported as an external texture (zero-copy on
// most platforms) and drawn full screen; the caption image is uploaded only
// when its pixels change and blended on top, with placement and pop-in scale
// as a uniform. A placement (crop.ts) says which part of the picture goes
// where on the frame: a slice that fills it, or the whole picture fitted in
// over black or over a blurred copy of itself. The user's logo goes in its
// corner under the caption, uploaded once like it. With a glass caption the frame is blurred under the caption
// (glass.ts) before the text goes on. In place of a picture there can be the
// aura (aura.ts) or the user's photo, which covers the frame. A 2D-canvas
// path covers browsers without WebGPU.

/** The user's photo or background video (lib/photo.ts) over the whole frame, cut to its shape. */
export interface PhotoFrame {
  kind: "photo";
  image: ImageBitmap;
  video?: HTMLVideoElement | VideoFrame | null;
}

export type Picture = VideoFrame | HTMLVideoElement | AuraFrame | PhotoFrame | null;
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

export interface Compositor {
  readonly kind: "webgpu" | "2d";
  readonly canvas: AnyCanvas;
  /** Set the output size (the picture is stretched to it). */
  resize(width: number, height: number): void;
  /** Where video pictures go on the frame; null fills the frame with all of the picture. */
  setPlacement(placement: Placement | null): void;
  /** The logo drawn on every frame from now on; null for none. */
  setLogo(logo: LogoLayer | null): void;
  /** Blur the whole video picture or photo, under the logo and the caption (the kinetic stage's "blur" backdrop). */
  setBlur(on: boolean): void;
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
// The part of the picture shown: (x, y, width, height) in texture coordinates.
// src (x, y, width, height) of the picture, in texture coordinates, is drawn
// into dst of the frame; the frame outside dst is left as it was.
struct Place { src: vec4f, dst: vec4f };
@group(0) @binding(4) var<uniform> place: Place;

@fragment fn fs_video(in: VsOut) -> @location(0) vec4f {
  let t = (in.uv - place.dst.xy) / place.dst.zw;
  let c = textureSampleBaseClampToEdge(video, samp, place.src.xy + clamp(t, vec2f(0), vec2f(1)) * place.src.zw);
  if (any(t < vec2f(0)) || any(t > vec2f(1))) {
    discard;
  }
  return vec4f(c.rgb, 1);
}

// An image quad (the caption, the logo); rect = (x0, y0, x1, y1) in clip space, alpha.x its opacity.
struct Quad { rect: vec4f, alpha: vec4f };
@group(0) @binding(2) var<uniform> quad: Quad;
@group(0) @binding(3) var overlay: texture_2d<f32>;

@vertex fn vs_overlay(@builtin(vertex_index) i: u32) -> VsOut {
  var c = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
  let t = c[i];
  let rect = quad.rect;
  var o: VsOut;
  o.pos = vec4f(mix(rect.x, rect.z, t.x), mix(rect.y, rect.w, t.y), 0, 1);
  o.uv = vec2f(t.x, 1 - t.y);
  return o;
}

@fragment fn fs_overlay(in: VsOut) -> @location(0) vec4f {
  return textureSample(overlay, samp, in.uv) * quad.alpha.x; // premultiplied alpha
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

/** Whether WebGPU works in this context (the export worker gets the same answer). */
export const hasGpu = (): Promise<boolean> => getDevice().then(
  () => true,
  () => false,
);

const isAura = (p: Picture): p is AuraFrame => !!p && "kind" in p && p.kind === "aura";
const isPhoto = (p: Picture): p is PhotoFrame => !!p && "kind" in p && p.kind === "photo";

/** Video elements can only be sampled once they have a current frame (and a picture at all). */
const pictureReady = (p: Picture): p is VideoFrame | HTMLVideoElement =>
  !!p && !isAura(p) && !isPhoto(p) && (!("readyState" in p) || (p.readyState >= 2 && p.videoWidth > 0));

/** An image or video frame drawn over the whole of a W×H frame, its overflow cut off evenly on both sides. */
function drawCover(
  g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  image: ImageBitmap | VideoFrame | HTMLVideoElement,
  W: number,
  H: number,
) {
  const iw = "videoWidth" in image ? image.videoWidth : "displayWidth" in image ? image.displayWidth : image.width;
  const ih = "videoHeight" in image ? image.videoHeight : "displayHeight" in image ? image.displayHeight : image.height;
  const s = Math.max(W / iw, H / ih);
  const w = iw * s;
  const h = ih * s;
  g.imageSmoothingQuality = "high";
  g.drawImage(image, (W - w) / 2, (H - h) / 2, w, h);
}

class GpuCompositor implements Compositor {
  readonly kind = "webgpu" as const;
  private ctx: GPUCanvasContext;
  private format: GPUTextureFormat;
  private glass: GlassBlur | null = null;
  /** Where the caption sits now: clip-space rect and size in canvas pixels. */
  private placed = { rect: new Float32Array(4), w: 0, h: 0 };
  private videoPipeline: GPURenderPipeline;
  private overlayPipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private rectBuffer: GPUBuffer;
  private placeBuffer: GPUBuffer;
  /** The backdrop's placement: the cover part of the picture over the whole frame. */
  private coverBuffer: GPUBuffer;
  private backdrop: Placement["backdrop"] = null;
  private blur = false;
  private overlay: { key: string; texture: GPUTexture; bind: GPUBindGroup } | null = null;
  private logo: { layer: LogoLayer; texture: GPUTexture; bind: GPUBindGroup } | null = null;
  private logoBuffer: GPUBuffer;
  /**
   * The photo as it covers this canvas, drawn at its size on a 2D canvas (which scales it down
   * smoothly, the GPU sampler would not) and uploaded once for each image and size.
   */
  private photo: { image: ImageBitmap; w: number; h: number; texture: GPUTexture; bind: GPUBindGroup } | null = null;
  private photoBuffer: GPUBuffer;
  private photoPlaceBuffer: GPUBuffer;
  private auraPipeline: GPURenderPipeline;
  private auraBuffer: GPUBuffer;
  private auraBind: GPUBindGroup;

  constructor(
    private device: GPUDevice,
    readonly canvas: AnyCanvas,
  ) {
    this.ctx = canvas.getContext("webgpu") as GPUCanvasContext;
    const format = (this.format = navigator.gpu.getPreferredCanvasFormat());
    // Sampled too: the glass blurs the frame drawn so far.
    this.ctx.configure({
      device,
      format,
      alphaMode: "opaque",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

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
    // The caption's quad: its rect changes every frame, its opacity is always 1.
    this.rectBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.rectBuffer, 16, new Float32Array([1, 0, 0, 0]));
    this.logoBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // The photo's quad: the whole frame, solid.
    this.photoBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.photoBuffer, 0, new Float32Array([-1, -1, 1, 1, 1, 0, 0, 0]));
    this.photoPlaceBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.placeBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.coverBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.setPlacement(null);

    const auraModule = device.createShaderModule({ code: AURA_SHADER });
    this.auraPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: auraModule, entryPoint: "vs_aura" },
      fragment: { module: auraModule, entryPoint: "fs_aura", targets: [{ format }] },
    });
    this.auraBuffer = device.createBuffer({ size: AURA_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.auraBind = device.createBindGroup({
      layout: this.auraPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.auraBuffer } }],
    });
  }

  resize(width: number, height: number) {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  setPlacement(p: Placement | null) {
    const whole: Rect = { x: 0, y: 0, w: 1, h: 1 };
    const rects = (src: Rect, dst: Rect) => new Float32Array([src.x, src.y, src.w, src.h, dst.x, dst.y, dst.w, dst.h]);
    this.device.queue.writeBuffer(this.placeBuffer, 0, rects(p?.src ?? whole, p?.dst ?? whole));
    this.device.queue.writeBuffer(this.coverBuffer, 0, rects(p?.cover ?? whole, whole));
    this.backdrop = p?.backdrop ?? null;
  }

  setBlur(on: boolean) {
    this.blur = on;
  }

  setLogo(layer: LogoLayer | null) {
    if (!layer) {
      this.logo?.texture.destroy();
      this.logo = null;
      return;
    }
    // A new image is uploaded; new settings only change the quad.
    if (this.logo?.layer.image !== layer.image) {
      this.logo?.texture.destroy();
      const { width, height } = layer.image;
      const texture = this.device.createTexture({
        size: [width, height],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.device.queue.copyExternalImageToTexture({ source: layer.image }, { texture, premultipliedAlpha: true }, [
        width,
        height,
      ]);
      const bind = this.device.createBindGroup({
        layout: this.overlayPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 2, resource: { buffer: this.logoBuffer } },
          { binding: 3, resource: texture.createView() },
        ],
      });
      this.logo = { layer, texture, bind };
    } else this.logo.layer = layer;
  }

  /** The photo's bind group, covering this canvas. */
  private photoBind(image: ImageBitmap): GPUBindGroup {
    const { width: W, height: H } = this.canvas;
    const p = this.photo;
    if (p && p.image === image && p.w === W && p.h === H) return p.bind;
    p?.texture.destroy();
    const sized = new OffscreenCanvas(W, H);
    drawCover(sized.getContext("2d")!, image, W, H);
    const texture = this.device.createTexture({
      size: [W, H],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture({ source: sized }, { texture, premultipliedAlpha: true }, [W, H]);
    const bind = this.device.createBindGroup({
      layout: this.overlayPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 2, resource: { buffer: this.photoBuffer } },
        { binding: 3, resource: texture.createView() },
      ],
    });
    this.photo = { image, w: W, h: H, texture, bind };
    return bind;
  }

  /** The logo's quad on this canvas: clip-space rect and opacity. */
  private logoQuad(layer: LogoLayer) {
    const { width: W, height: H } = this.canvas;
    const r = logoRect(W, H, layer.image, layer.corner, layer.size);
    return new Float32Array([
      (r.x / W) * 2 - 1,
      1 - ((r.y + r.h) / H) * 2,
      ((r.x + r.w) / W) * 2 - 1,
      1 - (r.y / H) * 2,
      layer.opacity,
      0,
      0,
      0,
    ]);
  }

  render(picture: Picture, caption: CaptionImage | null) {
    const d = this.device;
    const overlayBind = caption ? this.prepareOverlay(caption) : null;
    const glass = caption?.panel ? (this.glass ??= new GlassBlur(d, this.format)) : null;
    const view = this.ctx.getCurrentTexture().createView();
    const enc = d.createCommandEncoder();
    let pass = enc.beginRenderPass({
      colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
    });
    /** A picture or photo is down, which the blur goes over. */
    let drawn = false;
    if (isAura(picture)) {
      d.queue.writeBuffer(this.auraBuffer, 0, auraUniforms(picture, this.canvas.width, this.canvas.height));
      pass.setPipeline(this.auraPipeline);
      pass.setBindGroup(0, this.auraBind);
      pass.draw(3);
    } else if (isPhoto(picture)) {
      let external: GPUExternalTexture | null = null;
      const vid = picture.video && pictureReady(picture.video) ? picture.video : null;
      if (vid) {
        try {
          external = d.importExternalTexture({ source: vid });
        } catch {
          external = null;
        }
      }
      if (external && vid) {
        const vw = "videoWidth" in vid ? vid.videoWidth : vid.displayWidth;
        const vh = "videoHeight" in vid ? vid.videoHeight : vid.displayHeight;
        const ratio = this.canvas.width / this.canvas.height;
        const vRatio = vw / vh;
        const wider = vRatio > ratio;
        const sw = wider ? ratio / vRatio : 1;
        const sh = wider ? 1 : vRatio / ratio;
        const sx = wider ? (1 - sw) / 2 : 0;
        const sy = wider ? 0 : (1 - sh) / 2;
        d.queue.writeBuffer(this.photoPlaceBuffer, 0, new Float32Array([sx, sy, sw, sh, 0, 0, 1, 1]));
        const bind = d.createBindGroup({
          layout: this.videoPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.sampler },
            { binding: 1, resource: external },
            { binding: 4, resource: { buffer: this.photoPlaceBuffer } },
          ],
        });
        pass.setPipeline(this.videoPipeline);
        pass.setBindGroup(0, bind);
        pass.draw(3);
      } else {
        pass.setPipeline(this.overlayPipeline);
        pass.setBindGroup(0, this.photoBind(picture.image));
        pass.draw(6);
      }
      drawn = true;
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
        const bind = (buffer: GPUBuffer) =>
          d.createBindGroup({
            layout: this.videoPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: this.sampler },
              { binding: 1, resource: external },
              { binding: 4, resource: { buffer } },
            ],
          });
        pass.setPipeline(this.videoPipeline);
        if (this.backdrop === "blur") {
          // The picture over the whole frame, blurred, then the fitted picture on top.
          pass.setBindGroup(0, bind(this.coverBuffer));
          pass.draw(3);
          pass.end();
          (this.glass ??= new GlassBlur(d, this.format)).backdrop(enc, view, this.canvas.width, this.canvas.height);
          pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "load", storeOp: "store" }] });
          pass.setPipeline(this.videoPipeline);
        }
        pass.setBindGroup(0, bind(this.placeBuffer));
        pass.draw(3);
        drawn = true;
      }
    }
    if (drawn && this.blur) {
      pass.end();
      (this.glass ??= new GlassBlur(d, this.format)).backdrop(enc, view, this.canvas.width, this.canvas.height);
      pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "load", storeOp: "store" }] });
    }
    if (glass && caption?.panel) {
      // The picture is done: blur it, lay the panel on, then go on drawing the text.
      pass.end();
      const { width: W, height: H } = this.canvas;
      const { panel, scale, frameW, frameH } = caption;
      const sx = W / frameW;
      const sy = H / frameH;
      // The panel sits inside the image's clear margin.
      const ix = panel.insetX * scale * sx;
      const top = panel.insetTop * scale * sy;
      const bottom = panel.insetBottom * scale * sy;
      const { rect: r } = this.placed;
      // Clip space: r[1] is the bottom edge, r[3] the top.
      const rect = new Float32Array([r[0] + (ix / W) * 2, r[1] + (bottom / H) * 2, r[2] - (ix / W) * 2, r[3] - (top / H) * 2]);
      const w = this.placed.w - ix * 2;
      const h = this.placed.h - top - bottom;
      const radius = panel.radius * scale * Math.min(sx, sy);
      glass.draw(enc, view, W, H, rect, w, h, Math.min(radius, w / 2, h / 2));
      pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "load", storeOp: "store" }] });
    }
    // The logo, under the caption should they meet.
    if (this.logo) {
      d.queue.writeBuffer(this.logoBuffer, 0, this.logoQuad(this.logo.layer));
      pass.setPipeline(this.overlayPipeline);
      pass.setBindGroup(0, this.logo.bind);
      pass.draw(6);
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
    this.placed = { rect, w: hw * 2, h: hh * 2 };
    return this.overlay!.bind;
  }

  destroy() {
    this.overlay?.texture.destroy();
    this.rectBuffer.destroy();
    this.logoBuffer.destroy();
    this.logo?.texture.destroy();
    this.photo?.texture.destroy();
    this.photoBuffer.destroy();
    this.photoPlaceBuffer.destroy();
    this.placeBuffer.destroy();
    this.coverBuffer.destroy();
    this.auraBuffer.destroy();
    this.glass?.destroy();
    this.ctx.unconfigure();
  }
}

/** Fallback for browsers without WebGPU, for the player and the export alike. */
class CanvasCompositor implements Compositor {
  readonly kind = "2d" as const;
  private g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private placement: Placement | null = null;
  private logo: LogoLayer | null = null;
  private blur = false;

  constructor(readonly canvas: AnyCanvas) {
    this.g = canvas.getContext("2d") as CanvasRenderingContext2D;
  }

  resize(width: number, height: number) {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  setPlacement(placement: Placement | null) {
    this.placement = placement;
  }

  setLogo(logo: LogoLayer | null) {
    this.logo = logo;
  }

  setBlur(on: boolean) {
    this.blur = on;
  }

  /** The photo or background video over the whole canvas, or the picture as placed. */
  private drawGround(picture: PhotoFrame | VideoFrame | HTMLVideoElement) {
    if (isPhoto(picture)) {
      const src = picture.video && pictureReady(picture.video) ? picture.video : picture.image;
      drawCover(this.g, src, this.canvas.width, this.canvas.height);
    } else this.drawPicture(picture);
  }

  /** The picture laid out on the canvas: its backdrop, then its placement. */
  private drawPicture(picture: VideoFrame | HTMLVideoElement) {
    const g = this.g;
    const { width: W, height: H } = this.canvas;
    const p = this.placement;
    if (!p) return g.drawImage(picture, 0, 0, W, H);
    const pw = "videoWidth" in picture ? picture.videoWidth : picture.displayWidth;
    const ph = "videoHeight" in picture ? picture.videoHeight : picture.displayHeight;
    const draw = (s: Rect, d: Rect) => g.drawImage(picture, s.x * pw, s.y * ph, s.w * pw, s.h * ph, d.x * W, d.y * H, d.w * W, d.h * H);
    if (p.backdrop === "blur" && "filter" in g) {
      g.filter = `blur(${Math.round(Math.min(W, H) * 0.04)}px) brightness(0.7)`;
      draw(p.cover, { x: 0, y: 0, w: 1, h: 1 });
      g.filter = "none";
    }
    draw(p.src, p.dst);
  }

  render(picture: Picture, c: CaptionImage | null) {
    const { width: W, height: H } = this.canvas;
    this.g.fillStyle = "#000";
    this.g.fillRect(0, 0, W, H);
    if (isAura(picture)) this.drawAura(picture);
    else if (isPhoto(picture) || pictureReady(picture)) {
      this.drawGround(picture);
      // The frame drawn so far, blurred onto itself and darker, like the glass backdrop.
      if (this.blur && "filter" in this.g) {
        this.g.filter = `blur(${Math.round(Math.min(W, H) * 0.04)}px) brightness(0.7)`;
        this.g.drawImage(this.canvas, 0, 0);
        this.g.filter = "none";
      }
    }
    if (this.logo) {
      const l = this.logo;
      const r = logoRect(W, H, l.image, l.corner, l.size);
      this.g.globalAlpha = l.opacity;
      this.g.drawImage(l.image, r.x, r.y, r.w, r.h);
      this.g.globalAlpha = 1;
    }
    if (c) {
      const sx = W / c.frameW;
      const sy = H / c.frameH;
      const w = c.w * c.scale * sx;
      const h = c.h * c.scale * sy;
      const x = (c.x + c.w / 2) * sx - w / 2;
      const y = (c.y + c.h / 2) * sy - h / 2;
      if (c.panel) {
        const ix = c.panel.insetX * c.scale * sx;
        const top = c.panel.insetTop * c.scale * sy;
        const bottom = c.panel.insetBottom * c.scale * sy;
        this.drawGlass(picture, x + ix, y + top, w - ix * 2, h - top - bottom, c.panel.radius * c.scale * Math.min(sx, sy));
      }
      this.g.drawImage(c.source, x, y, w, h);
    }
  }

  /** Glass without WebGPU: the picture blurred by the canvas filter where there is one, darker. */
  private drawGlass(picture: Picture, x: number, y: number, w: number, h: number, radius: number) {
    const g = this.g;
    const { width: W, height: H } = this.canvas;
    g.save();
    g.beginPath();
    g.roundRect(x, y, w, h, Math.min(radius, w / 2, h / 2));
    g.clip();
    const ground = isPhoto(picture) || pictureReady(picture) ? picture : null;
    const blurs = "filter" in g && !!ground;
    if (blurs) {
      g.filter = `blur(${Math.round(Math.min(W, H) * 0.03)}px)`;
      this.drawGround(ground);
      g.filter = "none";
    }
    // Without the blur the panel is a plain dark box; a bit darker so text still reads.
    g.fillStyle = blurs ? "rgba(0, 0, 0, 0.3)" : "rgba(10, 16, 22, 0.6)";
    g.fillRect(x, y, w, h);
    g.restore();
  }

  /** Simplified audio visualizer for the 2D canvas fallback. */
  private drawAura(a: AuraFrame) {
    const { width: W, height: H } = this.canvas;
    const g = this.g;
    const { low, mid, high } = a.levels;
    const energy = (low + mid + high) / 3;
    const style = a.style ?? "aura";

    if (style === "halo") {
      const short = Math.min(W, H);
      const baseR = short * (0.22 + 0.05 * low);
      const grad = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, short * 0.55);
      grad.addColorStop(0, a.palette[0] + "44");
      grad.addColorStop(1, "#00000000");
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);

      a.palette.forEach((col, k) => {
        g.strokeStyle = col;
        g.lineWidth = Math.max(2, short / 240);
        g.beginPath();
        for (let i = 0; i <= 120; i++) {
          const ang = (i / 120) * Math.PI * 2;
          const r =
            baseR * (0.94 + k * 0.06) +
            Math.sin(ang * (5 + k * 4) + a.time * (1.2 + k * 0.5)) * short * 0.02 * (0.2 + (k === 0 ? low : k === 1 ? mid : high));
          const x = W / 2 + Math.cos(ang) * r;
          const y = H / 2 + Math.sin(ang) * r;
          if (i === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.closePath();
        g.stroke();
      });
      return;
    }

    if (style === "kure") {
      const short = Math.min(W, H);
      const punch = a.levels.punch ?? 0;
      const r = short * (0.25 + 0.035 * low + 0.03 * punch);
      const glow = g.createRadialGradient(W / 2, H / 2, r * 0.8, W / 2, H / 2, r * (1.7 + energy));
      glow.addColorStop(0, a.palette[1] + "55");
      glow.addColorStop(1, "#00000000");
      g.fillStyle = glow;
      g.fillRect(0, 0, W, H);
      g.beginPath();
      for (let i = 0; i <= 96; i++) {
        const ang = (i / 96) * Math.PI * 2;
        const rr =
          r *
          (1 +
            Math.sin(ang * 3 + a.time * 0.9) * (0.04 + 0.1 * low) +
            Math.sin(ang * 7 - a.time * 1.5) * (0.01 + 0.04 * mid));
        const x = W / 2 + Math.cos(ang) * rr;
        const y = H / 2 + Math.sin(ang) * rr;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      const body = g.createRadialGradient(W / 2 - r * 0.35, H / 2 - r * 0.4, r * 0.05, W / 2, H / 2, r * 1.1);
      body.addColorStop(0, "#ffffffcc");
      body.addColorStop(0.18, a.palette[2]);
      body.addColorStop(0.7, a.palette[0]);
      body.addColorStop(1, a.palette[1]);
      g.fillStyle = body;
      g.fill();
      return;
    }

    if (style === "spektrum") {
      for (let k = 0; k < 8; k++) {
        const depth = k / 7;
        const baseY = H * (0.3 + depth * 0.54);
        const band = k >= 5 ? low : k >= 2 ? mid : high;
        const amp = H * (0.018 + 0.07 * (0.35 * energy + 0.65 * band));
        g.beginPath();
        for (let x = 0; x <= W; x += 6) {
          const u = x / W - 0.5;
          const env = Math.exp(-u * u * 3);
          const y = baseY - Math.sin(u * (5 + k) + a.time * (0.5 + depth * 0.4)) * amp * env;
          if (x === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.strokeStyle = a.palette[k % 3];
        g.lineWidth = Math.max(1.5, H / 450);
        g.stroke();
      }
      return;
    }

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

export async function createCompositor(canvas: AnyCanvas): Promise<Compositor> {
  try {
    return new GpuCompositor(await getDevice(), canvas);
  } catch (e) {
    console.warn("[harfiyen] WebGPU unavailable, using 2D canvas", e);
    return new CanvasCompositor(canvas);
  }
}
