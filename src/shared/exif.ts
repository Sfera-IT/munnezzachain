// Minimal EXIF reader and writer for JPEG, dependency-free so the browser and the Worker share it.
// It only knows the tags this project needs: provenance (Make/Model/Software/dates) and GPS.

export interface GpsData {
  lat: number;
  lon: number;
  altitude?: number;
  /** Horizontal positioning error in metres (GPSHPositioningError). */
  accuracy?: number;
  /** Degrees from true north. */
  heading?: number;
  /** UTC time of the fix, ISO 8601. */
  time?: string;
}

export interface ExifInfo {
  make?: string;
  model?: string;
  software?: string;
  imageDescription?: string;
  dateTime?: string;
  dateTimeOriginal?: string;
  offsetTimeOriginal?: string;
  /** Written only: pixel dimensions of the encoded image. */
  pixelWidth?: number;
  pixelHeight?: number;
  gps?: GpsData;
  /** A GPS IFD is present but carries no usable coordinates — the signature of a client that stripped them. */
  gpsZeroed?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Reading

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

type TagValue = string | number[] | Uint8Array;

class Tiff {
  private view: DataView;
  private le: boolean;

  constructor(view: DataView, le: boolean) {
    this.view = view;
    this.le = le;
  }

  u16 = (o: number) => this.view.getUint16(o, this.le);
  u32 = (o: number) => this.view.getUint32(o, this.le);

  readIfd(offset: number): Map<number, TagValue> {
    const tags = new Map<number, TagValue>();
    if (offset + 2 > this.view.byteLength) return tags;
    const count = this.u16(offset);
    for (let i = 0; i < count; i++) {
      const e = offset + 2 + i * 12;
      if (e + 12 > this.view.byteLength) break;
      const tag = this.u16(e);
      const type = this.u16(e + 2);
      const n = this.u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 0) * n;
      if (size === 0 || size > 1 << 20) continue;
      const at = size <= 4 ? e + 8 : this.u32(e + 8);
      if (at + size > this.view.byteLength) continue;
      tags.set(tag, this.value(type, n, at));
    }
    return tags;
  }

  private value(type: number, n: number, at: number): TagValue {
    const v = this.view;
    switch (type) {
      case 2: {
        const bytes = new Uint8Array(v.buffer, v.byteOffset + at, n);
        const end = bytes.indexOf(0);
        return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end)).trim();
      }
      case 1:
      case 7:
        return new Uint8Array(v.buffer.slice(v.byteOffset + at, v.byteOffset + at + n));
      case 3:
        return Array.from({ length: n }, (_, i) => this.u16(at + i * 2));
      case 4:
        return Array.from({ length: n }, (_, i) => this.u32(at + i * 4));
      case 9:
        return Array.from({ length: n }, (_, i) => v.getInt32(at + i * 4, this.le));
      case 5:
      case 10: {
        const out: number[] = [];
        for (let i = 0; i < n; i++) {
          const num = type === 5 ? this.u32(at + i * 8) : v.getInt32(at + i * 8, this.le);
          const den = type === 5 ? this.u32(at + i * 8 + 4) : v.getInt32(at + i * 8 + 4, this.le);
          out.push(den === 0 ? NaN : num / den);
        }
        return out;
      }
    }
    return [];
  }
}

/** Returns the TIFF payload of the first APP1 Exif segment, or null. */
export function findExifTiff(jpeg: Uint8Array): Uint8Array | null {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  let o = 2;
  while (o + 4 <= jpeg.length) {
    if (jpeg[o] !== 0xff) return null;
    const marker = jpeg[o + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      o += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null;
    const len = (jpeg[o + 2]! << 8) | jpeg[o + 3]!;
    if (marker === 0xe1 && len >= 8 && String.fromCharCode(...jpeg.subarray(o + 4, o + 10)) === "Exif\0\0") {
      return jpeg.subarray(o + 10, o + 2 + len);
    }
    o += 2 + len;
  }
  return null;
}

const str = (v: TagValue | undefined) => (typeof v === "string" && v.length > 0 ? v : undefined);
const nums = (v: TagValue | undefined) => (Array.isArray(v) ? v : undefined);

function dms(v: TagValue | undefined, ref: TagValue | undefined, negative: string): number | undefined {
  const a = nums(v);
  if (!a || a.length < 3 || a.some((x) => !Number.isFinite(x))) return undefined;
  const deg = a[0]! + a[1]! / 60 + a[2]! / 3600;
  return str(ref) === negative ? -deg : deg;
}

export function readExif(jpeg: Uint8Array): ExifInfo | null {
  const tiff = findExifTiff(jpeg);
  if (!tiff || tiff.length < 8) return null;
  try {
    const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const order = String.fromCharCode(tiff[0]!, tiff[1]!);
    if (order !== "II" && order !== "MM") return null;
    const t = new Tiff(view, order === "II");
    if (t.u16(2) !== 42) return null;
    const ifd0 = t.readIfd(t.u32(4));
    const exifPtr = nums(ifd0.get(0x8769))?.[0];
    const gpsPtr = nums(ifd0.get(0x8825))?.[0];
    const exif = exifPtr ? t.readIfd(exifPtr) : new Map<number, TagValue>();
    const info: ExifInfo = {
      make: str(ifd0.get(0x010f)),
      model: str(ifd0.get(0x0110)),
      software: str(ifd0.get(0x0131)),
      imageDescription: str(ifd0.get(0x010e)),
      dateTime: str(ifd0.get(0x0132)),
      dateTimeOriginal: str(exif.get(0x9003)),
      offsetTimeOriginal: str(exif.get(0x9011)),
    };
    if (gpsPtr) {
      const g = t.readIfd(gpsPtr);
      const lat = dms(g.get(0x0002), g.get(0x0001), "S");
      const lon = dms(g.get(0x0004), g.get(0x0003), "W");
      // 0,0 with no hemisphere reference is what Gmail/Outlook leave behind after scrubbing.
      const usable = lat !== undefined && lon !== undefined && !(lat === 0 && lon === 0 && !str(g.get(0x0001)));
      if (usable) {
        const gps: GpsData = { lat, lon };
        const alt = nums(g.get(0x0006))?.[0];
        if (alt !== undefined && Number.isFinite(alt)) {
          const below = g.get(0x0005) instanceof Uint8Array && (g.get(0x0005) as Uint8Array)[0] === 1;
          gps.altitude = below ? -alt : alt;
        }
        const acc = nums(g.get(0x001f))?.[0];
        if (acc !== undefined && Number.isFinite(acc)) gps.accuracy = acc;
        const dir = nums(g.get(0x0011))?.[0];
        if (dir !== undefined && Number.isFinite(dir)) gps.heading = dir;
        const date = str(g.get(0x001d));
        const hms = nums(g.get(0x0007));
        if (date && hms && hms.length === 3 && hms.every(Number.isFinite)) {
          const [y, m, d] = date.split(":");
          const secs = hms[0]! * 3600 + hms[1]! * 60 + hms[2]!;
          const ms = Date.UTC(Number(y), Number(m) - 1, Number(d)) + Math.round(secs * 1000);
          if (Number.isFinite(ms)) gps.time = new Date(ms).toISOString();
        }
        info.gps = gps;
      } else {
        info.gpsZeroed = true;
      }
    }
    for (const k of Object.keys(info) as (keyof ExifInfo)[]) if (info[k] === undefined) delete info[k];
    return info;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Writing

type Entry = { tag: number; type: 1 | 2 | 3 | 4 | 5 | 7; data: Uint8Array; count: number };

const ascii = (tag: number, s: string): Entry => {
  const data = new TextEncoder().encode(s + "\0");
  return { tag, type: 2, data, count: data.length };
};
const bytesEntry = (tag: number, type: 1 | 7, b: number[]): Entry => ({ tag, type, data: new Uint8Array(b), count: b.length });
const short = (tag: number, v: number): Entry => {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint16(0, v);
  return { tag, type: 3, data: data.subarray(0, 2), count: 1 };
};
const long = (tag: number, v: number): Entry => {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, v);
  return { tag, type: 4, data, count: 1 };
};
const rational = (tag: number, pairs: [number, number][]): Entry => {
  const data = new Uint8Array(pairs.length * 8);
  const dv = new DataView(data.buffer);
  pairs.forEach(([n, d], i) => {
    dv.setUint32(i * 8, n);
    dv.setUint32(i * 8 + 4, d);
  });
  return { tag, type: 5, data, count: pairs.length };
};

function toDms(value: number): [number, number][] {
  const total = Math.round(Math.abs(value) * 3600 * 10000); // units of 1/10000 arc-second
  const deg = Math.floor(total / 36_000_000);
  const min = Math.floor((total - deg * 36_000_000) / 600_000);
  const sec = total - deg * 36_000_000 - min * 600_000;
  return [
    [deg, 1],
    [min, 1],
    [sec, 10000],
  ];
}

const ifdSize = (entries: Entry[]) => {
  const data = entries.reduce((n, e) => n + (e.data.length > 4 ? e.data.length + (e.data.length % 2) : 0), 0);
  return 2 + entries.length * 12 + 4 + data;
};

function writeIfd(out: DataView, bytes: Uint8Array, offset: number, entries: Entry[]) {
  entries.sort((a, b) => a.tag - b.tag);
  out.setUint16(offset, entries.length);
  let dataAt = offset + 2 + entries.length * 12 + 4;
  entries.forEach((e, i) => {
    const at = offset + 2 + i * 12;
    out.setUint16(at, e.tag);
    out.setUint16(at + 2, e.type);
    out.setUint32(at + 4, e.count);
    if (e.data.length <= 4) {
      bytes.set(e.data, at + 8);
    } else {
      out.setUint32(at + 8, dataAt);
      bytes.set(e.data, dataAt);
      dataAt += e.data.length + (e.data.length % 2);
    }
  });
  out.setUint32(offset + 2 + entries.length * 12, 0);
}

/** EXIF local date format: "YYYY:MM:DD HH:MM:SS" in the device's local time, plus its "+HH:MM" offset. */
export function exifLocalDate(d: Date): { dateTime: string; offset: string } {
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return {
    dateTime: `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
    offset: `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`,
  };
}

/** Builds a complete APP1 segment (marker included) holding a big-endian TIFF structure. */
export function buildExifSegment(info: ExifInfo): Uint8Array {
  const ifd0: Entry[] = [];
  if (info.imageDescription) ifd0.push(ascii(0x010e, info.imageDescription));
  if (info.make) ifd0.push(ascii(0x010f, info.make));
  if (info.model) ifd0.push(ascii(0x0110, info.model));
  if (info.software) ifd0.push(ascii(0x0131, info.software));
  if (info.dateTime) ifd0.push(ascii(0x0132, info.dateTime));
  ifd0.push(short(0x0213, 1)); // YCbCrPositioning: centered

  const exif: Entry[] = [
    bytesEntry(0x9000, 7, [0x30, 0x32, 0x33, 0x32]), // ExifVersion 0232
    bytesEntry(0x9101, 7, [1, 2, 3, 0]), // ComponentsConfiguration: YCbCr
    short(0xa001, 1), // ColorSpace: sRGB
  ];
  if (info.pixelWidth && info.pixelHeight) exif.push(long(0xa002, info.pixelWidth), long(0xa003, info.pixelHeight));
  if (info.dateTimeOriginal) exif.push(ascii(0x9003, info.dateTimeOriginal));
  if (info.offsetTimeOriginal) exif.push(ascii(0x9011, info.offsetTimeOriginal));

  const gps: Entry[] = [];
  const g = info.gps;
  if (g) {
    gps.push(bytesEntry(0x0000, 1, [2, 3, 0, 0]));
    gps.push(ascii(0x0001, g.lat >= 0 ? "N" : "S"), rational(0x0002, toDms(g.lat)));
    gps.push(ascii(0x0003, g.lon >= 0 ? "E" : "W"), rational(0x0004, toDms(g.lon)));
    if (g.altitude !== undefined && Number.isFinite(g.altitude)) {
      gps.push(bytesEntry(0x0005, 1, [g.altitude < 0 ? 1 : 0]), rational(0x0006, [[Math.round(Math.abs(g.altitude) * 100), 100]]));
    }
    if (g.time) {
      const t = new Date(g.time);
      const secs = t.getUTCSeconds() * 1000 + t.getUTCMilliseconds();
      gps.push(rational(0x0007, [[t.getUTCHours(), 1], [t.getUTCMinutes(), 1], [secs, 1000]]));
      const p = (n: number) => String(n).padStart(2, "0");
      gps.push(ascii(0x001d, `${t.getUTCFullYear()}:${p(t.getUTCMonth() + 1)}:${p(t.getUTCDate())}`));
    }
    if (g.heading !== undefined && Number.isFinite(g.heading)) {
      gps.push(ascii(0x0010, "T"), rational(0x0011, [[Math.round(g.heading * 100), 100]]));
    }
    gps.push(ascii(0x0012, "WGS-84"));
    if (g.accuracy !== undefined && Number.isFinite(g.accuracy)) {
      gps.push(rational(0x001f, [[Math.round(g.accuracy * 100), 100]]));
    }
  }

  ifd0.push(long(0x8769, 0));
  if (gps.length) ifd0.push(long(0x8825, 0));

  const ifd0At = 8;
  const exifAt = ifd0At + ifdSize(ifd0);
  const gpsAt = exifAt + ifdSize(exif);
  const total = gpsAt + (gps.length ? ifdSize(gps) : 0);
  ifd0.find((e) => e.tag === 0x8769)!.data = long(0, exifAt).data;
  if (gps.length) ifd0.find((e) => e.tag === 0x8825)!.data = long(0, gpsAt).data;

  const tiff = new Uint8Array(total);
  const dv = new DataView(tiff.buffer);
  tiff.set([0x4d, 0x4d, 0x00, 0x2a]);
  dv.setUint32(4, ifd0At);
  writeIfd(dv, tiff, ifd0At, ifd0);
  writeIfd(dv, tiff, exifAt, exif);
  if (gps.length) writeIfd(dv, tiff, gpsAt, gps);

  const segLen = 2 + 6 + tiff.length;
  if (segLen > 0xffff) throw new Error("segmento EXIF troppo grande");
  const seg = new Uint8Array(2 + segLen);
  seg.set([0xff, 0xe1, segLen >> 8, segLen & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0]);
  seg.set(tiff, 10);
  return seg;
}

/** Returns a new JPEG whose Exif APP1 segments are replaced by `segment`, placed right after SOI. */
export function replaceExif(jpeg: Uint8Array, segment: Uint8Array): Uint8Array {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("non è un JPEG");
  const kept: Uint8Array[] = [];
  let o = 2;
  while (o + 4 <= jpeg.length) {
    if (jpeg[o] !== 0xff) throw new Error("JPEG malformato");
    const marker = jpeg[o + 1]!;
    if (marker === 0xda) break;
    const len = (jpeg[o + 2]! << 8) | jpeg[o + 3]!;
    const isExif = marker === 0xe1 && String.fromCharCode(...jpeg.subarray(o + 4, o + 10)) === "Exif\0\0";
    if (!isExif) kept.push(jpeg.subarray(o, o + 2 + len));
    o += 2 + len;
  }
  const rest = jpeg.subarray(o);
  const size = 2 + segment.length + kept.reduce((n, k) => n + k.length, 0) + rest.length;
  const out = new Uint8Array(size);
  out.set([0xff, 0xd8]);
  let at = 2;
  out.set(segment, at);
  at += segment.length;
  for (const k of kept) {
    out.set(k, at);
    at += k.length;
  }
  out.set(rest, at);
  return out;
}

/** Great-circle distance in metres. */
export function distanceMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
