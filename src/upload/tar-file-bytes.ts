// Reads a tar stream as it goes by and adds up the file sizes its headers
// state, so a limit can hold on file data alone and not on tar's headers,
// long-name and pax entries, and padding.

const BLOCK = 512;
// Typeflags whose data is file content: regular file (old and new), and
// contiguous file.
const FILE_TYPES = new Set([0x00, 0x30, 0x37]);
const PAX = 0x78;

// The size field is octal text, or base-256 when its top bit is set (GNU
// tar, for sizes past 8 GB).
const headerSize = (block: Buffer): number => {
  const field = block.subarray(124, 136);
  const first = field[0] ?? 0;
  if ((first & 0x80) !== 0) {
    let size = first & 0x7f;
    for (const byte of field.subarray(1)) {
      size = size * 256 + byte;
    }
    return size;
  }
  const text = field.toString("latin1").replace(/\0.*$/s, "").trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
};

// A pax header holds "<length> <key>=<value>\n" records; bsdtar puts a
// file's real size there when it does not fit the size field.
const paxSize = (data: Buffer): number | undefined => {
  let size: number | undefined;
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) {
      break;
    }
    const length = Number.parseInt(data.toString("latin1", at, space), 10);
    if (!(length > 0)) {
      break;
    }
    const record = data.toString("utf8", space + 1, at + length - 1);
    if (record.startsWith("size=")) {
      size = Number(record.slice("size=".length));
    }
    at += length;
  }
  return size;
};

const padded = (size: number) => Math.ceil(size / BLOCK) * BLOCK;

// Returns a function that takes the next chunk of the stream and gives the
// file bytes seen so far.
export const tarFileBytes = () => {
  let total = 0;
  // Bytes of the current entry's data and padding still to pass.
  let skip = 0;
  let header = Buffer.alloc(0);
  // A pax header's data while it arrives, and its length without padding.
  let pax: Array<Buffer> | undefined;
  let paxLength = 0;
  let nextSize: number | undefined;
  const endPax = () => {
    if (pax !== undefined) {
      nextSize = paxSize(Buffer.concat(pax).subarray(0, paxLength));
      pax = undefined;
    }
  };
  return (chunk: Uint8Array): number => {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
    let at = 0;
    while (at < bytes.length) {
      if (skip > 0) {
        const step = Math.min(skip, bytes.length - at);
        pax?.push(bytes.subarray(at, at + step));
        skip -= step;
        at += step;
        if (skip === 0) {
          endPax();
        }
        continue;
      }
      const step = Math.min(BLOCK - header.length, bytes.length - at);
      header = Buffer.concat([header, bytes.subarray(at, at + step)]);
      at += step;
      if (header.length < BLOCK) {
        continue;
      }
      const block = header;
      header = Buffer.alloc(0);
      const type = block[156] ?? 0;
      const own = headerSize(block);
      if (type === PAX) {
        pax = [];
        paxLength = own;
        skip = padded(own);
        if (skip === 0) {
          endPax();
        }
        continue;
      }
      const size = FILE_TYPES.has(type) ? (nextSize ?? own) : own;
      nextSize = undefined;
      if (FILE_TYPES.has(type)) {
        total += size;
      }
      skip = padded(size);
    }
    return total;
  };
};
