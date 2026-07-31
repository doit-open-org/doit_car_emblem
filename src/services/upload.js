const UPLOAD_URL = "https://tui.doit.am/second_dimension/fileUpload.php";
const MEDIA_BASE_URL = "https://tui.doit.am/second_dimension/";
const VPG_POLL_INTERVAL_MS = 500;
const VPG_MAX_ATTEMPTS = 120;

function isGifAsset(asset) {
  const type = String(asset?.type || "").toLowerCase();
  return (
    type === "image/gif" ||
    [asset?.fileName, asset?.uri].some((value) =>
      /\.gif(?:[?#]|$)/i.test(String(value || ""))
    )
  );
}

function toVpgFile(file) {
  const value = String(file || "");
  const queryIndex = value.search(/[?#]/);
  const suffix = queryIndex >= 0 ? value.slice(queryIndex) : "";
  const path = queryIndex >= 0 ? value.slice(0, queryIndex) : value;
  const dot = path.lastIndexOf(".");
  if (dot <= path.lastIndexOf("/")) {
    throw new Error("服务器未返回有效视频文件名");
  }
  return `${path.slice(0, dot)}.vpg${suffix}`;
}

function getMediaUrl(file) {
  const value = String(file || "");
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  return `${MEDIA_BASE_URL}${value.replace(/^\/+/, "")}`;
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForVpg(file) {
  const vpgFile = toVpgFile(file);
  const url = getMediaUrl(vpgFile);

  for (let attempt = 0; attempt < VPG_MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { method: "HEAD" });
    } catch (_) {
      throw new Error("视频转换状态检查失败");
    }
    if (response.status === 200) {
      return vpgFile;
    }
    if (attempt + 1 < VPG_MAX_ATTEMPTS) {
      await wait(VPG_POLL_INTERVAL_MS);
    }
  }

  throw new Error("视频转换超时，请重试");
}

function uploadMedia({
  asset,
  mediaType,
  deviceId,
  onProgress,
  onConverting,
}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    const requiresVpg = mediaType === "video" || isGifAsset(asset);
    const extension = requiresVpg
      ? isGifAsset(asset)
        ? "gif"
        : "mp4"
      : "jpg";

    form.append("file", {
      uri: asset.uri,
      name: asset.fileName || `baoma-${Date.now()}.${extension}`,
      type:
        asset.type ||
        (mediaType === "video" ? "video/mp4" : "image/jpeg"),
    });
    form.append("type", requiresVpg ? "1" : "0");
    form.append("fbl", "480");
    form.append("uid", String(Math.floor(Date.now() / 1000)));
    form.append("did", deviceId);

    xhr.open("POST", UPLOAD_URL);
    xhr.timeout = 120000;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        const percentage = Math.round((event.loaded / event.total) * 100);
        onProgress(Math.max(0, Math.min(99, percentage)));
      }
    };
    xhr.onerror = () => reject(new Error("网络上传失败"));
    xhr.ontimeout = () => reject(new Error("上传超时，请检查网络后重试"));
    xhr.onload = async () => {
      if (xhr.status !== 200) {
        reject(
          new Error(
            xhr.status === 413
              ? "视频文件超过服务器上传大小限制（HTTP 413）"
              : `上传失败（HTTP ${xhr.status}）`
          )
        );
        return;
      }

      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (_) {
        reject(new Error("服务器响应格式错误"));
        return;
      }
      if (!data.file) {
        reject(new Error("服务器未返回素材文件名"));
        return;
      }
      if (onProgress) {
        onProgress(100);
      }
      if (!requiresVpg) {
        resolve(data);
        return;
      }

      try {
        if (onConverting) {
          onConverting();
        }
        const file = await waitForVpg(data.file);
        resolve({ ...data, file });
      } catch (error) {
        reject(error);
      }
    };
    xhr.send(form);
  });
}

export { MEDIA_BASE_URL, UPLOAD_URL, uploadMedia };
