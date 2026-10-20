import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import * as MediaLibrary from "expo-media-library";
import type { NoteStillInput } from "./note-upload";

const MAX_UPLOAD_BYTES = 200 * 1024;

async function copyToCache(uri: string, filename: string): Promise<string> {
  const dir = `${FileSystem.cacheDirectory}note-stills`;
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
  const dest = `${dir}/${filename}`;
  await FileSystem.copyAsync({ from: uri, to: dest });
  return dest;
}

async function fileBytes(uri: string): Promise<number> {
  const info = await FileSystem.getInfoAsync(uri);
  return info.exists && !info.isDirectory && typeof info.size === "number" ? info.size : 0;
}

export async function saveStillToLibrary(uri: string): Promise<void> {
  const permission = await MediaLibrary.requestPermissionsAsync(true);
  if (!permission.granted) {
    throw new Error("Photo library permission is required to save the picture.");
  }
  await MediaLibrary.saveToLibraryAsync(uri);
}

export async function prepareNoteStill(opts: {
  uri: string;
  offsetSeconds: number;
  capturedAt?: string;
}): Promise<NoteStillInput> {
  let width = 1600;
  let compress = 0.7;
  let result = await ImageManipulator.manipulateAsync(
    opts.uri,
    [{ resize: { width } }],
    { compress, format: ImageManipulator.SaveFormat.JPEG },
  );
  let size = await fileBytes(result.uri);
  while (size > MAX_UPLOAD_BYTES && compress > 0.4) {
    compress = Math.max(0.4, compress - 0.1);
    width = Math.max(1024, width - 200);
    result = await ImageManipulator.manipulateAsync(
      opts.uri,
      [{ resize: { width } }],
      { compress, format: ImageManipulator.SaveFormat.JPEG },
    );
    size = await fileBytes(result.uri);
  }

  const filename = `note-still-${Date.now()}.jpg`;
  const uri = await copyToCache(result.uri, filename);
  return {
    uri,
    filename,
    mimeType: "image/jpeg",
    offsetSeconds: Math.max(0, Math.round(opts.offsetSeconds)),
    capturedAt: opts.capturedAt ?? new Date().toISOString(),
  };
}
