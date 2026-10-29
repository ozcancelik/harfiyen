// The user's background media (photo or looping muted video): kept in this
// browser (IndexedDB) and shared by every project, drawn over the whole frame
// in place of the aura. Whether a project uses it, and blurred or not, is part
// of the caption settings.

import { useSyncExternalStore } from "react";
import { deleteAsset, getAsset, saveAsset, stripExt } from "./projectStore";

export interface UserPhoto {
  kind: "image" | "video";
  name: string;
  /** Object URL for the media file itself. */
  url: string;
  /** Object URL for the small thumbnail in the Sahne panel. */
  thumbUrl: string;
  /** Rasterised still (the image itself, or a frame from the video for style cards). */
  bitmap: ImageBitmap;
  /** The video file when `kind === "video"`; null for a still image. */
  video: Blob | null;
}

const RASTER = 3840;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;

let state: { photo: UserPhoto | null; ready: boolean } = { photo: null, ready: false };
const subscribers = new Set<() => void>();

function publish(photo: UserPhoto | null) {
  const old = state.photo;
  if (old && old !== photo) {
    URL.revokeObjectURL(old.url);
    if (old.thumbUrl !== old.url) URL.revokeObjectURL(old.thumbUrl);
    // The player may draw it once more before it hears of the new one.
    setTimeout(() => old.bitmap.close(), 1000);
  }
  state = { photo, ready: true };
  for (const f of subscribers) f();
}

function subscribe(f: () => void) {
  subscribers.add(f);
  return () => void subscribers.delete(f);
}

const isVideoBlob = (blob: Blob, name: string) =>
  blob.type.startsWith("video/") ||
  (!blob.type.startsWith("image/") && /\.(mp4|webm|mov|m4v|mkv)$/i.test(name));

async function decodeImage(name: string, blob: Blob): Promise<UserPhoto> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 512;
    const h = img.naturalHeight || 512;
    const svg = blob.type === "image/svg+xml";
    const scale = svg ? RASTER / Math.max(w, h) : Math.min(1, RASTER / Math.max(w, h));
    const bitmap = await createImageBitmap(img, {
      resizeWidth: Math.max(1, Math.round(w * scale)),
      resizeHeight: Math.max(1, Math.round(h * scale)),
      resizeQuality: "high",
    });
    return { kind: "image", name, url, thumbUrl: url, bitmap, video: null };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

async function decodeVideo(name: string, blob: Blob): Promise<UserPhoto> {
  const url = URL.createObjectURL(blob);
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      v.onloadeddata = () => resolve();
      v.onerror = () => reject(new Error("unreadable"));
      v.load();
    });
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (!w || !h) throw new Error("unreadable");
    // Step slightly past 0:00 when possible so fade-in videos have a visible still frame.
    if (Number.isFinite(v.duration) && v.duration > 0.15) {
      v.currentTime = Math.min(0.5, v.duration * 0.1);
      await new Promise<void>((resolve) => {
        v.onseeked = () => resolve();
        v.onerror = () => resolve();
      });
    }
    const scale = Math.min(1, RASTER / Math.max(w, h));
    const bitmap = await createImageBitmap(v, {
      resizeWidth: Math.max(1, Math.round(w * scale)),
      resizeHeight: Math.max(1, Math.round(h * scale)),
      resizeQuality: "high",
    });
    const tScale = Math.min(1, 320 / Math.max(w, h));
    const thumbCanvas = new OffscreenCanvas(Math.max(1, Math.round(w * tScale)), Math.max(1, Math.round(h * tScale)));
    thumbCanvas.getContext("2d")!.drawImage(bitmap, 0, 0, thumbCanvas.width, thumbCanvas.height);
    const thumbBlob = await thumbCanvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
    const thumbUrl = URL.createObjectURL(thumbBlob);
    return { kind: "video", name, url, thumbUrl, bitmap, video: blob };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  } finally {
    v.removeAttribute("src");
    v.load();
  }
}

async function toMedia(name: string, blob: Blob): Promise<UserPhoto> {
  if (isVideoBlob(blob, name)) return decodeVideo(name, blob);
  return decodeImage(name, blob);
}

getAsset("photo")
  .then(async (l) => publish(l ? await toMedia(l.name, l.blob) : null))
  .catch(() => publish(null));

/** The background photo or video, null when there is none; `ready` once storage has been read. */
export const usePhoto = () => useSyncExternalStore(subscribe, () => state);

export async function setPhotoFile(file: File): Promise<void> {
  const video = isVideoBlob(file, file.name);
  if (video && file.size > MAX_VIDEO_BYTES) throw new Error("Video çok büyük (250 MB üstü).");
  if (!video && file.size > MAX_IMAGE_BYTES) throw new Error("Fotoğraf çok büyük (25 MB üstü).");
  let media: UserPhoto;
  try {
    media = await toMedia(stripExt(file.name), file);
  } catch {
    throw new Error(
      video
        ? "Bu dosya video olarak açılamadı (MP4, WebM ya da MOV olmalı ve görüntü içermeli)."
        : "Bu dosya resim olarak açılamadı (JPEG, PNG, WebP ya da SVG olmalı).",
    );
  }
  await saveAsset("photo", { name: media.name, blob: file });
  publish(media);
}

export async function removePhoto(): Promise<void> {
  await deleteAsset("photo");
  publish(null);
}

