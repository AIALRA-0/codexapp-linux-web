# 独立视角：运维、安全与资源

审查者：子代理 `ops_security`（隔离任务）

日期：2026-08-14

## 结论

A 必须优先。服务器无需立即扩容，但只有在资源门槛持续为绿、B 可恢复且 B 无后台任务时，才允许执行 B 的构建、快照或切换。

## 决定性发现

- 主机为 8 核、23 GiB RAM、16 GiB swap；磁盘约有 134 GiB 可用，容量不是当前瓶颈。
- A 固定使用自身 26.803 release 和 CLI 0.147 路径；B 的全局 current 切换不应改变 A。
- B 的 6 GiB 内存上限曾累计触顶 1553 次，发生大量 direct pgscan 和 major fault，尚未 OOM。
- 高负载采样曾出现 CPU idle 1–3%、swap 写入 58 MB/s、memory PSI full avg60 7.19%、IO PSI full avg60 15.36%；当时禁止任何 B 重操作。后续重操作只有在连续资源门槛为绿时以 `nice 15 + ionice idle`、并发不超过 2 执行。
- A/B 共享 Xvfb 和 OpenAI 出口代理；不得为 B 重启这些共享依赖。
- B 对外只经 Nginx/Cloudflare，内部仅监听 `127.0.0.1:13014`；未登录认证跳转正常，但不证明登录后的页面或对话正确。
- A 用户当前可读 B 的 session/proxy secret，实例不是强隔离。修复方案是 B 专用 secret group 和 B 密钥轮换；不得改变 A。

## 建议的 B 资源边界

- `MemoryHigh=6G`
- `MemoryMax=8G`
- `MemorySwapMax=2G`
- `CPUQuota=400%`
- `CPUWeight=100`（A 为 200）
- `IOWeight=50`
- `TasksMax=1024`
- `MAX_SESSIONS=10`
- `MAX_SESSIONS_PER_USER=4`
- `IDLE_RUNTIME_SECONDS=86400`

后台任务或引用存在时，idle 清理逻辑不会停止 runtime；保留 86400 秒只影响空闲保温时间。

## 限制

当前身份无 root、无 B state 和 journal 读取权；本审查不能替代 root 下的生产快照、恢复演练和密钥轮换。
