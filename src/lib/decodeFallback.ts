/**
 * Fallback for files the worker cannot demux/decode with WebCodecs: let the
 * browser's own media stack decode (and resample to 16 kHz mono) the whole file.
 * Uses more memory, so it is only tried when the streaming path fails.
 */
export async function decodeWithAudioContext(file: File): Promise<Float32Array> {
  const data = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const buf = await ctx.decodeAudioData(data);
  if (buf.numberOfChannels === 1) return buf.getChannelData(0);
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / buf.numberOfChannels;
  }
  return out;
}
