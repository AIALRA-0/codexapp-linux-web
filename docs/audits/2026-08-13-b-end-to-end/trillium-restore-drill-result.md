# Trillium Note 真实恢复演练

日期：2026-08-14

## 已验证

- 来源是 B 的静止生产快照：`20260814T041806Z-before-pre-b1-restore-drill-88ee6ba`。
- 快照包含 319,531 个文件；整份 `STATE-SHA256SUMS` 已独立复算通过。
- 快照中的 40 个 SQLite 文件均通过 `PRAGMA integrity_check`。
- 唯一保留项目是 `Trillium Note`，唯一保留线程是 `019f7292-0097-79c2-a19a-ea179c9327cc`。
- 线程历史文件为 622,914,479 字节，SHA-256 为 `b0f1f64af3883a325e7393bb948b9df9aba30a49a3cf095594775368b0b45147`。
- `codex-cli 0.147.0-alpha.6` 在完整隔离副本中成功完成 `thread/read` 和 `thread/resume`，工作区指向隔离恢复的 `trillium-reader`，耗时 38,230 ms。
- 验证后历史文件字节数和 SHA-256 均未改变；A、B 的 `/readyz` 均保持正常。

## 待补齐

- 使用 `codex-cli 0.148.0-alpha.9` 对同一隔离副本重复读取和恢复。
- B1/B2 候选主机在隔离环境中完成真实浏览器加载、发送、语言和刷新保持测试。
