/**
 * Download a note still with the device token, then show a local file.
 *
 * Desktop `/notes/:id/photos/:photoId` is unauthenticated localhost.
 * The phone must hit `/api/notes/...`, and expo-image cannot send Authorization
 * on a remote URL — LAN uses one authenticated fetch; the relay uses JSON slices.
 */
import { File, Paths } from "expo-file-system";
import { isRelayUrl, useConnection } from "./connection";
import { assetHeaders, assetUrl, getNotePhotoChunk, getNotePhotoMeta } from "./desktop-api";

function decodeBase64(data: string): Uint8Array {
  const binary = globalThis.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function cacheFile(noteId: string, photoId: string): File {
  const safe = photoId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-48);
  return new File(Paths.cache, `note-photo-${noteId.slice(-12)}-${safe}.jpg`);
}

async function writeCache(file: File, bytes: Uint8Array): Promise<string> {
  if (file.exists) file.delete();
  file.create();
  file.write(bytes);
  return file.uri;
}

async function downloadWholeFile(noteId: string, photoId: string, byteLength: number): Promise<string> {
  const uri = assetUrl(
    `/api/notes/${encodeURIComponent(noteId)}/photos/${encodeURIComponent(photoId)}`,
  );
  if (!uri) throw new Error("Not connected to your Mac.");
  const response = await fetch(uri, { headers: assetHeaders() });
  if (!response.ok) {
    throw new Error(`Couldn't download that still (${response.status}).`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (byteLength > 0 && bytes.byteLength !== byteLength) {
    throw new Error("The still download was incomplete.");
  }
  return writeCache(cacheFile(noteId, photoId), bytes);
}

async function downloadRelayedChunks(
  noteId: string,
  photoId: string,
  totalChunks: number,
  byteLength: number,
): Promise<string> {
  const file = cacheFile(noteId, photoId);
  if (file.exists) file.delete();
  file.create();
  const handle = file.open();
  try {
    for (let index = 0; index < totalChunks; index += 1) {
      const chunk = await getNotePhotoChunk(noteId, photoId, index);
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
    throw new Error("The still download was incomplete.");
  }
  return file.uri;
}

export async function visibleNotePhoto(noteId: string, photoId: string): Promise<{ uri: string }> {
  const serverUrl = useConnection.getState().serverUrl;
  if (!serverUrl) throw new Error("Not connected to your Mac.");

  const meta = await getNotePhotoMeta(noteId, photoId);
  const file = cacheFile(noteId, photoId);
  if (file.exists && file.size === meta.byteLength) {
    return { uri: file.uri };
  }

  if (isRelayUrl(serverUrl)) {
    return { uri: await downloadRelayedChunks(noteId, photoId, meta.totalChunks, meta.byteLength) };
  }
  return { uri: await downloadWholeFile(noteId, photoId, meta.byteLength) };
}
