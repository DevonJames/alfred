/**
 * Download a note's audio with the device token, then play a local file.
 *
 * Desktop `/notes/:id/audio` is unauthenticated localhost, so the Mac UI works.
 * The phone must hit `/api/notes/:id/audio`, and iOS AVPlayer drops Authorization
 * headers — so we never stream that URL. LAN uses one authenticated fetch;
 * the alfrd.net relay corrupts binary, so we pull 256 KB JSON slices.
 */
import { File, Paths } from "expo-file-system";
import { isRelayUrl, useConnection } from "./connection";
import { assetHeaders, assetUrl, getNoteAudioChunk, getNoteAudioMeta } from "./desktop-api";

function decodeBase64(data: string): Uint8Array {
  const binary = globalThis.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function cacheFile(noteId: string): File {
  return new File(Paths.cache, `note-audio-${noteId}.m4a`);
}

async function writeCache(file: File, bytes: Uint8Array): Promise<string> {
  if (file.exists) file.delete();
  file.create();
  file.write(bytes);
  return file.uri;
}

async function downloadWholeFile(noteId: string, byteLength: number): Promise<string> {
  const uri = assetUrl(`/api/notes/${encodeURIComponent(noteId)}/audio`);
  if (!uri) throw new Error("Not connected to your Mac.");
  const response = await fetch(uri, { headers: assetHeaders() });
  if (!response.ok) {
    throw new Error(`Couldn't download that recording (${response.status}).`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (byteLength > 0 && bytes.byteLength !== byteLength) {
    throw new Error("The recording download was incomplete.");
  }
  return writeCache(cacheFile(noteId), bytes);
}

async function downloadRelayedChunks(noteId: string, totalChunks: number, byteLength: number): Promise<string> {
  const file = cacheFile(noteId);
  if (file.exists) file.delete();
  file.create();
  const handle = file.open();
  try {
    for (let index = 0; index < totalChunks; index += 1) {
      const chunk = await getNoteAudioChunk(noteId, index);
      handle.writeBytes(decodeBase64(chunk.data));
    }
  } catch (err) {
    handle.close();
    if (file.exists) file.delete();
    throw err;
  }
  handle.close();
  if (byteLength > 0 && file.size !== byteLength) {
    file.delete();
    throw new Error("The recording download was incomplete.");
  }
  return file.uri;
}

export async function playableNoteAudio(noteId: string): Promise<{ uri: string }> {
  const serverUrl = useConnection.getState().serverUrl;
  if (!serverUrl) throw new Error("Not connected to your Mac.");

  const meta = await getNoteAudioMeta(noteId);
  const file = cacheFile(noteId);
  if (file.exists && file.size === meta.byteLength) {
    return { uri: file.uri };
  }

  if (isRelayUrl(serverUrl)) {
    return { uri: await downloadRelayedChunks(noteId, meta.totalChunks, meta.byteLength) };
  }
  return { uri: await downloadWholeFile(noteId, meta.byteLength) };
}
