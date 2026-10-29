// Exercises the compiled WinHTTP/native-messaging path against a local CDP fixture.
// Does not launch Chrome, install the host, or touch a browser profile.
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const root = path.resolve(__dirname, "..");
const production = path.join(root, "companion/bin/RamWatch.Native.exe");
const testHost = path.join(root, "companion/bin/RamWatch.Native.test.exe");
let externalStep = 0;

// Some managed Windows environments allow processes through the terminal tool
// but prohibit Node from spawning children. This runner separates those steps.
async function externalRun(exe, data, port) {
  const step = externalStep++;
  const prefix = "tests/.native-" + step;
  fs.writeFileSync(path.join(root, prefix + ".in"), data);
  const command = "@echo off\r\nset \"RAMWATCH_TEST_PORT=" + port + "\"\r\n" +
    "companion\\bin\\" + path.basename(exe) + " <" + prefix + ".in >" + prefix + ".out\r\n" +
    "echo %errorlevel% >" + prefix + ".done\r\n";
  fs.writeFileSync(path.join(root, prefix + ".cmd"), command);
  console.log("External runner ready: " + prefix + ".cmd");
  const deadline = Date.now() + 60000;
  while (!fs.existsSync(path.join(root, prefix + ".done"))) {
    assert.ok(Date.now() < deadline, "External runner timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(Number(fs.readFileSync(path.join(root, prefix + ".done"), "utf8")), 0);
  const payload = fs.readFileSync(path.join(root, prefix + ".out"));
  assert.equal(payload.readUInt32LE(0), payload.length - 4);
  return JSON.parse(payload.subarray(4));
}

function framed(value) {
  const data = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(data.length);
  return Buffer.concat([header, data]);
}
function frame(text, opcode = 1, final = true) {
  const data = Buffer.from(text), header = Buffer.alloc(data.length < 126 ? 2 : 4);
  header[0] = (final ? 128 : 0) | opcode;
  if (data.length < 126) header[1] = data.length;
  else { header[1] = 126; header.writeUInt16BE(data.length, 2); }
  return Buffer.concat([header, data]);
}
function run(exe, data, port) {
  if (process.env.RAMWATCH_TEST_EXTERNAL === "1") return externalRun(exe, data, port);
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [], {
      windowsHide: true, env: { ...process.env, RAMWATCH_TEST_PORT: String(port) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = [], stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(Error("Host exceeded test deadline")); }, 14000);
    child.stdout.on("data", (bytes) => out.push(bytes));
    child.stderr.on("data", (bytes) => { stderr += bytes; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        assert.equal(code, 0, stderr);
        const payload = Buffer.concat(out);
        assert.equal(payload.readUInt32LE(0), payload.length - 4, "Native length prefix");
        resolve(JSON.parse(payload.subarray(4)));
      } catch (e) { reject(e); }
    });
    // Deliberately split the framing header and body across writes.
    child.stdin.write(data.subarray(0, 2));
    child.stdin.end(data.subarray(2));
  });
}

(async () => {
  const sockets = new Set(), commands = [];
  const server = http.createServer((req, res) => {
    const port = server.address().port;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(["one", "two", "busy", "navigated"].map((id) => ({
      id, type: "page", url: "https://same-url.test/",
      webSocketDebuggerUrl: "ws://127.0.0.1:" + port + "/devtools/page/" + id,
    }))));
  });
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const target = req.url.split("/").at(-1);
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] +
      "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
    let pending = Buffer.alloc(0);
    const send = (obj, fragmented = false) => {
      const s = JSON.stringify(obj);
      socket.write(fragmented ? Buffer.concat([frame(s.slice(0, 20), 1, false), frame(s.slice(20), 0)]) : frame(s));
    };
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const opcode = pending[0] & 15, masked = !!(pending[1] & 128);
        let n = pending[1] & 127, offset = 2;
        if (n === 126) { if (pending.length < 4) return; n = pending.readUInt16BE(2); offset = 4; }
        assert.notEqual(n, 127, "Fixture messages stay bounded");
        const maskAt = offset;
        if (masked) offset += 4;
        if (pending.length < offset + n) return;
        const bytes = Buffer.from(pending.subarray(offset, offset + n));
        if (masked) for (let i = 0; i < n; i++) bytes[i] ^= pending[maskAt + (i % 4)];
        pending = pending.subarray(offset + n);
        if (opcode === 8) { socket.end(frame("", 8)); return; }
        const msg = JSON.parse(bytes.toString());
        commands.push({ target, method: msg.method });
        if (msg.method === "Page.getFrameTree") {
          send({ id: msg.id, result: { frameTree: { frame: { id: "frame-" + target } } } });
        } else if (msg.method === "Tracing.start") {
          if (target === "busy") send({ id: msg.id, error: { message: "Tracing has already been started" } });
          else send({ id: msg.id, result: {} });
        } else if (msg.method === "Tracing.end") {
          const values = [{
            name: "TracingStartedInBrowser",
            args: { data: { frames: [
              { frame: "unrelated", processId: 999999 },
              { frame: "frame-" + target, processId: 1 }, // test build maps this to its own PID
            ] } },
          }];
          if (target === "navigated") values.push({
            name: "FrameCommittedInBrowser", args: { data: { frame: "frame-" + target, processId: 2 } },
          });
          // Events may arrive before the command reply; UTF-8 may be fragmented.
          send({ method: "Tracing.dataCollected", params: { value: values } }, true);
          send({ id: msg.id, result: {} });
          send({ method: "Tracing.tracingComplete", params: { dataLossOccurred: false } });
        } else throw Error("Unexpected CDP command: " + msg.method);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const response = await run(testHost, framed({
      type: "sample", targets: ["one", "two", "busy", "navigated", "wrong-profile"].map((id, index) => ({
        targetId: id, tabId: index + 1,
      })),
    }), port);
    assert.equal(response.ok, true);
    assert.equal(response.rows.length, 4);
    const [a, b, busy, navigated] = response.rows;
    assert.ok(a.bytes > 0);
    assert.equal(a.processKey, b.processKey);
    assert.equal(a.bytes, b.bytes, "Shared renderer is sampled only once");
    assert.match(busy.error, /Tracing has already/);
    assert.match(navigated.error, /Page changed/);
    assert.ok(!commands.some((c) => c.target === "busy" && c.method === "Tracing.end"), "Never stop someone else's profiler");
    const malformed = await run(production, Buffer.alloc(4), port);
    assert.equal(malformed.ok, false);
    assert.match(malformed.error, /size/);
    const oversized = Buffer.alloc(4); oversized.writeUInt32LE(65537);
    assert.equal((await run(production, oversized, port)).ok, false);
    const self = process.env.RAMWATCH_TEST_EXTERNAL === "1"
      ? { status: 0, stdout: fs.readFileSync(path.join(root, "tests/.native-self.json"), "utf8") }
      : spawnSync(production, ["--self-test"], { windowsHide: true, encoding: "utf8" });
    assert.equal(self.status, 0, self.stderr);
    console.log(JSON.stringify({
      result: "Native host checks passed",
      sampleMs: response.elapsedMs,
      samplingMemory: response.helperMemory,
      startupMemory: JSON.parse(self.stdout),
    }, null, 2));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
