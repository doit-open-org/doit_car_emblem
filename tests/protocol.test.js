const test = require("node:test");
const assert = require("node:assert/strict");
const {
  UUIDS,
  getDeviceFileUrl,
  getStableDeviceId,
  normalizeServerPath,
  parseQuery,
} = require("../src/utils/protocol");
const {
  FRAME_TYPE,
  base64ToBytes,
  buildFrame,
  buildStartPayload,
  crc16Ccitt,
  getDataChunkSize,
  parseFrame,
} = require("../src/utils/mediaTransferProtocol");

test("uses the third-party BLE transfer service and characteristics", () => {
  assert.equal(UUIDS.service, "6e400001-b5a3-f393-e0a9-e50e24dcca9e");
  assert.equal(UUIDS.write, "6e400002-b5a3-f393-e0a9-e50e24dcca9e");
  assert.equal(UUIDS.notify, "6e400003-b5a3-f393-e0a9-e50e24dcca9e");
});

test("normalizes the server path before RN downloads it", () => {
  assert.equal(normalizeServerPath("uploads/201234.vpg?x=1"), "1234.vpg");
  assert.equal(normalizeServerPath("uploads/1234.jpg"), "1234.jpg");
  assert.equal(
    normalizeServerPath(
      "https://tui.doit.am/second_dimension/uploads/20260724/example.jpg?x=1"
    ),
    "260724/example.jpg"
  );
  assert.equal(
    normalizeServerPath("uploads/20260724/example.jpg"),
    "260724/example.jpg"
  );
  assert.equal(normalizeServerPath("260724/example.jpg"), "260724/example.jpg");
});

test("builds the HTTP download URL from the six-digit relative date", () => {
  assert.equal(
    getDeviceFileUrl("260717/49e35600.jpg"),
    "http://tui.doit.am/second_dimension/uploads/20260717/49e35600.jpg"
  );
  assert.equal(getDeviceFileUrl("../49e35600.jpg"), "");
});

test("encodes and verifies a BLE media frame", () => {
  const frame = buildFrame(
    FRAME_TYPE.DATA_ACK,
    0x12345678,
    12,
    Uint8Array.of(0)
  );
  const parsed = parseFrame(frame);
  assert.equal(parsed.type, FRAME_TYPE.DATA_ACK);
  assert.equal(parsed.transferId, 0x12345678);
  assert.equal(parsed.sequence, 12);
  assert.deepEqual(Array.from(parsed.payload), [0]);
  assert.equal(crc16Ccitt(Uint8Array.from([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39])), 0x29b1);
});

test("decodes file chunks from RNFS base64", () => {
  const source = Buffer.from(Array.from({ length: 511 }, (_, index) => index % 256));
  assert.deepEqual(
    Array.from(base64ToBytes(source.toString("base64"))),
    Array.from(source)
  );
});

test("encodes START metadata for JPEG and VPG", () => {
  const payload = buildStartPayload({
    fileSize: 1024,
    totalPackets: 3,
    chunkSize: 496,
    fileName: "49e35600.jpg",
    sha256: "00".repeat(32),
  });
  assert.equal(payload[10], 1);
  assert.equal(payload[11], 12);
  assert.equal(payload.length, 56);
});

test("uses the negotiated MTU up to the 512-byte GATT value limit", () => {
  assert.equal(getDataChunkSize(185), 166);
  assert.equal(getDataChunkSize(247), 228);
  assert.equal(getDataChunkSize(517), 496);
});

test("reads launch parameters from the host query string", () => {
  assert.deepEqual(parseQuery("mac=AA%3ABB&deviceName=%E5%B1%8F%E5%B9%95"), {
    mac: "AA:BB",
    deviceName: "屏幕",
  });
});

test("extracts the stable little-endian id from advertising data", () => {
  assert.equal(
    getStableDeviceId("02010607FFE5023412010001", "fallback"),
    "1234"
  );
  assert.equal(getStableDeviceId("", "fallback"), "fallback");
});
