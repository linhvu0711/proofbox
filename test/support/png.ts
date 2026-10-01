import { inflateSync } from "node:zlib";

// The smallest PNG reader the tests need: IHDR plus inflated IDAT, the five
// row filters undone, 8-bit RGB and RGBA only — enough to find where a flat
// color sits in a screenshot.

export const findColor = (
  png: Buffer,
  match: (r: number, g: number, b: number) => boolean,
): { x: number; y: number } | undefined => {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const depth = png.readUInt8(24);
  const colorType = png.readUInt8(25);
  const bytesPerPixel = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (depth !== 8 || bytesPerPixel === 0) {
    throw new Error(`unsupported PNG: depth ${depth}, color type ${colorType}`);
  }
  const chunks: Buffer[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") {
      chunks.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw.readUInt8(y * (stride + 1));
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const up =
      y === 0
        ? Buffer.alloc(stride)
        : pixels.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x++) {
      const left = x < bytesPerPixel ? 0 : (out[x - bytesPerPixel] ?? 0);
      const above = up[x] ?? 0;
      const upperLeft = x < bytesPerPixel ? 0 : (up[x - bytesPerPixel] ?? 0);
      switch (filter) {
        case 0:
          out[x] = row[x] ?? 0;
          break;
        case 1:
          out[x] = ((row[x] ?? 0) + left) & 0xff;
          break;
        case 2:
          out[x] = ((row[x] ?? 0) + above) & 0xff;
          break;
        case 3:
          out[x] = ((row[x] ?? 0) + ((left + above) >> 1)) & 0xff;
          break;
        case 4: {
          const p = left + above - upperLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - above);
          const pc = Math.abs(p - upperLeft);
          const predictor =
            pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft;
          out[x] = ((row[x] ?? 0) + predictor) & 0xff;
          break;
        }
        default:
          throw new Error(`unsupported PNG filter: ${filter}`);
      }
    }
  }
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * bytesPerPixel;
      if (match(pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0)) {
        count += 1;
        sumX += x;
        sumY += y;
      }
    }
  }
  if (count === 0) {
    return undefined;
  }
  return { x: Math.round(sumX / count), y: Math.round(sumY / count) };
};
