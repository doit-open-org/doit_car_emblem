# 宝妈屏幕 BLE 素材传输协议 V1.0（嵌入式实施版）

文档状态：开发联调版  
更新日期：2026-07-30  
适用设备：第三方纯 BLE 480×480 屏幕设备

## 1. 固件需要实现什么

设备只负责通过 BLE 接收文件并显示，不访问 HTTP，不处理服务器路径、DP33 或 CMD3。

```text
RN/App                         设备
  |------ START ------------->|  创建临时文件，保存元数据
  |<----- START_ACK ----------|  同意接收
  |------ DATA 0 ------------>|  按序写入临时文件
  |------ DATA 1 ------------>|
  |             ...            |
  |------ DATA_ACK_REQUEST --->|
  |<----- DATA_ACK -----------|  累计确认下一期望序号
  |             ...            |
  |------ END --------------->|  校验大小和 SHA-256，显示
  |<----- END_ACK ------------|  最终成功
```

设备必须做到：

- 边接收边写临时文件，不要求将整个文件放入 RAM。
- 只有 END 校验和显示全部成功后，才能替换当前素材。
- 失败时保留旧素材，删除未完成的临时文件。
- 正确处理重复 START、重复 DATA、重复 END 和 ACK 丢失。

## 2. GATT 服务

| 项目 | UUID | 属性 | 方向 |
| --- | --- | --- | --- |
| Service | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | Primary Service | - |
| RX | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` | Write Without Response，可同时保留 Write | App → 设备 |
| TX | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` | Notify | 设备 → App |

固件配置要求：

| 项目 | 要求 |
| --- | --- |
| 建议 ATT MTU | 517 |
| RN 最低接受 ATT MTU | 127 |
| RX 最大 Attribute Value | 512 字节 |
| 建议 Link Layer Data Length | 251 字节 |
| 建议 PHY | LE 2M，不支持时使用 LE 1M |
| TX | Notify，并提供 CCCD |

Android 宿主在高速模式下会优先使用 `Write Without Response`、请求高连接优先级并尝试切换 LE 2M PHY。若 RX 未声明 `WRITE_NO_RESPONSE`，宿主会兼容回退到原有写入方式，但传输速度会明显降低。应用层仍按 DATA 窗口发送，并以设备累计 ACK 作为可靠性依据。

MTU 517 时，一个 GATT Value 最大按 512 字节处理。协议头尾共 16 字节，因此一个 DATA 帧最多携带 `512 - 16 = 496` 字节文件内容。

设备不能把 496 写死。实际 `Chunk Size` 由 START 帧携带，应按 START 中的值处理。

## 3. 基本约定

- 所有多字节整数均为无符号小端序 Little Endian。
- 一个 RX Characteristic Write 对应一个完整协议帧。
- 不需要跨多次 GATT Write 拼接协议帧。
- TX 每次 Notify 发送一个完整 ACK/ERROR 帧。
- 文件名只允许 ASCII 可见字符，长度 1～64 字节。
- 当前文件类型只支持 JPEG 和 VPG。

## 4. 通用帧格式

| 偏移 | 长度 | 字段 | 说明 |
| ---: | ---: | --- | --- |
| 0 | 2 | Magic | 固定 `0x42 0x4D`，ASCII `BM` |
| 2 | 1 | Version | 固定 `0x01` |
| 3 | 1 | Type | 命令类型 |
| 4 | 4 | Transfer ID | 本次传输标识，小端序 |
| 8 | 4 | Sequence | 分片序号或累计 ACK 序号，小端序 |
| 12 | 2 | Payload Length | Payload 长度 N，小端序 |
| 14 | N | Payload | 命令负载 |
| 14+N | 2 | CRC16 | CRC16-CCITT-FALSE，小端序 |

```text
Frame Length = Payload Length + 16
```

设备收到帧后依次检查：

1. 总长度至少为 16 字节。
2. Magic 为 `42 4D`。
3. Version 为 `01`。
4. 实际帧长度等于 `Payload Length + 16`。
5. CRC16 正确。
6. Transfer ID 与当前任务匹配。
7. Type、Sequence 和 Payload 符合当前状态。

## 5. CRC16

使用 CRC16-CCITT-FALSE：

| 参数 | 值 |
| --- | --- |
| Polynomial | `0x1021` |
| Initial Value | `0xFFFF` |
| RefIn / RefOut | false / false |
| XorOut | `0x0000` |
| 帧内字节序 | 小端序，低字节在前 |

CRC 计算范围为帧偏移 `0` 到 `13+N`，不包含帧尾两个 CRC 字节。

```text
标准输入: ASCII "123456789"
CRC 数值: 0x29B1
帧内顺序: B1 29
```

```c
uint16_t bmt_crc16_ccitt(const uint8_t *data, size_t len)
{
    uint16_t crc = 0xFFFF;
    for (size_t i = 0; i < len; i++) {
        crc ^= (uint16_t)data[i] << 8;
        for (uint8_t bit = 0; bit < 8; bit++) {
            crc = (crc & 0x8000)
                ? (uint16_t)((crc << 1) ^ 0x1021)
                : (uint16_t)(crc << 1);
        }
    }
    return crc;
}
```

## 6. 命令列表

| Type | 名称 | 方向 | Sequence 含义 |
| ---: | --- | --- | --- |
| `0x01` | START | App → 设备 | 固定 0 |
| `0x02` | DATA | App → 设备 | 当前文件分片序号 |
| `0x03` | END | App → 设备 | Total Packets |
| `0x04` | CANCEL | App → 设备 | 固定 0 |
| `0x05` | DATA_ACK_REQUEST | App → 设备 | 当前文件分片序号 |
| `0x81` | START_ACK | 设备 → App | 固定 0 |
| `0x82` | DATA_ACK | 设备 → App | 下一期望分片序号 |
| `0x83` | END_ACK | 设备 → App | Total Packets |
| `0xFF` | ERROR | 设备 → App | 当前下一期望分片序号 |

## 7. START

### 7.1 Payload

| Payload 偏移 | 长度 | 字段 | 说明 |
| ---: | ---: | --- | --- |
| 0 | 4 | File Size | 文件总字节数 |
| 4 | 4 | Total Packets | 文件总分片数 |
| 8 | 2 | Chunk Size | 普通 DATA 最大文件负载 |
| 10 | 1 | File Type | `1=JPEG`，`2=VPG` |
| 11 | 1 | File Name Length | 文件名长度 M，1～64 |
| 12 | 32 | SHA-256 | 文件 SHA-256 原始 32 字节 |
| 44 | M | File Name | ASCII 文件名，不带目录 |

```text
START Payload Length = 44 + File Name Length
Total Packets = ceil(File Size / Chunk Size)
File Size > 0
Chunk Size > 0
Chunk Size + 16 <= 当前允许的 GATT Value 长度
```

### 7.2 设备处理

收到合法 START 后：

1. 检查文件类型、文件大小和存储空间。
2. 创建临时文件。
3. 保存所有元数据。
4. 设置 `next_expected_sequence = 0`。
5. 初始化增量 SHA-256。
6. 回复 START_ACK，Payload 为 `00`。

如果正在接收另一个 Transfer ID，可清理旧临时任务后接受新任务，也可回复 `0x02`（设备忙）。

重复收到相同 Transfer ID 且元数据完全相同的 START 时，应直接重发 START_ACK，不能清空已接收的数据。

## 8. DATA 和累计 ACK

DATA 与 DATA_ACK_REQUEST 的 Payload 全部为文件原始字节，没有子字段。

```text
offset = Sequence * Chunk Size
```

非最后一包：

```text
Payload Length = Chunk Size
```

最后一包：

```text
Payload Length = File Size - Sequence * Chunk Size
```

RN 当前每 64 个分片发送一次 DATA_ACK_REQUEST。它也携带文件数据，与 DATA 的唯一区别是设备处理后必须回复 DATA_ACK。

设备维护 `next_expected_sequence`：

| 收到的 Sequence | 处理方式 |
| --- | --- |
| 等于 `next_expected_sequence` | 写入 Payload，更新 SHA-256，然后 `next_expected_sequence++` |
| 小于 `next_expected_sequence` | 重复包，丢弃，不重复写文件 |
| 大于 `next_expected_sequence` | 有缺包，丢弃，等待 App 重传 |

收到 DATA_ACK_REQUEST 时，无论该包正常、重复还是越序，都必须回复 DATA_ACK：

```text
Type        = 0x82
Transfer ID = 当前 Transfer ID
Sequence    = next_expected_sequence
Payload     = 00
```

例如 `DATA_ACK.Sequence = 128` 表示设备已持久化分片 0～127，App 下一次从 128 发送。

注意：DATA_ACK.Sequence 是“下一期望序号”，不是“最后收到的序号”。

ACK 超时后 App 会使用相同 Transfer ID 重发窗口。设备必须丢弃重复 DATA，但重复 DATA_ACK_REQUEST 仍要回复当前累计 ACK。

## 9. END

```text
Type        = 0x03
Transfer ID = 当前 Transfer ID
Sequence    = Total Packets
Payload     = 文件 SHA-256 原始 32 字节
```

收到 END 后：

1. 检查 Transfer ID。
2. 检查 `next_expected_sequence == Total Packets`。
3. 检查临时文件大小等于 File Size。
4. 完成 SHA-256，检查结果与 START、END 一致。
5. 关闭并同步临时文件。
6. 解析 JPEG/VPG，确认文件可用。
7. 原子替换正式素材并切换屏幕显示。
8. 回复 END_ACK，Payload 为 `00`。

只有第 1～7 步全部成功后才能回复成功 END_ACK。

如果文件已经成功显示但 END_ACK 丢失，App 会重复发送相同 END。设备应记录最近成功的 Transfer ID，直接重发 END_ACK。

## 10. CANCEL

```text
Type           = 0x04
Sequence       = 0
Payload Length = 0
```

收到当前 Transfer ID 的 CANCEL 后，停止写入、关闭并删除临时文件、清除传输状态，同时保留当前旧素材。当前版本不要求回复 CANCEL_ACK。

## 11. ACK 和错误码

START_ACK、DATA_ACK、END_ACK、ERROR 的 Payload 第 1 字节必须是状态码。

| 状态码 | 名称 | 含义 |
| ---: | --- | --- |
| `0x00` | OK | 成功 |
| `0x01` | INVALID_FRAME | 帧格式、长度或 CRC 错误 |
| `0x02` | BUSY | 设备忙 |
| `0x03` | NO_SPACE | 存储空间不足 |
| `0x04` | UNSUPPORTED_TYPE | 不支持的文件类型 |
| `0x05` | INVALID_METADATA | 文件元数据或序号无效 |
| `0x06` | STORAGE_WRITE_FAILED | 文件写入失败 |
| `0x07` | SHA256_MISMATCH | SHA-256 不一致 |
| `0x08` | DISPLAY_FAILED | 文件解析或屏幕显示失败 |
| `0x09` | CANCELED | 传输已取消 |

不可恢复错误可以回复对应 ACK Type 加非 0 状态，也可以回复：

```text
Type        = 0xFF
Transfer ID = 当前 Transfer ID
Sequence    = next_expected_sequence
Payload     = 单字节错误码
```

App 收到非 0 状态后会终止传输并尝试发送 CANCEL。

## 12. 设备状态机

```text
IDLE
  └─ START 合法 → RECEIVING

RECEIVING
  ├─ DATA / DATA_ACK_REQUEST → 写文件或处理重复/越序包
  ├─ END 且全部分片已收到 → VERIFYING
  ├─ CANCEL → 清理临时文件 → IDLE
  └─ 不可恢复错误 → ERROR + 清理 → IDLE

VERIFYING
  ├─ 大小、SHA、解析、显示成功 → END_ACK → IDLE
  └─ 失败 → ERROR → 保留旧素材 → IDLE
```

```c
void on_bmt_rx(const uint8_t *frame, uint16_t frame_len)
{
    bmt_frame_t msg;
    if (!bmt_decode_and_check_crc(frame, frame_len, &msg)) {
        send_error_if_transfer_known(INVALID_FRAME);
        return;
    }

    switch (msg.type) {
    case BMT_START:
        handle_start(&msg);
        break;

    case BMT_DATA:
    case BMT_DATA_ACK_REQUEST:
        if (!transfer_id_matches(msg.transfer_id)) {
            send_error(msg.transfer_id, INVALID_METADATA);
            return;
        }
        if (msg.sequence == next_expected_sequence) {
            if (!temp_file_append(msg.payload, msg.payload_len)) {
                send_error(msg.transfer_id, STORAGE_WRITE_FAILED);
                abort_transfer();
                return;
            }
            sha256_update(&sha_ctx, msg.payload, msg.payload_len);
            next_expected_sequence++;
        }
        if (msg.type == BMT_DATA_ACK_REQUEST) {
            send_data_ack(msg.transfer_id, next_expected_sequence, OK);
        }
        break;

    case BMT_END:
        handle_end(&msg);
        break;

    case BMT_CANCEL:
        abort_transfer();
        break;

    default:
        send_error(msg.transfer_id, INVALID_FRAME);
        break;
    }
}
```

## 13. 十六进制测试帧

以下帧由 RN 当前编码器生成，可直接作为固件单元测试向量。

```text
Transfer ID  : 0x12345678（线路顺序 78 56 34 12）
文件名       : demo.jpg
File Size    : 1024
Total Packets: 3
Chunk Size   : 496
SHA-256      : 32 字节全 00，仅用于协议测试
```

START：

```text
424d0101785634120000000034000004000003000000f0010108000000000000000000000000000000000000000000000000000000000000000064656d6f2e6a706766e8
```

START_ACK 成功：

```text
424d0181785634120000000001000054e2
```

DATA_ACK_REQUEST，Sequence=0，Payload=`41 42 43`：

```text
424d0105785634120000000003004142436dbb
```

DATA_ACK，下一期望 Sequence=1：

```text
424d01827856341201000000010000aa5f
```

END，Sequence=3：

```text
424d0103785634120300000020000000000000000000000000000000000000000000000000000000000000000000165a
```

END_ACK 成功：

```text
424d018378563412030000000100003c3c
```

## 14. 固件验收清单

- MTU 517 协商正常，协商不足时仍按 START 的 Chunk Size 接收。
- RX 可以接收最大 512 字节 GATT Value。
- TX Notify 能稳定发送 ACK。
- CRC 标准向量 `123456789 → 0x29B1` 通过。
- 第 13 节全部测试帧解析和 CRC 校验通过。
- JPEG 480×480 能保存并显示。
- VPG 能保存、解析并播放。
- 3 MB 和 20 MB 文件可边收边写，不需要整文件 RAM。
- 主动丢失一个 DATA 后，DATA_ACK 返回正确缺失序号。
- 重复 DATA 不会重复写入。
- 丢弃一次 DATA_ACK 后，App 重传窗口时设备能继续接收。
- 丢弃一次 START_ACK/END_ACK 后，重复 START/END 能正确响应。
- SHA-256 不一致返回 `0x07`，不替换旧素材。
- 存储空间不足返回 `0x03`。
- 显示失败返回 `0x08`，保留旧素材。
- CANCEL 后删除临时文件，旧素材保持显示。
- BLE 断开后清理或超时清理未完成临时文件。

## 15. 最终成功标准

App 只有收到状态为 `0x00` 的 END_ACK 才显示“素材已更新到设备”。

固件回复成功 END_ACK 必须同时代表：

```text
文件接收完整
+ 文件大小正确
+ SHA-256 正确
+ 文件已经安全落盘
+ 文件可以解析
+ 屏幕已经切换显示
```

不能在刚收到 END 或只完成文件写入时提前回复成功。
