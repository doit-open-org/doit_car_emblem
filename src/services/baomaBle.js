import { DeviceEventEmitter } from "react-native";
import RNFS from "react-native-fs";
import NativeLocalStorage from "../../specs/NativeLocalStorage";
import { UUIDS } from "../utils/protocol";
import {
  FRAME_OVERHEAD,
  FRAME_TYPE,
  base64ToBytes,
  buildFrame,
  buildStartPayload,
  bytesToHex,
  getDataChunkSize,
  getStatusError,
  hexToBytes,
  parseFrame,
} from "../utils/mediaTransferProtocol";

const NATIVE_EVENT = "callJsRnBle";
const PREFERRED_MTU = 517;
const FALLBACK_MTU = 185;
const WINDOW_SIZE = 64;
const DEVICE_ACK_TIMEOUT_MS = 4000;
const PACKET_WRITE_BUDGET_MS = 80;
const MAX_RETRIES = 3;

function parseJson(value) {
  if (value && typeof value === "object") {
    return value;
  }
  try {
    return JSON.parse(String(value || ""));
  } catch (_) {
    return null;
  }
}

function sameMac(left, right) {
  return (
    String(left || "").replace(/[^0-9a-f]/gi, "").toUpperCase() ===
    String(right || "").replace(/[^0-9a-f]/gi, "").toUpperCase()
  );
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function createBaomaBleClient({ mac, connected = false }) {
  let isConnected = Boolean(connected);
  let negotiatedMtu = FALLBACK_MTU;
  let subscription = null;
  let waiters = [];
  let serial = 0;
  const connectionListeners = new Set();

  function settleWaiters(event) {
    waiters = waiters.filter((waiter) => {
      if (!waiter.predicate(event)) {
        return true;
      }
      clearTimeout(waiter.timer);
      waiter.resolve(event);
      return false;
    });
  }

  function rejectAll(error) {
    const active = waiters;
    waiters = [];
    active.forEach((waiter) => {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    });
  }

  function setConnection(value) {
    const next = Boolean(value);
    if (isConnected === next) {
      return;
    }
    isConnected = next;
    connectionListeners.forEach((listener) => listener(next));
    if (!next) {
      rejectAll(new Error("设备蓝牙连接已断开"));
    }
  }

  function handleNativeEvent(raw) {
    const message = parseJson(raw);
    const data = parseJson(message?.data) || {};
    if (!message || (data.mac && mac && !sameMac(data.mac, mac))) {
      return;
    }

    const type = Number(message.type);
    if (type === 2007) {
      setConnection(Number(data.connectStatus) === 1);
    } else if (type === 2010) {
      setConnection(Number(data.connectStatus) === 1);
    } else if (type === 2012) {
      setConnection(false);
    } else if (type === 2205 && Number(data.mtu) >= 23) {
      negotiatedMtu = Number(data.mtu);
    } else if (
      type === 2200 &&
      String(data.serviceUuid || "").toLowerCase() === UUIDS.service &&
      String(data.chacUuid || "").toLowerCase() === UUIDS.notify
    ) {
      try {
        settleWaiters({ kind: "protocol", frame: parseFrame(hexToBytes(data.pkg)) });
      } catch (_) {
        return;
      }
    }

    settleWaiters({ kind: "native", type, data });
  }

  function start() {
    if (!subscription) {
      subscription = DeviceEventEmitter.addListener(NATIVE_EVENT, handleNativeEvent);
      if (mac && NativeLocalStorage?.sendThirdBleData) {
        sendNative(1007, { mac });
      }
    }
  }

  function stop() {
    subscription?.remove();
    subscription = null;
    rejectAll(new Error("页面已关闭"));
  }

  function sendNative(type, data) {
    if (!NativeLocalStorage?.sendThirdBleData) {
      throw new Error("宿主 App 未注册第三方蓝牙接口");
    }
    NativeLocalStorage.sendThirdBleData(JSON.stringify({ type, data }));
  }

  function waitFor(predicate, timeoutMs, timeoutText) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        waiters = waiters.filter((item) => item !== waiter);
        reject(new Error(timeoutText || "等待设备响应超时"));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  async function refreshConnection() {
    const reply = waitFor(
      (event) => event.kind === "native" && event.type === 2010,
      1500,
      "读取蓝牙连接状态超时"
    );
    sendNative(1007, { mac });
    try {
      await reply;
    } catch (_) {
      // The launch connection state remains the fallback for older hosts.
    }
    if (!isConnected) {
      throw new Error("设备未连接，请返回 App 完成蓝牙连接后再发送");
    }
  }

  async function prepareTransport() {
    if (!mac) {
      throw new Error("宿主 App 未提供设备 MAC");
    }
    start();
    await refreshConnection();

    const mtuReply = waitFor(
      (event) => event.kind === "native" && event.type === 2205,
      1500,
      "MTU 协商超时"
    );
    sendNative(1006, { mac, size: PREFERRED_MTU });
    await mtuReply.catch(() => undefined);

    sendNative(1003, {
      mac,
      notifyUuid: UUIDS.notify,
      serviceUuid: UUIDS.service,
      enable: true,
    });
    await wait(250);

    const maxFrameSize = getDataChunkSize(negotiatedMtu) + FRAME_OVERHEAD;
    if (maxFrameSize < 124) {
      throw new Error(`蓝牙 MTU 过小（${negotiatedMtu}），设备需支持 MTU 127 以上`);
    }
    return { chunkSize: getDataChunkSize(negotiatedMtu), mtu: negotiatedMtu };
  }

  function writeFrames(frames) {
    const sn = `baoma-${Date.now()}-${serial++}`;
    sendNative(1000, {
      mac,
      chacUuid: UUIDS.write,
      serviceUuid: UUIDS.service,
      pkgs: frames.map(bytesToHex),
      sn,
      mtu: negotiatedMtu,
      timeout: 1500,
      needFaq: false,
      // 宿主仅对该第三方 BLE 批量写入启用高速链路参数。
      fastMode: true,
    });
  }

  async function sendAndWaitForDevice(frames, transferId, ackType, label) {
    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      try {
        const deviceReply = waitFor(
          (event) =>
            event.kind === "protocol" &&
            event.frame.transferId === transferId &&
            (event.frame.type === ackType || event.frame.type === FRAME_TYPE.ERROR),
          DEVICE_ACK_TIMEOUT_MS + frames.length * PACKET_WRITE_BUDGET_MS,
          `${label}等待设备确认超时`
        );
        const [, { frame }] = await Promise.all([
          Promise.resolve().then(() => writeFrames(frames)),
          deviceReply,
        ]);
        if (frame.type === FRAME_TYPE.ERROR) {
          const error = getStatusError(frame, label) || new Error(`${label}被设备拒绝`);
          error.deviceRejected = true;
          throw error;
        }
        const statusError = getStatusError(frame, label);
        if (statusError) {
          statusError.deviceRejected = true;
          throw statusError;
        }
        return frame;
      } catch (error) {
        if (error?.deviceRejected) {
          throw error;
        }
        lastError = error;
      }
    }
    throw lastError || new Error(`${label}失败`);
  }

  async function transferFile({ path, fileName, fileSize, sha256, onProgress }) {
    const { chunkSize } = await prepareTransport();
    const totalPackets = Math.ceil(fileSize / chunkSize);
    const transferId = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    const startPayload = buildStartPayload({
      fileSize,
      totalPackets,
      chunkSize,
      fileName,
      sha256,
    });

    try {
      await sendAndWaitForDevice(
        [buildFrame(FRAME_TYPE.START, transferId, 0, startPayload)],
        transferId,
        FRAME_TYPE.START_ACK,
        "开始传输"
      );

      let sequence = 0;
      let stalledCount = 0;
      while (sequence < totalPackets) {
        const frames = [];
        const endSequence = Math.min(sequence + WINDOW_SIZE, totalPackets);
        const windowPosition = sequence * chunkSize;
        const windowLength = Math.min(
          (endSequence - sequence) * chunkSize,
          fileSize - windowPosition
        );
        const windowBase64 = await RNFS.read(
          path,
          windowLength,
          windowPosition,
          "base64"
        );
        const windowBytes = base64ToBytes(windowBase64);
        if (windowBytes.length !== windowLength) {
          throw new Error("读取文件传输窗口失败");
        }
        for (let current = sequence; current < endSequence; current += 1) {
          const offset = (current - sequence) * chunkSize;
          const length = Math.min(chunkSize, windowBytes.length - offset);
          frames.push(
            buildFrame(
              current + 1 === endSequence
                ? FRAME_TYPE.DATA_ACK_REQUEST
                : FRAME_TYPE.DATA,
              transferId,
              current,
              windowBytes.subarray(offset, offset + length)
            )
          );
        }

        const ack = await sendAndWaitForDevice(
          frames,
          transferId,
          FRAME_TYPE.DATA_ACK,
          "文件分片传输"
        );
        if (ack.sequence > endSequence || ack.sequence > totalPackets) {
          throw new Error("设备返回的分片序号无效");
        }
        if (ack.sequence <= sequence) {
          stalledCount += 1;
          if (stalledCount >= MAX_RETRIES) {
            throw new Error("设备未接收文件分片");
          }
        } else {
          sequence = ack.sequence;
          stalledCount = 0;
          onProgress?.(Math.min(99, Math.round((sequence / totalPackets) * 100)));
        }
      }

      await sendAndWaitForDevice(
        [buildFrame(FRAME_TYPE.END, transferId, totalPackets, hexToBytes(sha256))],
        transferId,
        FRAME_TYPE.END_ACK,
        "完成传输"
      );
      onProgress?.(100);
    } catch (error) {
      try {
        await writeFrames([buildFrame(FRAME_TYPE.CANCEL, transferId, 0)]);
      } catch (_) {
        // Preserve the transfer error when best-effort cancellation fails.
      }
      throw error;
    }
  }

  function onConnectionChange(listener) {
    connectionListeners.add(listener);
    return () => connectionListeners.delete(listener);
  }

  return {
    isConnected: () => isConnected,
    onConnectionChange,
    start,
    stop,
    transferFile,
  };
}

export { createBaomaBleClient };
