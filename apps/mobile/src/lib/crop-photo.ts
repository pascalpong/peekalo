import { File, Paths } from "expo-file-system";
import { ImageManipulator, SaveFormat, type ImageManipulatorContext, type ImageRef } from "expo-image-manipulator";
import { centerCrop916 } from "./capture-framing";
import type { Photo } from "./photo-session";

function deleteCacheFile(uri: string) {
  try {
    const file = new File(uri);
    const cachePrefix = `${Paths.cache.uri.replace(/\/+$/, "")}/`;
    if (file.uri.startsWith(cachePrefix) && file.exists) file.delete();
  } catch {
    // Cache cleanup is best effort; never expose local media paths in logs.
  }
}

function release(reference: { release(): void } | undefined) {
  try {
    reference?.release();
  } catch {
    // Releasing decoded native images must not invalidate a successfully saved draft.
  }
}

/** Owns the camera cache file, replacing it with an upright, centered 9:16 JPEG. */
export async function cropPhoto916(photo: Photo): Promise<Photo> {
  let context: ImageManipulatorContext | undefined;
  let image: ImageRef | undefined;
  let outputUri: string | undefined;
  try {
    if (!photo.uri.startsWith("file:///")) throw new Error("Invalid local capture.");
    const crop = centerCrop916(photo.width, photo.height);
    context = ImageManipulator.manipulate(photo.uri);
    image = await context.crop(crop).renderAsync();
    const output = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.9, base64: false });
    outputUri = output.uri;
    if (!outputUri.startsWith("file:///") || output.width !== crop.width || output.height !== crop.height) {
      throw new Error("Invalid cropped capture.");
    }
    return { uri: outputUri, width: output.width, height: output.height };
  } catch {
    if (outputUri && outputUri !== photo.uri) deleteCacheFile(outputUri);
    throw new Error("Could not prepare the photo. Please try again.");
  } finally {
    release(image);
    release(context);
    // Capture and crop each create an app-cache file. Keep only the returned draft.
    if (photo.uri !== outputUri) deleteCacheFile(photo.uri);
  }
}
