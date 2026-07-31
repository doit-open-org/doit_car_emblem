import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  DeviceEventEmitter,
  Image,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  launchImageLibrary,
  type ImageLibraryOptions,
} from "react-native-image-picker";
import RNFS from "react-native-fs";
import Svg, { Image as SvgImage } from "react-native-svg";
import { WebView } from "react-native-webview";
import Feather from "react-native-vector-icons/Feather";
import SimpleLineIcons from "react-native-vector-icons/SimpleLineIcons";
import { createBaomaBleClient } from "./src/services/baomaBle";
import { downloadMediaFile, removeFile } from "./src/services/mediaDownload";
import {
  closePanel,
  editPanel,
  notifyPanelReady,
  saveScene,
} from "./src/services/host";
import { uploadMedia } from "./src/services/upload";
import {
  getStableDeviceId,
  parseQuery,
} from "./src/utils/protocol";

type MediaType = "image" | "video";
type Phase =
  | "idle"
  | "processing"
  | "uploading"
  | "converting"
  | "downloading"
  | "transferring"
  | "success"
  | "error";

type SelectedMedia = {
  uri: string;
  fileName?: string;
  fileSize?: number;
  type?: string;
  duration?: number;
  width?: number;
  height?: number;
  mediaType: MediaType;
};

type ImageCropJob = {
  asset: SelectedMedia;
  id: number;
  reject: (error: Error) => void;
  resolve: (media: SelectedMedia) => void;
  started: boolean;
  timer: ReturnType<typeof setTimeout>;
};

const IMAGE_SIZE = 480;
const IMAGE_PROCESS_TIMEOUT_MS = 30000;

function firstValue(...values: unknown[]) {
  return values.find(
    (value) => value !== undefined && value !== null && value !== ""
  );
}

function formatSize(size = 0) {
  if (!size) {
    return "";
  }
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function isGifMedia(media: { type?: string; fileName?: string; uri?: string }) {
  const type = String(media.type || "").toLowerCase();
  return (
    type === "image/gif" ||
    [media.fileName, media.uri].some((value) =>
      /\.gif(?:[?#]|$)/i.test(String(value || ""))
    )
  );
}

function processedImageFileName(fileName?: string) {
  const value = String(fileName || `baoma-${Date.now()}`);
  return `${value.replace(/\.[^.]+$/, "")}.jpg`;
}

function createJpegEncoderHtml(pngBase64: string) {
  return `<!doctype html><html><body><canvas id="canvas" width="${IMAGE_SIZE}" height="${IMAGE_SIZE}"></canvas><script>
    const image = new Image();
    image.onload = function () {
      try {
        const canvas = document.getElementById("canvas");
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, ${IMAGE_SIZE}, ${IMAGE_SIZE});
        const jpeg = canvas.toDataURL("image/jpeg", 0.9).split(",")[1];
        window.ReactNativeWebView.postMessage(jpeg || "ERROR:图片导出失败");
      } catch (_) {
        window.ReactNativeWebView.postMessage("ERROR:图片导出失败");
      }
    };
    image.onerror = function () {
      window.ReactNativeWebView.postMessage("ERROR:图片读取失败");
    };
    image.src = "data:image/png;base64,${pngBase64}";
  </script></body></html>`;
}

function resolveLaunchProps(props: any) {
  const query = parseQuery(props?.query) as Record<string, any>;
  const connectStatus = firstValue(
    query.connectStatus,
    query.connect_status,
    query.isOnline,
    props?.connectStatus,
    props?.isOnline
  );
  return {
    mac: String(firstValue(query.mac, props?.mac) || ""),
    deviceId: String(
      firstValue(
        query.deviceId,
        query.device_id,
        props?.deviceId,
        props?.device_id
      ) || ""
    ),
    deviceName: String(
      firstValue(
        query.deviceName,
        query.device_name,
        props?.deviceName,
        props?.device_name,
        "屏幕设备"
      )
    ),
    broadcastData: String(
      firstValue(query.broadcastData, props?.broadcastData) || ""
    ),
    panelType: String(
      firstValue(
        query.panelType,
        query.panel_type,
        props?.panelType,
        props?.panel_type
      ) || ""
    ),
    connected: String(connectStatus) === "1" || connectStatus === true,
  };
}

function getDeviceNameFromHostEvent(raw: unknown) {
  try {
    const event = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!event || String((event as any).type) !== "2003") {
      return "";
    }
    const rawMessage = (event as any).msg;
    const message =
      typeof rawMessage === "string" ? JSON.parse(rawMessage) : rawMessage;
    return String(message?.data?.["2003"] || "");
  } catch (_) {
    return "";
  }
}

export default function App(props: any) {
  const launch = useMemo(() => resolveLaunchProps(props), [props]);
  const ble = useMemo(
    () =>
      createBaomaBleClient({
        mac: launch.mac,
        connected: launch.connected,
      }),
    [launch.connected, launch.mac]
  );
  const stableDeviceId = useMemo(
    () =>
      getStableDeviceId(launch.broadcastData, launch.deviceId || launch.mac),
    [launch.broadcastData, launch.deviceId, launch.mac]
  );

  const [connected, setConnected] = useState(launch.connected);
  const [title, setTitle] = useState(launch.deviceName);
  const resolution = 480;
  const [media, setMedia] = useState<SelectedMedia | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [resultText, setResultText] = useState("");
  const [cropSourceUri, setCropSourceUri] = useState("");
  const [jpegSourceBase64, setJpegSourceBase64] = useState("");
  const cropSvgRef = useRef<Svg | null>(null);
  const cropJobRef = useRef<ImageCropJob | null>(null);
  const busy =
    phase === "processing" ||
    phase === "uploading" ||
    phase === "converting" ||
    phase === "downloading" ||
    phase === "transferring";

  function finishCropJob(
    job: ImageCropJob,
    result?: SelectedMedia,
    error?: Error
  ) {
    if (cropJobRef.current !== job) {
      return;
    }
    clearTimeout(job.timer);
    cropJobRef.current = null;
    setCropSourceUri("");
    setJpegSourceBase64("");
    if (error) {
      job.reject(error);
    } else if (result) {
      job.resolve(result);
    }
  }

  function centerCropImage(asset: SelectedMedia) {
    return new Promise<SelectedMedia>((resolve, reject) => {
      const id = Date.now();
      const job: ImageCropJob = {
        asset,
        id,
        reject,
        resolve,
        started: false,
        timer: setTimeout(() => {
          finishCropJob(job, undefined, new Error("图片处理超时，请重试"));
        }, IMAGE_PROCESS_TIMEOUT_MS),
      };
      cropJobRef.current = job;
      setCropSourceUri(asset.uri);
    });
  }

  async function handleCropSourceLoad() {
    const job = cropJobRef.current;
    const svg = cropSvgRef.current;
    if (!job || !svg || job.started) {
      return;
    }
    job.started = true;

    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        try {
          svg.toDataURL(
            (value) => {
              if (value) {
                resolve(value);
              } else {
                reject(new Error("图片导出失败"));
              }
            },
            { width: IMAGE_SIZE, height: IMAGE_SIZE }
          );
        } catch (_) {
          reject(new Error("图片导出失败"));
        }
      });
      setCropSourceUri("");
      setJpegSourceBase64(base64);
    } catch (error: any) {
      finishCropJob(
        job,
        undefined,
        new Error(error?.message || "图片处理失败")
      );
    }
  }

  async function handleJpegEncoded(event: any) {
    const job = cropJobRef.current;
    if (!job) {
      return;
    }
    const value = String(event?.nativeEvent?.data || "");
    if (!value || value.startsWith("ERROR:")) {
      finishCropJob(
        job,
        undefined,
        new Error(value.slice(6) || "图片导出失败")
      );
      return;
    }

    try {
      const path = `${RNFS.CachesDirectoryPath}/baoma-${job.id}.jpg`;
      await RNFS.writeFile(path, value, "base64");
      const stat = await RNFS.stat(path);
      finishCropJob(job, {
        uri: `file://${path}`,
        fileName: processedImageFileName(job.asset.fileName),
        fileSize: Number(stat.size) || undefined,
        type: "image/jpeg",
        width: IMAGE_SIZE,
        height: IMAGE_SIZE,
        mediaType: "image",
      });
    } catch (error: any) {
      finishCropJob(
        job,
        undefined,
        new Error(error?.message || "图片文件写入失败")
      );
    }
  }

  useEffect(() => {
    setConnected(launch.connected);
    const removeConnection = ble.onConnectionChange(setConnected);
    ble.start();
    notifyPanelReady(launch.deviceId);
    return () => {
      removeConnection();
      ble.stop();
    };
  }, [ble, launch.connected, launch.deviceId]);

  useEffect(() => {
    setTitle(launch.deviceName);
  }, [launch.deviceName]);

  useEffect(() => {
    const subscription = DeviceEventEmitter.addListener(
      "getDeviceData",
      (raw) => {
        const nextTitle = getDeviceNameFromHostEvent(raw);
        if (nextTitle) {
          setTitle(nextTitle);
        }
      }
    );
    return () => subscription.remove();
  }, []);

  useEffect(
    () => () => {
      const job = cropJobRef.current;
      if (job) {
        clearTimeout(job.timer);
        cropJobRef.current = null;
      }
    },
    []
  );

  async function chooseMedia(mediaType: MediaType) {
    if (busy) {
      return;
    }
    try {
      const pickerOptions: ImageLibraryOptions = {
        mediaType: mediaType === "image" ? "photo" : "video",
        selectionLimit: 1,
        includeBase64: false,
        quality: 1,
      };
      const result = await launchImageLibrary(pickerOptions);
      if (result.didCancel) {
        return;
      }
      if (result.errorCode) {
        throw new Error(result.errorMessage || "选择素材失败");
      }
      const asset = result.assets?.[0];
      if (!asset?.uri) {
        throw new Error("没有读取到素材文件");
      }
      let selected: SelectedMedia = { ...asset, uri: asset.uri, mediaType };
      if (mediaType === "image" && !isGifMedia(asset)) {
        setPhase("processing");
        selected = await centerCropImage(selected);
      }
      setMedia(selected);
      setPhase("idle");
      setProgress(0);
      setResultText("");
    } catch (error: any) {
      setPhase("idle");
      if (error?.code === "E_PICKER_CANCELLED") {
        return;
      }
      Alert.alert("无法选择素材", error?.message || "请稍后重试");
    }
  }

  async function sendToDevice() {
    if (busy) {
      return;
    }
    if (!connected || !ble.isConnected()) {
      Alert.alert("设备未连接", "请返回 App 完成设备连接后再发送。");
      return;
    }
    if (!media) {
      Alert.alert("请选择素材", "请选择一张图片或一段视频。");
      return;
    }

    setPhase("uploading");
    setProgress(0);
    setResultText("");
    let downloadedPath = "";
    try {
      const response = await uploadMedia({
        asset: media,
        mediaType: media.mediaType,
        deviceId: stableDeviceId,
        onProgress: setProgress,
        onConverting: () => setPhase("converting"),
      });

      setPhase("downloading");
      setProgress(0);
      const downloaded = await downloadMediaFile(response.file, setProgress);
      downloadedPath = downloaded.path;

      setPhase("transferring");
      setProgress(0);
      await ble.transferFile({
        path: downloaded.path,
        fileName: downloaded.fileName,
        fileSize: downloaded.size,
        sha256: downloaded.sha256,
        onProgress: setProgress,
      });

      setPhase("success");
      setProgress(100);
      setResultText("素材已更新到设备");
    } catch (error: any) {
      setPhase("error");
      setResultText(error?.message || "发送失败，请重试");
    } finally {
      await removeFile(downloadedPath);
    }
  }

  const actionText =
    phase === "processing"
      ? "图片处理中"
      : phase === "uploading"
      ? `上传中 ${progress}%`
      : phase === "converting"
      ? "视频转换中"
      : phase === "downloading"
      ? `下载中 ${progress}%`
      : phase === "transferring"
      ? `蓝牙传输中 ${progress}%`
      : "发送到设备";

  const primaryText = !connected
    ? "设备未连接"
    : !media
    ? "选择素材后发送"
    : actionText;
  const isScene = launch.panelType === "sence";

  return (
    <SafeAreaView style={styles.safeArea}>
      {!!cropSourceUri && (
        <View pointerEvents="none" style={styles.imageProcessor}>
          <Svg
            ref={cropSvgRef}
            width={1}
            height={1}
            viewBox={`0 0 ${IMAGE_SIZE} ${IMAGE_SIZE}`}
          >
            <SvgImage
              href={{ uri: cropSourceUri }}
              x={0}
              y={0}
              width={IMAGE_SIZE}
              height={IMAGE_SIZE}
              preserveAspectRatio="xMidYMid slice"
              onLoad={handleCropSourceLoad}
            />
          </Svg>
        </View>
      )}
      {!!jpegSourceBase64 && (
        <WebView
          originWhitelist={["*"]}
          javaScriptEnabled
          scrollEnabled={false}
          source={{ html: createJpegEncoderHtml(jpegSourceBase64) }}
          onMessage={handleJpegEncoded}
          style={styles.imageProcessor}
        />
      )}
      <StatusBar backgroundColor={COLORS.header} barStyle="light-content" />
      <View style={styles.header}>
        <TouchableOpacity
          accessibilityLabel="返回"
          accessibilityRole="button"
          onPress={() => closePanel(launch.deviceId)}
          style={styles.iconButton}
        >
          <Feather name="arrow-left" size={24} color="#fff" />
        </TouchableOpacity>
        <Text numberOfLines={1} style={styles.headerTitle}>
          {title}
        </Text>
        <TouchableOpacity
          accessibilityLabel={isScene ? "保存" : "编辑"}
          accessibilityRole="button"
          onPress={() =>
            isScene
              ? saveScene(launch.deviceId)
              : editPanel(launch.deviceId)
          }
          style={styles.iconButton}
        >
          {isScene ? (
            <Feather name="save" size={24} color="#fff" />
          ) : (
            <SimpleLineIcons name="pencil" size={24} color="#fff" />
          )}
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.deviceBand}>
          <View style={styles.deviceIcon}>
            <Feather name="monitor" size={20} color={COLORS.ink} />
          </View>
          <View style={styles.deviceInfo}>
            <Text numberOfLines={1} style={styles.deviceName}>
              {launch.deviceName}
            </Text>
            <Text style={styles.deviceMeta}>
              {resolution} × {resolution} 屏幕
            </Text>
          </View>
          <View
            style={[
              styles.connectionPill,
              !connected && styles.connectionPillOffline,
            ]}
          >
            <View
              style={[styles.statusDot, connected && styles.statusDotOnline]}
            />
            <Text
              style={[
                styles.connectionText,
                !connected && styles.connectionTextOffline,
              ]}
            >
              {connected ? "在线" : "离线"}
            </Text>
          </View>
        </View>

        <View style={styles.previewSection}>
          <View style={styles.sectionHeader}>
            <View>
              <Text style={styles.eyebrow}>DISPLAY PREVIEW</Text>
              <Text style={styles.sectionTitle}>屏幕预览</Text>
            </View>
            <Text style={styles.canvasSize}>
              {resolution} × {resolution}
            </Text>
          </View>

          <View style={styles.frameStage}>
            <View style={styles.frameBody}>
              <View
                style={[
                  styles.deviceScreen,
                  !media && styles.deviceScreenEmpty,
                ]}
              >
                {media?.mediaType === "image" ? (
                  <Image
                    source={{ uri: media.uri }}
                    resizeMode="cover"
                    style={styles.previewImage}
                  />
                ) : media?.mediaType === "video" ? (
                  <View style={styles.videoPreview}>
                    <View style={styles.playButton}>
                      <Feather name="play" size={24} color="#ffffff" />
                    </View>
                    <Text numberOfLines={1} style={styles.videoScreenName}>
                      {media.fileName || "已选择视频"}
                    </Text>
                  </View>
                ) : (
                  <View style={styles.emptyPreview}>
                    <View style={styles.emptyIcon}>
                      <Feather name="image" size={27} color={COLORS.muted} />
                    </View>
                    <Text style={styles.emptyTitle}>尚未选择素材</Text>
                    <Text style={styles.emptyMeta}>图片或视频</Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        </View>

        <View style={styles.mediaSection}>
          <Text style={styles.sectionTitle}>添加素材</Text>
          <View style={styles.segmentedControl}>
            <TouchableOpacity
              accessibilityRole="button"
              disabled={busy}
              onPress={() => chooseMedia("image")}
              style={styles.segmentButton}
            >
              <View style={[styles.actionIcon, styles.photoActionIcon]}>
                <Feather name="image" size={19} color={COLORS.photo} />
              </View>
              <Text style={styles.segmentText}>图片</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              disabled={busy}
              onPress={() => chooseMedia("video")}
              style={styles.segmentButton}
            >
              <View style={[styles.actionIcon, styles.videoActionIcon]}>
                <Feather name="video" size={19} color={COLORS.video} />
              </View>
              <Text style={styles.segmentText}>视频</Text>
            </TouchableOpacity>
          </View>

          {!!media && (
            <View style={styles.fileRow}>
              <View style={styles.fileTypeIcon}>
                <Feather
                  name={media.mediaType === "image" ? "image" : "film"}
                  size={18}
                  color={COLORS.secondary}
                />
              </View>
              <View style={styles.fileInfo}>
                <Text numberOfLines={1} style={styles.fileName}>
                  {media.fileName ||
                    (media.mediaType === "image" ? "已选择图片" : "已选择视频")}
                </Text>
                <Text style={styles.fileMeta}>
                  {[
                    media.mediaType === "image" ? "图片" : "视频",
                    media.duration ? `${Math.round(media.duration)} 秒` : "",
                    formatSize(media.fileSize),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              </View>
              <Feather name="check-circle" size={20} color={COLORS.success} />
            </View>
          )}
        </View>

        {!!resultText && (
          <View
            style={[
              styles.result,
              phase === "success" ? styles.resultSuccess : styles.resultError,
            ]}
          >
            <View
              style={[
                styles.resultIcon,
                phase === "success"
                  ? styles.resultIconSuccess
                  : styles.resultIconError,
              ]}
            >
              <Feather
                name={phase === "success" ? "check" : "alert-circle"}
                size={18}
                color={phase === "success" ? COLORS.successDark : COLORS.error}
              />
            </View>
            <Text
              style={[
                styles.resultText,
                phase === "success"
                  ? styles.resultTextSuccess
                  : styles.resultTextError,
              ]}
            >
              {resultText}
            </Text>
          </View>
        )}
      </ScrollView>

      <View style={styles.footer}>
        {busy && (
          <View style={styles.progressBlock}>
            <View style={styles.progressHeader}>
              <Text style={styles.progressStatus}>{actionText}</Text>
              <Text style={styles.progressLabel}>{progress}%</Text>
            </View>
            <View style={styles.progressTrack}>
              <View style={[styles.progressValue, { width: `${progress}%` }]} />
            </View>
          </View>
        )}

        <TouchableOpacity
          accessibilityRole="button"
          activeOpacity={0.86}
          disabled={busy || !connected || !media}
          onPress={sendToDevice}
          style={[
            styles.primaryButton,
            (busy || !connected || !media) && styles.primaryButtonDisabled,
          ]}
        >
          {busy ? (
            <ActivityIndicator color="#ffffff" size="small" />
          ) : (
            <Feather
              name={connected && media ? "send" : "lock"}
              size={19}
              color={connected && media ? "#ffffff" : COLORS.disabledButtonText}
            />
          )}
          <Text
            style={[
              styles.primaryButtonText,
              (busy || !connected || !media) &&
                styles.primaryButtonTextDisabled,
            ]}
          >
            {primaryText}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const COLORS = {
  primary: "#df4a50",
  header: "#f64a4a",
  page: "#f3f5f7",
  surface: "#ffffff",
  ink: "#171a1f",
  secondary: "#626b78",
  muted: "#929aa5",
  border: "#e2e5e9",
  stage: "#e8ebef",
  progress: "#3b6f9c",
  photo: "#2f6f9f",
  photoSoft: "#e8f1f7",
  video: "#a45b38",
  videoSoft: "#f8eee8",
  success: "#24865f",
  successDark: "#176a48",
  successSoft: "#e7f4ee",
  error: "#ae3f45",
  errorSoft: "#faecee",
  disabledButton: "#e5e7ea",
  disabledButtonText: "#9097a1",
};

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.surface },
  imageProcessor: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 1,
    height: 1,
    overflow: "hidden",
  },
  body: { flex: 1, backgroundColor: COLORS.page },
  header: {
    height: 58,
    paddingHorizontal: 12,
    backgroundColor: COLORS.header,
    flexDirection: "row",
    alignItems: "center",
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex: 1,
    paddingHorizontal: 8,
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
    textAlign: "center",
  },
  content: { flexGrow: 1, paddingBottom: 24 },
  deviceBand: {
    minHeight: 72,
    marginHorizontal: 16,
    marginTop: 14,
    paddingHorizontal: 14,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    flexDirection: "row",
    alignItems: "center",
  },
  deviceIcon: {
    width: 42,
    height: 42,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f0f2f4",
  },
  deviceInfo: { flex: 1, marginHorizontal: 12 },
  deviceName: { color: COLORS.ink, fontSize: 15, fontWeight: "700" },
  deviceMeta: { marginTop: 4, color: COLORS.secondary, fontSize: 12 },
  connectionPill: {
    height: 30,
    paddingHorizontal: 10,
    borderRadius: 15,
    backgroundColor: COLORS.successSoft,
    flexDirection: "row",
    alignItems: "center",
  },
  connectionPillOffline: { backgroundColor: "#eef0f2" },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: COLORS.muted,
  },
  statusDotOnline: { backgroundColor: COLORS.success },
  connectionText: {
    marginLeft: 6,
    color: COLORS.successDark,
    fontSize: 12,
    fontWeight: "600",
  },
  connectionTextOffline: { color: COLORS.secondary },
  previewSection: {
    paddingHorizontal: 20,
    paddingTop: 26,
    paddingBottom: 22,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
  },
  eyebrow: {
    marginBottom: 5,
    color: COLORS.primary,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0,
  },
  sectionTitle: { color: COLORS.ink, fontSize: 18, fontWeight: "700" },
  canvasSize: { color: COLORS.secondary, fontSize: 12 },
  frameStage: {
    width: "100%",
    aspectRatio: 1.28,
    marginTop: 16,
    borderRadius: 8,
    backgroundColor: COLORS.stage,
    alignItems: "center",
    justifyContent: "center",
  },
  frameBody: {
    width: "72%",
    maxWidth: 292,
    aspectRatio: 1,
    borderRadius: 8,
    backgroundColor: COLORS.stage,
  },
  deviceScreen: {
    flex: 1,
    overflow: "hidden",
    borderRadius: 8,
    backgroundColor: "#eef0f3",
  },
  deviceScreenEmpty: { backgroundColor: "#eef0f3" },
  previewImage: { width: "100%", height: "100%" },
  emptyPreview: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyIcon: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.surface,
  },
  emptyTitle: {
    marginTop: 13,
    color: COLORS.ink,
    fontSize: 14,
    fontWeight: "600",
  },
  emptyMeta: { marginTop: 4, color: COLORS.muted, fontSize: 11 },
  videoPreview: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  playButton: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.progress,
  },
  videoScreenName: {
    maxWidth: "90%",
    marginTop: 12,
    color: COLORS.ink,
    fontSize: 12,
  },
  mediaSection: {
    paddingHorizontal: 20,
    paddingTop: 22,
    paddingBottom: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  segmentedControl: {
    height: 58,
    marginTop: 18,
    flexDirection: "row",
    gap: 12,
  },
  segmentButton: {
    flex: 1,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.surface,
  },
  actionIcon: {
    width: 34,
    height: 34,
    marginRight: 10,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  photoActionIcon: { backgroundColor: COLORS.photoSoft },
  videoActionIcon: { backgroundColor: COLORS.videoSoft },
  segmentText: { color: COLORS.ink, fontSize: 14, fontWeight: "600" },
  fileRow: {
    minHeight: 58,
    marginTop: 18,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    flexDirection: "row",
    alignItems: "center",
  },
  fileTypeIcon: {
    width: 38,
    height: 38,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f0f2f4",
  },
  fileInfo: { flex: 1, marginHorizontal: 11 },
  fileName: {
    color: COLORS.ink,
    fontSize: 13,
    fontWeight: "600",
  },
  fileMeta: { marginTop: 4, color: COLORS.secondary, fontSize: 11 },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  progressBlock: { marginBottom: 12 },
  progressHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  progressStatus: { color: COLORS.ink, fontSize: 12, fontWeight: "600" },
  progressLabel: {
    color: COLORS.secondary,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  progressTrack: {
    height: 5,
    marginTop: 8,
    borderRadius: 3,
    overflow: "hidden",
    backgroundColor: "#e4e7eb",
  },
  progressValue: {
    height: "100%",
    borderRadius: 3,
    backgroundColor: COLORS.progress,
  },
  primaryButton: {
    height: 54,
    borderRadius: 8,
    backgroundColor: COLORS.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  primaryButtonDisabled: { backgroundColor: COLORS.disabledButton },
  primaryButtonText: { color: "#ffffff", fontSize: 16, fontWeight: "700" },
  primaryButtonTextDisabled: { color: COLORS.disabledButtonText },
  result: {
    minHeight: 58,
    marginHorizontal: 16,
    marginTop: 14,
    paddingHorizontal: 12,
    borderRadius: 8,
    flexDirection: "row",
    alignItems: "center",
  },
  resultSuccess: { backgroundColor: COLORS.successSoft },
  resultError: { backgroundColor: COLORS.errorSoft },
  resultIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  resultIconSuccess: { backgroundColor: "#d7ece2" },
  resultIconError: { backgroundColor: "#f3dadd" },
  resultText: { flex: 1, marginLeft: 10, fontSize: 13 },
  resultTextSuccess: { color: COLORS.successDark },
  resultTextError: { color: COLORS.error },
});
