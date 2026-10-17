export type CaptureCrop = Readonly<{
  originX: number;
  originY: number;
  width: number;
  height: number;
}>;

/** Largest centered, whole-pixel 9:16 crop contained by the captured image. */
export function centerCrop916(width: number, height: number): CaptureCrop {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 9 || height < 16) {
    throw new Error("Invalid capture dimensions.");
  }
  const units = Math.floor(Math.min(width / 9, height / 16));
  const cropWidth = units * 9;
  const cropHeight = units * 16;
  return {
    originX: Math.floor((width - cropWidth) / 2),
    originY: Math.floor((height - cropHeight) / 2),
    width: cropWidth,
    height: cropHeight,
  };
}

/** Fit the same portrait frame into layout points without stretching its contents. */
export function frame916(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Invalid camera frame dimensions.");
  }
  const frameWidth = Math.min(width, height * (9 / 16));
  const frameHeight = frameWidth / (9 / 16);
  return {
    left: (width - frameWidth) / 2,
    top: (height - frameHeight) / 2,
    width: frameWidth,
    height: frameHeight,
  };
}
