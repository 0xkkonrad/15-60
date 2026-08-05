import test from 'node:test';
import assert from 'node:assert/strict';
import { createTarArchive } from '../web/archive.js';

const decoder = new TextDecoder();

function field(bytes, offset, length) {
  const end = bytes.indexOf(0, offset);
  return decoder.decode(bytes.subarray(offset, end >= offset && end < offset + length ? end : offset + length)).trim();
}

function readTar(blobBytes) {
  const files = new Map();
  for (let offset = 0; offset + 512 <= blobBytes.length;) {
    const header = blobBytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(field(header, 124, 12) || '0', 8);
    const expectedChecksum = Number.parseInt(field(header, 148, 8) || '0', 8);
    const checksumHeader = header.slice();
    checksumHeader.fill(0x20, 148, 156);
    assert.equal(checksumHeader.reduce((sum, byte) => sum + byte, 0), expectedChecksum);
    const start = offset + 512;
    files.set(path, blobBytes.slice(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

test('history TAR keeps UTF-8 metadata and byte-identical audio without base64', async () => {
  const audio = new Uint8Array([0, 255, 17, 34, 128, 9]);
  const archive = createTarArchive([
    { name: 'manifest.json', data: '{"sessionCount":1}\n' },
    { name: 'sessions/c60-test/session.json', data: '{"topic":"Gödel’s theorem"}\n' },
    { name: 'sessions/c60-test/take.webm', data: new Blob([audio], { type: 'audio/webm' }) },
  ], { modifiedAt: new Date('2026-08-05T12:00:00Z') });

  assert.equal(archive.type, 'application/x-tar');
  assert.equal(archive.size % 512, 0);
  const files = readTar(new Uint8Array(await archive.arrayBuffer()));
  assert.deepEqual([...files.keys()], [
    'manifest.json',
    'sessions/c60-test/session.json',
    'sessions/c60-test/take.webm',
  ]);
  assert.equal(decoder.decode(files.get('sessions/c60-test/session.json')), '{"topic":"Gödel’s theorem"}\n');
  assert.deepEqual(files.get('sessions/c60-test/take.webm'), audio);
});
