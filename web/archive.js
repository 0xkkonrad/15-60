const encoder = new TextEncoder();

function utf8(value) {
  return encoder.encode(String(value));
}

function writeText(target, offset, length, value) {
  const bytes = utf8(value);
  if (bytes.length > length) throw new RangeError(`TAR field is too long: ${value}`);
  target.set(bytes, offset);
}

function writeOctal(target, offset, length, value) {
  const octal = Math.max(0, Math.floor(Number(value) || 0)).toString(8);
  if (octal.length > length - 1) throw new RangeError('TAR numeric field is too large.');
  writeText(target, offset, length, `${octal.padStart(length - 1, '0')}\0`);
}

function splitPath(value) {
  const path = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
  if (!path || path.includes('\0')) throw new TypeError('A safe archive path is required.');
  if (utf8(path).length <= 100) return { name: path, prefix: '' };
  for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/', slash - 1)) {
    const prefix = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (utf8(prefix).length <= 155 && utf8(name).length <= 100) return { name, prefix };
  }
  throw new RangeError(`Archive path is too long: ${path}`);
}

function entryData(value) {
  if (value instanceof Blob) return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return utf8(value ?? '');
}

function tarHeader(name, size, modifiedAt) {
  const path = splitPath(name);
  const header = new Uint8Array(512);
  writeText(header, 0, 100, path.name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(modifiedAt.getTime() / 1000));
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  writeText(header, 257, 6, 'ustar\0');
  writeText(header, 263, 2, '00');
  writeText(header, 265, 32, '15-60');
  writeText(header, 297, 32, '15-60');
  writeText(header, 345, 155, path.prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0');
  writeText(header, 148, 8, `${checksum}\0 `);
  return header;
}

export function createTarArchive(entries, { modifiedAt = new Date() } = {}) {
  const date = modifiedAt instanceof Date ? modifiedAt : new Date(modifiedAt);
  if (Number.isNaN(date.getTime())) throw new TypeError('A valid archive date is required.');
  const parts = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const data = entryData(entry?.data);
    const size = data instanceof Blob ? data.size : data.byteLength;
    parts.push(tarHeader(entry?.name, size, date), data);
    const padding = (512 - (size % 512)) % 512;
    if (padding) parts.push(new Uint8Array(padding));
  }
  parts.push(new Uint8Array(1024));
  return new Blob(parts, { type: 'application/x-tar' });
}
