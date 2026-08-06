/** Convert LiveKit Int16 PCM frame data to Alfred Uint8Array (LE). */
export function int16ToUint8(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

/** Convert Alfred Uint8Array LE PCM to Int16Array without copying when aligned. */
export function uint8ToInt16(data: Uint8Array): Int16Array {
  if (data.byteOffset % 2 === 0) {
    return new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2));
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return new Int16Array(copy.buffer);
}
