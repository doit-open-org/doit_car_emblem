# 第三方 BLE 素材高速传输设备端改造说明 V1.0

文档状态：开发联调版  
更新日期：2026-07-30  
适用设备：第三方纯 BLE 480×480 屏幕设备  
配套协议：`宝妈屏幕 BLE 素材传输协议 V1.0`

## 1. 改造范围

本次只升级第三方 BLE 的链路发送方式，不修改现有媒体传输帧格式，也不涉及 App 自有 V5 协议。

保持不变：

- Service、RX、TX UUID 不变。
- 帧头、命令 Type、Sequence、CRC16、SHA-256 不变。
- 协议 Version 仍为 `0x01`。
- START、DATA、DATA_ACK_REQUEST、END 和 CANCEL 流程不变。
- 仍以设备返回的 START_ACK、累计 DATA_ACK、END_ACK 作为业务成功依据。

本次设备端需要增加：

- RX Characteristic 支持 `Write Without Response`。
- 能连续接收一个 DATA 窗口，不要求每包 ATT Write Response。
- BLE 接收与文件写入解耦，避免 Flash 操作阻塞 BLE 回调。
- 支持 MTU、Data Length、PHY 和连接参数升级。

## 2. GATT 配置

| 项目 | UUID | 设备端属性 | 方向 |
| --- | --- | --- | --- |
| Service | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | Primary Service | - |
| RX | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` | 必须包含 `Write Without Response`，可同时保留 `Write` | App -> 设备 |
| TX | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` | Notify，并提供 CCCD | 设备 -> App |

RX 属性示意：

```c
rx_properties = CHAR_PROP_WRITE_WITHOUT_RESP;

// 如需兼容旧 App，可同时保留 Write with response。
rx_properties |= CHAR_PROP_WRITE;
```

Android 宿主会检查 RX 是否声明 `PROPERTY_WRITE_NO_RESPONSE`。声明后，底层使用 `WRITE_TYPE_NO_RESPONSE`；没有声明时会回退旧写法，速度明显降低。

## 3. 链路参数

| 参数 | 目标值 | 兼容要求 |
| --- | ---: | --- |
| ATT MTU | 517 | 允许协商为较小值，但最低应达到 127 |
| ATT Value 最大长度 | 512 字节 | 必须按实际协商 MTU处理 |
| Link Layer Data Length | 251 字节 | 不支持时允许使用控制器默认值 |
| PHY | LE 2M | 不支持时回退 LE 1M |
| Connection Interval | 建议 7.5～15 ms | 接受手机最终协商值 |
| Peripheral Latency | 建议 0 | 文件传输期间不要主动跳过连接事件 |
| Supervision Timeout | 建议不低于 4 s | 必须满足 BLE 规范约束 |

Android 会请求高连接优先级并优先请求 LE 2M PHY。它们是协商结果，不保证手机和设备一定采用目标值；设备固件必须能在 LE 1M 或较小 MTU 下正常工作。

实际文件分片大小由 START 中的 `Chunk Size` 给出：

```text
Chunk Size + 16 <= 当前允许的 ATT Value 长度
```

MTU 517 时：

```text
ATT Value = 512 字节
协议头尾   = 16 字节
文件负载   = 496 字节/包
```

设备不能把 `496` 写死。

## 4. 高速窗口

RN 当前固定使用 64 包窗口：

```text
DATA x 63 + DATA_ACK_REQUEST x 1 -> DATA_ACK
```

最后一个不足 64 包的窗口按实际剩余数量发送。设备只需要在收到 DATA_ACK_REQUEST 后回复一次累计 DATA_ACK，不要对普通 DATA 逐包回复 Notify。

MTU 517 时，一个完整窗口的上限为：

```text
64 x 512 = 32768 字节 GATT 帧数据
64 x 496 = 31744 字节文件有效负载
```

当前协议没有动态协商窗口大小的字段。设备如果不能持续接收 64 包，必须在联调前告知 App 开发修改 `WINDOW_SIZE`：

| WINDOW_SIZE | 最大 GATT 帧数据 | 建议使用场景 |
| ---: | ---: | --- |
| 64 | 32 KB | 设备接收和存储性能充足 |
| 32 | 16 KB | 中等 RAM 或 Flash 速度 |
| 16 | 8 KB | RAM 较小的设备 |

窗口越小，ACK 次数越多，传输速度会下降。

## 5. 设备接收架构

不要在 BLE RX 回调或中断中同步执行擦除、长时间 Flash 写入、SHA-256 结束计算或素材解析。

推荐数据流：

```text
BLE RX callback
  -> 校验长度并立即复制到接收环形缓冲区
  -> 返回 BLE 协议栈

文件接收任务
  -> 从环形缓冲区取帧
  -> 校验 Magic / Version / Length / CRC16 / Sequence
  -> 追加写入临时文件
  -> 增量更新 SHA-256
  -> 更新 next_expected_sequence
  -> 遇到 DATA_ACK_REQUEST 时发送累计 DATA_ACK
```

缓存建议：

- 最稳妥方案：可容纳完整 64 包窗口，原始帧缓存至少 32768 字节，连同索引和对齐建议预留 36 KB 以上。
- 流式方案：可使用较小环形缓冲区，但消费任务的持续写入速度必须不低于 BLE 输入速度，并且不能出现长时间 Flash 擦除停顿。
- 传输开始前应预分配或预擦除目标空间，避免窗口中途进行耗时擦除。
- 环形缓冲区满时不得覆盖尚未处理的数据。

## 6. ACK 规则

`Write Without Response` 取消的是 ATT 层逐包响应，不取消业务层 ACK。设备仍必须按媒体协议返回 START_ACK、DATA_ACK 和 END_ACK。

设备维护：

```c
uint32_t next_expected_sequence;
```

DATA 处理规则：

| 收到的 Sequence | 处理方式 |
| --- | --- |
| 等于 `next_expected_sequence` | 持久化 Payload，成功后将序号加 1 |
| 小于 `next_expected_sequence` | 重复包，丢弃 Payload |
| 大于 `next_expected_sequence` | 存在缺包，丢弃当前包，等待窗口重传 |

收到 DATA_ACK_REQUEST 后始终回复：

```text
Type        = 0x82
Transfer ID = 当前 Transfer ID
Sequence    = next_expected_sequence
Payload     = 00
```

ACK 中的 Sequence 必须表示“下一期望分片序号”。只有数据已经写入临时文件并纳入 SHA-256 后，才能推进 `next_expected_sequence`。不能在数据只进入环形缓冲区时提前确认。

如果某个窗口发生丢包或接收缓冲区溢出：

- 保留当前 `next_expected_sequence`。
- 丢弃后续越序包。
- 收到 DATA_ACK_REQUEST 时返回缺失序号。
- App 会从该序号重发，设备不得把可恢复缺包当成永久错误。

## 7. 推荐伪代码

```c
void ble_rx_callback(const uint8_t *value, uint16_t len)
{
    if (len < 16 || len > negotiated_att_value_max) {
        rx_stats.invalid_length++;
        return;
    }

    // 回调中只复制，不执行文件系统和显示操作。
    if (!ring_push_copy(&rx_ring, value, len)) {
        rx_stats.overflow++;
        return;
    }
    signal_file_rx_task();
}

void file_rx_task(void)
{
    bmt_frame_t frame;
    while (ring_pop(&rx_ring, &frame.raw, &frame.raw_len)) {
        if (!bmt_decode_and_check_crc(frame.raw, frame.raw_len, &frame)) {
            continue;
        }

        switch (frame.type) {
        case BMT_DATA:
        case BMT_DATA_ACK_REQUEST:
            process_data_in_order(&frame);
            if (frame.type == BMT_DATA_ACK_REQUEST) {
                send_data_ack(frame.transfer_id,
                              next_expected_sequence,
                              BMT_STATUS_OK);
            }
            break;

        default:
            process_control_frame(&frame);
            break;
        }
    }
}
```

实际代码还必须实现完整的 Transfer ID、状态机、CRC16、SHA-256、临时文件和重复帧处理，不能只使用上述伪代码。

## 8. 失败与恢复

- CRC 错误：该包不得写入，不推进序号。
- 缺包或越序：累计 ACK 返回当前缺失序号，等待 App 重传。
- 重复包：不得重复写入文件或重复更新 SHA-256。
- Flash 写失败：回复 `STORAGE_WRITE_FAILED (0x06)` 并清理临时任务。
- 存储空间不足：START 阶段回复 `NO_SPACE (0x03)`。
- BLE 断开：关闭并删除未完成临时文件，保留当前显示素材。
- CANCEL：立即停止接收并删除本次临时文件。
- END 校验失败：不得替换旧素材。

## 9. 性能联调指标

以下为建议联调目标，不是所有芯片和手机都能保证的固定值：

| 链路状态 | 建议观察的有效文件吞吐 |
| --- | ---: |
| LE 1M，较小 MTU | 20～50 KB/s |
| LE 1M + DLE 251 | 40～80 KB/s |
| LE 2M + DLE 251 | 60～120 KB/s |

联调时同时记录：

- 实际 ATT MTU。
- 实际 PHY（1M/2M）。
- 实际 Data Length。
- 实际 Connection Interval。
- 每秒收到的 DATA 包数和有效字节数。
- 环形缓冲区最大占用量和溢出次数。
- DATA 窗口重传次数。
- Flash 单次写入最大耗时。

如果吞吐低但没有重传，优先检查 PHY、Connection Interval 和 Flash 写入耗时；如果出现大量窗口重传，优先检查 RX 缓冲区、序号处理和回调阻塞。

## 10. 联调验收清单

- [ ] RX 特征属性包含 `Write Without Response`。
- [ ] TX Notify 和 CCCD 正常。
- [ ] MTU 517 可协商；协商较小时仍能按 START 的 Chunk Size 接收。
- [ ] 支持 DLE 251；不支持时能够正常回退。
- [ ] 支持 LE 2M；不支持时能够正常使用 LE 1M。
- [ ] 64 包连续写入无接收缓冲区溢出。
- [ ] 每个窗口只在 DATA_ACK_REQUEST 后回复一次累计 DATA_ACK。
- [ ] DATA_ACK.Sequence 是下一期望序号。
- [ ] ACK 只确认已经持久化的数据。
- [ ] 重复 DATA 不会重复写文件或更新 SHA-256。
- [ ] 人为丢弃一个 DATA 后，App 可以从缺失序号恢复。
- [ ] 人为丢弃一次 DATA_ACK 后，重复窗口可以正确处理。
- [ ] 3 MB 文件连续传输 10 次均成功。
- [ ] 20 MB 文件连续传输 3 次均成功。
- [ ] 传输中断电、断连或 CANCEL 后不会替换旧素材。
- [ ] 文件 SHA-256 或显示失败时保留旧素材。

## 11. 与 App 联调前需反馈

嵌入式同事需要向 App 开发确认以下结果：

```text
芯片/协议栈：
RX 是否支持 Write Without Response：
最大 ATT MTU：
是否支持 DLE 251：
是否支持 LE 2M：
建议 Connection Interval：
可用于 BLE RX 的缓冲区大小：
能够稳定支持的 WINDOW_SIZE：
实测持续吞吐 KB/s：
```

如果稳定窗口小于 64，必须在 RN 发版前同步修改 `WINDOW_SIZE`，不能只在设备端自行使用不同窗口值。
