// Small deterministic ZIP writer using Node built-ins; no packaging dependencies.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = table[(crc ^ b) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function walk(dir, prefix = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((item) =>
    item.isDirectory() ? walk(path.join(dir, item.name), prefix + item.name + "/")
      : [{ name: prefix + item.name, file: path.join(dir, item.name) }]);
}
function zip(destination, files) {
  const parts = [], central = [], digests = [];
  let offset = 0;
  for (const { name, file } of files) {
    assert.ok(!name.includes("..") && !name.startsWith("/"));
    const plain = fs.readFileSync(file), compressed = zlib.deflateRawSync(plain, { level: 9 });
    const filename = Buffer.from(name), crc = crc32(plain);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12); // Fixed DOS date 1980-01-01 for reproducible archives.
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(plain.length, 22); local.writeUInt16LE(filename.length, 26);
    parts.push(local, filename, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(plain.length, 24); entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    offset += local.length + filename.length + compressed.length;
    // Independent decompression/CRC check before publishing the archive.
    assert.ok(zlib.inflateRawSync(compressed).equals(plain));
    digests.push({ name, sha256: crypto.createHash("sha256").update(plain).digest("hex") });
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...parts, directory, end]);
  fs.writeFileSync(path.join(root, destination), archive);
  console.log(destination + ": " + archive.length + " bytes; " + files.length + " files verified.");
  return digests;
}
const extension = walk(path.join(root, "ram-watch"));
zip("ram-watch.zip", extension);
const runnable = ["Install.cmd", "Start-RAM-Watch.cmd", "Uninstall.cmd", "bin/RamWatch.Native.exe"]
  .map((name) => ({ name: "companion/" + name, file: path.join(root, "companion", name) }));
const entries = zip("ram-watch-complete.zip", [
  ...extension.map((e) => ({ ...e, name: "ram-watch/" + e.name })), ...runnable,
  { name: "README.md", file: path.join(root, "README.md") },
  { name: "tests/verification.json", file: path.join(root, "tests/verification.json") },
]);
fs.writeFileSync(path.join(root, "tests/package-manifest.json"), JSON.stringify(entries, null, 2) + "\n");
