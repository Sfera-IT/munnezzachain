// Store-only ZIP writer: evidence files must reach the reader byte-identical, so nothing is compressed.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  date?: Date;
}

/** An entry whose bytes are only loaded when it is its turn to be written. */
export interface LazyZipEntry {
  name: string;
  date?: Date;
  load: () => Promise<Uint8Array>;
}

class ZipWriter {
  private enc = new TextEncoder();
  private centrals: Uint8Array[] = [];
  private offset = 0;
  private count = 0;

  /** Returns the local header followed by the data. */
  entry(e: ZipEntry): Uint8Array[] {
    const name = this.enc.encode(e.name);
    const d = e.date ?? new Date();
    const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
    const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
    const crc = crc32(e.data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, this.offset, true);
    central.set(name, 46);

    this.centrals.push(central);
    this.offset += local.length + e.data.length;
    this.count++;
    return [local, e.data];
  }

  /** Returns the central directory and the end record. */
  finish(): Uint8Array[] {
    const centralSize = this.centrals.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, this.count, true);
    ev.setUint16(10, this.count, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, this.offset, true);
    return [...this.centrals, end];
  }
}

export function buildZip(entries: ZipEntry[]): Uint8Array {
  const zip = new ZipWriter();
  const parts = [...entries.flatMap((e) => zip.entry(e)), ...zip.finish()];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Streams a ZIP holding one entry in memory at a time: an evidence package with ten full-resolution photos and
 * their GPS copies would not fit in a Worker isolate if it were assembled whole.
 */
export function streamZip(entries: LazyZipEntry[]): ReadableStream<Uint8Array> {
  const zip = new ZipWriter();
  let next = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (next === entries.length) {
        for (const part of zip.finish()) controller.enqueue(part);
        controller.close();
        return;
      }
      const e = entries[next++]!;
      for (const part of zip.entry({ name: e.name, date: e.date, data: await e.load() })) controller.enqueue(part);
    },
  });
}
