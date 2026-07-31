const UUIDS = Object.freeze({
  service: "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
  write: "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
  notify: "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
});

const SERVER_FILE_HTTP_PREFIX =
  "http://tui.doit.am/second_dimension/uploads/20";

function normalizeServerPath(file) {
  const clean = String(file || "")
    .trim()
    .split(/[?#]/)[0]
    .replace(/\\/g, "/");
  if (!clean) {
    return "";
  }

  const searchable = `/${clean.replace(/^\/+/, "")}`;
  const lower = searchable.toLowerCase();
  const centuryPrefix = "/uploads/20";
  const uploadsPrefix = "/uploads/";
  let relativePath;

  const centuryIndex = lower.lastIndexOf(centuryPrefix);
  if (centuryIndex >= 0) {
    relativePath = searchable.slice(centuryIndex + centuryPrefix.length);
  } else {
    const uploadsIndex = lower.lastIndexOf(uploadsPrefix);
    relativePath =
      uploadsIndex >= 0
        ? searchable.slice(uploadsIndex + uploadsPrefix.length)
        : searchable.replace(/^\/+/, "");
    relativePath = relativePath.replace(/^20(?=\d{6}\/)/, "");
  }

  relativePath = relativePath.replace(/^\/+/, "");
  const segments = relativePath.split("/");
  if (
    !relativePath ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return "";
  }
  return relativePath;
}

function getDeviceFileUrl(file) {
  const relativePath = normalizeServerPath(file);
  if (!/^\d{6}\/[A-Za-z0-9._/-]+$/.test(relativePath)) {
    return "";
  }
  return `${SERVER_FILE_HTTP_PREFIX}${relativePath}`;
}

function parseQuery(query) {
  return String(query || "")
    .split("&")
    .reduce((result, pair) => {
      const separator = pair.indexOf("=");
      if (separator < 0) {
        return result;
      }
      const decode = (value) => {
        try {
          return decodeURIComponent(value.replace(/\+/g, " "));
        } catch (_) {
          return value;
        }
      };
      result[decode(pair.slice(0, separator))] = decode(
        pair.slice(separator + 1)
      );
      return result;
    }, {});
}

function getStableDeviceId(broadcastData, fallback) {
  const hex = String(broadcastData || "")
    .replace(/[^0-9a-f]/gi, "")
    .toUpperCase();
  const marker = hex.indexOf("E502");
  if (marker >= 0 && hex.length >= marker + 8) {
    const lowByte = hex.slice(marker + 4, marker + 6);
    const highByte = hex.slice(marker + 6, marker + 8);
    return `${highByte}${lowByte}`;
  }
  return String(fallback || "UNKNOWN");
}

module.exports = {
  SERVER_FILE_HTTP_PREFIX,
  UUIDS,
  getDeviceFileUrl,
  getStableDeviceId,
  normalizeServerPath,
  parseQuery,
};
