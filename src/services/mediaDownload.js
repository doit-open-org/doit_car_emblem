import RNFS from "react-native-fs";
import { getDeviceFileUrl, normalizeServerPath } from "../utils/protocol";

function safeFileName(relativePath) {
  const fileName = String(relativePath).split("/").pop();
  if (!fileName || !/^[A-Za-z0-9._-]+$/.test(fileName)) {
    throw new Error("服务器返回的素材文件名无效");
  }
  return fileName;
}

async function removeFile(path) {
  if (!path) {
    return;
  }
  try {
    if (await RNFS.exists(path)) {
      await RNFS.unlink(path);
    }
  } catch (_) {
    // Cache cleanup must not replace the actual transfer result.
  }
}

async function downloadMediaFile(serverFile, onProgress) {
  const relativePath = normalizeServerPath(serverFile);
  const url = getDeviceFileUrl(relativePath);
  if (!url) {
    throw new Error("服务器返回的素材路径无效，应为 260724/example.jpg 格式");
  }
  const fileName = safeFileName(relativePath);
  const path = `${RNFS.CachesDirectoryPath}/baoma-transfer-${Date.now()}-${fileName}`;

  const task = RNFS.downloadFile({
    fromUrl: url,
    toFile: path,
    progressDivider: 1,
    progress: (event) => {
      if (!onProgress || !event.contentLength) {
        return;
      }
      const value = Math.round(
        (Number(event.bytesWritten) / Number(event.contentLength)) * 100
      );
      onProgress(Math.max(0, Math.min(99, value)));
    },
  });

  try {
    const result = await task.promise;
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`下载素材失败（HTTP ${result.statusCode}）`);
    }
    const stat = await RNFS.stat(path);
    const size = Number(stat.size);
    if (!Number.isSafeInteger(size) || size <= 0 || size > 0xffffffff) {
      throw new Error("下载的素材文件大小无效");
    }
    const sha256 = await RNFS.hash(path, "sha256");
    onProgress?.(100);
    return { fileName, path, relativePath, sha256, size, url };
  } catch (error) {
    await removeFile(path);
    throw error;
  }
}

export { downloadMediaFile, removeFile };
