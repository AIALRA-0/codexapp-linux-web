# 本轮可复核测试观察

日期：2026-08-14

范围：候选代码、官方包、隔离 CLI；不包含生产 B 数据或登录后的真实浏览器。

## B1：现有 26.803 引擎上的稳定性修复

- 源码：detached worktree `/tmp/codexapp-b1-ef5d3ae.yClJ8pzv`
- 提交：`ef5d3ae`
- `npm ci --include=dev`：通过
- `npm run build`：通过
- 以官方 26.803 qualified source 执行完整 CI：52 个测试文件通过，276 个测试通过，1 个跳过
- A 的关键 `runtime.ts` 与测试已按文件哈希恢复进 Git

## B2：官方 Linux 26.810

- 提交：`67050a8`
- Debian 包版本：`26.810.41047`
- Debian 包 SHA-256：`78715fa3cd136ff67070daa76819adaecc5b42e99851559659645dce1fbf2af3`
- ASAR SHA-256：`75b341a8e19dcf420090a51389bb90688036ca29cfa65847a65932f0aa898278`
- 内置 CLI：`0.148.0-alpha.9`
- 签名仓库密钥指纹：`3BFA0E4AE8B8CC16A2D9BA684A3B4A566C4660E4`
- signed `InRelease` 与 `Packages` 记录校验：通过
- preload 合同：21 个方法、17 个频道，通过
- `npm run build`：通过
- `npm run ci`：通过
- 以 26.810 qualified source 再跑测试：52 个测试文件通过，276 个测试通过，1 个跳过
- `npm audit --audit-level=high`：0 个漏洞
- `npm audit --omit=dev --audit-level=high`：0 个漏洞
- shell 语法和 systemd unit verify：通过
- CLI 0.148 空状态隔离探针：`initialize`、`account/read`、`model/list`、`config/read`、`thread/list` 均返回合法对象，进程正常退出

## 还没有通过的生产验收

- 真实 B state 的静止快照、校验、隔离恢复和旧 CLI 回读
- 确认生产 B 只保留 Trillium Note，并删除审计产生的 synthetic runtime/user
- Authentik 登录后的冷/热加载、Trillium 最新正文、发送/断线/离网页面关闭续跑
- 五种语言的实际文本和刷新保持
- 每个必需 MCP、Skill、App、Plugin 的真实调用
- 生产 B 的内存、PSI、swap 和 A 不受影响的联合观察

因此，本文件支持“候选可进入生产门禁”，不支持“生产 B 已完成”。
