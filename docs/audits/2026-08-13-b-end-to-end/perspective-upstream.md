# 独立视角：官方 26.810 兼容性

审查者：子代理 `upstream_compat`（隔离任务）

日期：2026-08-14

## 结论

26.810 不能直接套用 26.803 的压缩导出映射，但可以在保持官方 renderer/preload 原样的前提下，通过版本限定的薄适配层支持。

## 决定性发现

- 原资格校验失败是路径遍历顺序问题，不是文件差异：1014 个 host 文件、29,722,746 字节，逐文件内容零差异。提交 `ef5d3ae` 改为全局 POSIX 路径排序并增加回归测试。
- 26.810 的 preload SHA 与 26.803 相同，仍是 21 个方法、17 个频道；Electron 仍为 42.3.0。
- 旧版 desktop/Git/developer/thread 压缩映射在 26.810 已错位。提交 `67050a8` 增加 26.810 专属映射、构造能力区分和本地执行 host 提取器。
- app-server schema 以加法为主；本轮结构比较没有发现删除、required 或 enum 的破坏性变化，但仍须按实际 26.810 schema 做集成测试。
- 26.810 候选已通过 desktop 行为、Git worktree、线程转换、preload 合同，以及 CLI 0.148 的 `initialize`、`account/read`、`model/list`、`config/read`、`thread/list` 隔离探针。

## 限制

压缩私有导出不是上游稳定 API。每个官方版本都必须重新资格校验、行为测试和真实网页验收，不能把这次映射永久外推。
