import NativeLocalStorage from "../../specs/NativeLocalStorage";

function sendHostType(type, deviceId = "") {
  if (!NativeLocalStorage?.sendDataByType) {
    return;
  }
  try {
    NativeLocalStorage.sendDataByType(
      JSON.stringify({
        cmd: 3,
        type: String(type),
        device_id: deviceId,
        msg: {},
      })
    );
  } catch (error) {
    console.warn("[BaomaPanel] host action failed", type, error);
  }
}

function closePanel(deviceId) {
  sendHostType(2000, deviceId);
}

function editPanel(deviceId) {
  sendHostType(2001, deviceId);
}

function notifyPanelReady(deviceId) {
  sendHostType(2002, deviceId);
}

function saveScene(deviceId) {
  sendHostType(2005, deviceId);
}

export { closePanel, editPanel, notifyPanelReady, saveScene };
