# 宝妈屏幕 BLE 素材传输协议 V1

## 1. 链路和职责

设备为纯 BLE 设备，不访问 HTTP，也不解析服务器路径。

完整流程：

1. RN 将图片或视频上传到现有接口，图片为 `480×480 JPEG`，视频/GIF 等待服务器生成 VPG。
2. 接口路径先规范为 `260717/49e35600.jpg` 形式。
3. RN 使用固定前缀拼成下载地址：
   `http://tui.doit.am/second_dimension/uploads/20` + `260717/49e35600.jpg`
4. RN 下载文件并计算 SHA-256。
5. RN 通过本协议将文件内容分包写入设备。
6. 设备收到 END 后校验 SHA-256，保存并成功显示后回复 END_ACK。

因此设备端不再实现 DP33、CMD3 或 HTTP 下载。

## 2. GATT 定义

| 项目 | UUID | 属性 | 方向 |
| --- | --- | --- | --- |
| Service | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | Primary Service | - |
| RX | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` | Write Without Response，可同时保留 Write | App -> 设备 |
| TX | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` | Notify | 设备 -> App |

设备应支持 ATT MTU 517，最低可接受 MTU 为 127。RN 会先申请 MTU 517，再开启 TX Notify。单次特征值值长度最大限制为 512 字节，因此 MTU 517 时每个 DATA 帧最多携带 496 字节文件数据。每次特征值写入只包含一个完整协议帧，不跨 GATT 写入拼接帧。

## 3. 通用帧格式

除特别说明外，多字节整数均为无符号小端序。

| 偏移 | 长度 | 字段 | 说明 |
| ---: | ---: | --- | --- |
| 0 | 2 | Magic | 固定 `0x42 0x4D`，ASCII `BM` |
| 2 | 1 | Version | 固定 `0x01` |
| 3 | 1 | Type | 见命令表 |
| 4 | 4 | Transfer ID | RN 为每次传输随机生成 |
| 8 | 4 | Sequence | DATA 序号或累计 ACK 的下一期望序号 |
| 12 | 2 | Payload Length | 负载字节数 N |
| 14 | N | Payload | 命令负载 |
| 14+N | 2 | CRC16 | CRC16-CCITT-FALSE，小端序 |

CRC 参数：初值 `0xFFFF`，多项式 `0x1021`，不反转，结果不异或。计算范围为帧偏移 `0` 到 `13+N`，不包含最后两个 CRC 字节。

## 4. 命令

| Type | 名称 | 方向 | Sequence |
| ---: | --- | --- | --- |
| `0x01` | START | App -> 设备 | 0 |
| `0x02` | DATA | App -> 设备 | 从 0 开始的分片序号，不要求立即 ACK |
| `0x03` | END | App -> 设备 | 总分片数 |
| `0x04` | CANCEL | App -> 设备 | 0 |
| `0x05` | DATA_ACK_REQUEST | App -> 设备 | 数据含义同 DATA，处理后必须回复 DATA_ACK |
| `0x81` | START_ACK | 设备 -> App | 0 |
| `0x82` | DATA_ACK | 设备 -> App | 下一期望分片序号 |
| `0x83` | END_ACK | 设备 -> App | 总分片数 |
| `0xFF` | ERROR | 设备 -> App | 当前下一期望分片序号 |

### 4.1 START 负载

| 偏移 | 长度 | 字段 |
| ---: | ---: | --- |
| 0 | 4 | File Size，文件总字节数 |
| 4 | 4 | Total Packets，总分片数 |
| 8 | 2 | Chunk Size，每个 DATA 最大负载 |
| 10 | 1 | File Type：`1=JPEG`，`2=VPG` |
| 11 | 1 | File Name Length，1 至 64 |
| 12 | 32 | 文件 SHA-256 原始 32 字节 |
| 44 | M | ASCII 文件名，长度由上一字段给出 |

设备检查空间、类型和元数据后回复 START_ACK。重复收到 Transfer ID 和元数据完全相同的 START 时，应直接重发 START_ACK，不要破坏已经收到的数据。

### 4.2 DATA / DATA_ACK_REQUEST 负载

负载全部是文件原始字节。文件偏移为 `Sequence × Chunk Size`，最后一包可以小于 Chunk Size。

RN 当前每 64 包设置一次 `DATA_ACK_REQUEST`，最后不足 64 包时也会将最后一包设为该类型。设备处理 DATA 时不回复；处理 DATA_ACK_REQUEST 后回复一次 DATA_ACK。

DATA_ACK 使用累计确认：`Sequence` 表示设备下一包期望收到的序号，即 `[0, Sequence)` 均已正确落盘。例如 `Sequence=12` 表示 0 至 11 已收到，RN 下一次从 12 继续发送。

设备处理规则：

- 收到期望序号：校验帧 CRC 后写入，并将下一期望序号加 1。
- 收到小于期望值的重复包：丢弃内容；若是 DATA_ACK_REQUEST，仍回复当前下一期望序号。
- 收到大于期望值的包：不写入；若是 DATA_ACK_REQUEST，回复当前下一期望序号，让 RN 从缺失包重传。

### 4.3 END 负载

END 负载为文件 SHA-256 原始 32 字节。设备仅在以下步骤全部成功后回复 END_ACK 且状态为 0：

1. 已收到的字节数等于 File Size；
2. 文件 SHA-256 与 START/END 一致；
3. 文件已完整持久化；
4. 文件格式可解析，并已切换到屏幕显示。

重复收到已成功完成的同一 Transfer ID END 时，设备应重发 END_ACK，保证 ACK 丢失时 RN 可以安全重试。

### 4.4 ACK 和 ERROR 负载

ACK/ERROR 的负载第 1 字节为状态码：

| 状态 | 含义 |
| ---: | --- |
| `0` | 成功 |
| `1` | 帧格式或 CRC 错误 |
| `2` | 设备忙 |
| `3` | 存储空间不足 |
| `4` | 不支持的文件类型 |
| `5` | 文件元数据无效 |
| `6` | 文件写入失败 |
| `7` | SHA-256 不一致 |
| `8` | 文件解析或屏幕显示失败 |
| `9` | 传输已取消 |

ACK 成功负载固定为单字节 `0x00`。失败时可以回复对应 ACK 或 ERROR；RN 均会停止本轮流程并提示错误。

## 5. 超时和重试

- RN 为每批写入预留每包最多 80 ms，再等待 START_ACK、DATA_ACK 或 END_ACK；64 包数据窗口的总超时约 9.1 秒。
- 同一批次最多发送 3 次，重试时 Transfer ID 和 Sequence 不变。
- RN 不等待宿主 `2203` GATT 完成事件；设备 DATA_ACK/END_ACK 是文件接收成功的唯一依据。
- 连接断开、3 次无 ACK、状态码非 0 时，RN发送一次 CANCEL 并结束。
- 设备收到 CANCEL 后应关闭临时文件并删除未完成数据；不得替换当前正在显示的有效素材。
- 新 START 到达时若设备正在处理另一个 Transfer ID，可清理旧临时传输后接收新任务，或回复状态 `2`。

## 6. 设备端验收要点

- 支持 JPEG 480×480 和服务器生成的 VPG；显示切换必须是原子的，失败时保留旧素材。
- 使用临时文件接收，END 校验成功后再改名为正式文件。
- CRC 错误的帧不得写入。
- Transfer ID、Sequence、文件大小和长度计算全部按无符号数处理。
- 能正确处理 START、DATA 窗口、END 的重复发送以及 ACK 丢失。
- 用 1 MB 以上文件持续传输，确认无内存整文件缓存要求，可边收边写存储。
