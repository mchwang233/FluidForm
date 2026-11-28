// Zip archives (Python's zipfile, for what packages and downloads need): reading the central
// directory and each file stored or deflated (not ZIP64, encryption or other methods: such an archive
// is refused), and writing one.
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export class BadZipFile extends Error {}

export type ZipEntry = {
  filename: string;
  /** Unix mode in the high 16 bits, as zipfile's ``external_attr``. */
  external_attr: number;
  file_size: number;
  compress_size: number;
  isDir: boolean;
  method: number;
  offset: number;
  crc?: number;
};

const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export class ZipFile {
  readonly entries: ZipEntry[] = [];

  constructor(readonly data: Buffer) {
    const end = this.findEnd();
    const count = data.readUInt16LE(end + 10);
    let at = data.readUInt32LE(end + 16);
    if (count === 0xffff || at === 0xffffffff) throw new BadZipFile("ZIP64 archives are not supported");
    for (let i = 0; i < count; i += 1) {
      if (at + 46 > data.length || data.readUInt32LE(at) !== CENTRAL) throw new BadZipFile("Bad central directory");
      const flags = data.readUInt16LE(at + 8);
      const method = data.readUInt16LE(at + 10);
      const crc = data.readUInt32LE(at + 16);
      const compressSize = data.readUInt32LE(at + 20);
      const fileSize = data.readUInt32LE(at + 24);
      const nameLength = data.readUInt16LE(at + 28);
      const extraLength = data.readUInt16LE(at + 30);
      const commentLength = data.readUInt16LE(at + 32);
      const external = data.readUInt32LE(at + 38);
      const offset = data.readUInt32LE(at + 42);
      if (at + 46 + nameLength + extraLength + commentLength > data.length) throw new BadZipFile("Bad central directory");
      const raw = data.subarray(at + 46, at + 46 + nameLength);
      // Bit 11: the name is UTF-8; otherwise cp437, which for the ASCII names packages have is the same.
      const filename = (flags & 0x800 ? raw.toString("utf8") : raw.toString("latin1"));
      if (flags & 0x1) throw new BadZipFile(`${filename}: encrypted files are not supported`);
      this.entries.push({ filename, external_attr: external, file_size: fileSize, compress_size: compressSize, isDir: filename.endsWith("/"), method, offset, crc });
      at += 46 + nameLength + extraLength + commentLength;
    }
  }

  private findEnd(): number {
    const data = this.data;
    for (let at = data.length - 22; at >= Math.max(0, data.length - 22 - 0xffff); at -= 1) {
      if (data.readUInt32LE(at) === END && at + 22 + data.readUInt16LE(at + 20) === data.length) return at;
    }
    throw new BadZipFile("File is not a zip file");
  }

  infolist(): ZipEntry[] {
    return this.entries;
  }

  read(entry: ZipEntry | string): Buffer {
    const item = typeof entry === "string" ? this.entries.find((candidate) => candidate.filename === entry) : entry;
    if (!item) throw new BadZipFile(`There is no item named ${String(entry)} in the archive`);
    const at = item.offset;
    if (at + 30 > this.data.length || this.data.readUInt32LE(at) !== LOCAL) throw new BadZipFile(`${item.filename}: bad local header`);
    const start = at + 30 + this.data.readUInt16LE(at + 26) + this.data.readUInt16LE(at + 28);
    if (start + item.compress_size > this.data.length) throw new BadZipFile(`${item.filename}: truncated zip entry`);
    const body = this.data.subarray(start, start + item.compress_size);
    let out: Buffer;
    if (item.method === 0) out = Buffer.from(body);
    else if (item.method === 8) {
      try {
        out = inflateRawSync(body, { maxOutputLength: Math.max(1, item.file_size) });
      } catch (error) {
        throw new BadZipFile(`${item.filename}: ${(error as Error).message}`);
      }
    } else throw new BadZipFile(`${item.filename}: compression method ${item.method} is not supported`);
    if (out.length !== item.file_size) throw new BadZipFile(`${item.filename}: size does not match`);
    if (item.crc !== undefined && (crc32(out) >>> 0) !== item.crc) throw new BadZipFile(`${item.filename}: bad CRC-32`);
    return out;
  }
}


export type ZipEntryToWrite = { name: string; data: string | Buffer; mode?: number; deflate?: boolean; modified?: Date };

/** A time as zip stores it (MS-DOS, local time, two-second steps; 1980 at the earliest). */
function dosTime(when: Date): [number, number] {
  const year = Math.max(1980, when.getFullYear());
  return [(when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2), ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()];
}

/** A zip of ``entries`` (zipfile.ZipFile(..., "w")): each stored, or deflated; ``mode`` sets its Unix mode. */
export function writeZip(entries: ZipEntryToWrite[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const crc = crc32(data) >>> 0;
    const stored = entry.deflate ? deflateRawSync(data) : data;
    const method = entry.deflate ? 8 : 0;
    const [time, date] = dosTime(entry.modified ?? new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made on Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
