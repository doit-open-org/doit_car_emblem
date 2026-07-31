const MAGIC_0 = 0x42;
const MAGIC_1 = 0x4d;
const VERSION = 1;
const FRAME_OVERHEAD = 16;
const MAX_GATT_VALUE_SIZE = 512;

const FRAME_TYPE = Object.freeze({
  START: 0x01,
  DATA: 0x02,
  END: 0x03,
  CANCEL: 0x04,
  DATA_ACK_REQUEST: 0x05,
  START_ACK: 0x81,
  DATA_ACK: 0x82,
  END_ACK: 0x83,
  ERROR: 0xff,
});

const STATUS_TEXT = Object.freeze({
  0: "成功",
  1: "帧格式或 CRC 错误",
  2: "设备忙",
  3: "设备存储空间不足",
  4: "设备不支持该文件类型",
  5: "文件元数据无效",
  6: "设备写入文件失败",
  7: "文件 SHA-256 校验失败",
  8: "设备解析或显示素材失败",
  9: "传输已取消",
});

function writeUint16LE(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32LE(target, offset, value) {
  const unsigned = Number(value) >>> 0;
  target[offset] = unsigned & 0xff;
  target[offset + 1] = (unsigned >>> 8) & 0xff;
  target[offset + 2] = (unsigned >>> 16) & 0xff;
  target[offset + 3] = (unsigned >>> 24) & 0xff;
}

function readUint16LE(source, offset) {
  return source[offset] | (source[offset + 1] << 8);
}

function readUint32LE(source, offset) {
  return (
    (source[offset] |
      (source[offset + 1] << 8) |
      (source[offset + 2] << 16) |
      (source[offset + 3] << 24)) >>>
    0
  );
}

function crc16Ccitt(bytes) {
  let crc = 0xffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index] << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc =
        crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function buildFrame(type, transferId, sequence, payload = new Uint8Array(0)) {
  if (payload.length > 0xffff) {
    throw new Error("BLE 帧负载过大");
  }
  const frame = new Uint8Array(FRAME_OVERHEAD + payload.length);
  frame[0] = MAGIC_0;
  frame[1] = MAGIC_1;
  frame[2] = VERSION;
  frame[3] = type;
  writeUint32LE(frame, 4, transferId);
  writeUint32LE(frame, 8, sequence);
  writeUint16LE(frame, 12, payload.length);
  frame.set(payload, 14);
  writeUint16LE(frame, frame.length - 2, crc16Ccitt(frame.subarray(0, -2)));
  return frame;
}

function getDataChunkSize(mtu) {
  const maxFrameSize = Math.min(MAX_GATT_VALUE_SIZE, Number(mtu) - 3);
  return maxFrameSize - FRAME_OVERHEAD;
}

function parseFrame(bytes) {
  if (!bytes || bytes.length < FRAME_OVERHEAD) {
    throw new Error("BLE 回包长度不足");
  }
  if (bytes[0] !== MAGIC_0 || bytes[1] !== MAGIC_1 || bytes[2] !== VERSION) {
    throw new Error("BLE 回包协议头无效");
  }
  const payloadLength = readUint16LE(bytes, 12);
  if (bytes.length !== FRAME_OVERHEAD + payloadLength) {
    throw new Error("BLE 回包负载长度无效");
  }
  const expectedCrc = readUint16LE(bytes, bytes.length - 2);
  const actualCrc = crc16Ccitt(bytes.subarray(0, -2));
  if (expectedCrc !== actualCrc) {
    throw new Error("BLE 回包 CRC 校验失败");
  }
  return {
    type: bytes[3],
    transferId: readUint32LE(bytes, 4),
    sequence: readUint32LE(bytes, 8),
    payload: bytes.slice(14, -2),
  };
}

function asciiBytes(value, maxLength = 64) {
  const text = String(value || "");
  if (!text || text.length > maxLength || /[^\x20-\x7e]/.test(text)) {
    throw new Error(`文件名必须是 1-${maxLength} 位 ASCII 字符`);
  }
  return Uint8Array.from(Array.from(text), (character) => character.charCodeAt(0));
}

function hexToBytes(hex) {
  const clean = String(hex || "").replace(/[^0-9a-f]/gi, "");
  if (!clean || clean.length % 2 !== 0) {
    throw new Error("十六进制数据无效");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(base64) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = String(base64 || "").replace(/\s/g, "").replace(/=+$/, "");
  const output = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let outputIndex = 0;
  for (let index = 0; index < clean.length; index += 1) {
    const value = alphabet.indexOf(clean[index]);
    if (value < 0) {
      throw new Error("文件分片 Base64 数据无效");
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[outputIndex] = (buffer >>> bits) & 0xff;
      outputIndex += 1;
    }
  }
  return output.subarray(0, outputIndex);
}

function buildStartPayload({ fileSize, totalPackets, chunkSize, fileName, sha256 }) {
  const name = asciiBytes(fileName);
  const hash = hexToBytes(sha256);
  if (hash.length !== 32) {
    throw new Error("文件 SHA-256 无效");
  }
  const extension = String(fileName).split(".").pop().toLowerCase();
  const fileType = extension === "jpg" || extension === "jpeg" ? 1 : extension === "vpg" ? 2 : 0;
  if (!fileType) {
    throw new Error("设备仅支持 JPG/JPEG 和 VPG 文件");
  }
  const payload = new Uint8Array(44 + name.length);
  writeUint32LE(payload, 0, fileSize);
  writeUint32LE(payload, 4, totalPackets);
  writeUint16LE(payload, 8, chunkSize);
  payload[10] = fileType;
  payload[11] = name.length;
  payload.set(hash, 12);
  payload.set(name, 44);
  return payload;
}

function getStatusError(frame, fallback) {
  if (!frame?.payload?.length) {
    return new Error(`${fallback}：设备 ACK 负载无效`);
  }
  const status = frame.payload[0];
  if (status === 0) {
    return null;
  }
  return new Error(`${fallback}：${STATUS_TEXT[status] || `设备错误 ${status}`}`);
}

module.exports = {
  FRAME_OVERHEAD,
  FRAME_TYPE,
  STATUS_TEXT,
  base64ToBytes,
  buildFrame,
  buildStartPayload,
  bytesToHex,
  crc16Ccitt,
  getStatusError,
  getDataChunkSize,
  hexToBytes,
  parseFrame,
  writeUint32LE,
};
