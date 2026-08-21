# CodexApp B 分阶段发布手册

适用日期：2026-08-14

目标站：`https://codexapp.aialra.online`

稳定控制站：`https://newcodexapp.aialra.online`

这份手册只操作 B。任何命令如果要求重启 A、Xvfb、WARP 或共享 OpenAI 出口代理，立即停止。

## 0. 固定输入

```bash
repo="${CODEXAPP_REPO:?export CODEXAPP_REPO to the checked-out repository path}"
b1_source=/tmp/codexapp-b1-ef5d3ae.yClJ8pzv
b2_source="$repo"
b1_release=20260814.0100-b1-stability
b2_release=20260814.0200-b2-official-26.810
b_user_key="${B_USER_KEY:-}"
synthetic_user_key="${B_SYNTHETIC_AUDIT_USER_KEY:-}"
official_26803=/srv/aialra/codexapp-official/releases/26.803.81509/source
official_deb=/tmp/codex-linux-package.djYQME/chatgpt_amd64.deb
```

两个 user key 都必须由私有运维记录注入，不能提交到 Git。`b_user_key` 仍只是候选；root 必须先盘点，不能因为变量已经设置就直接删除其他用户。

## 1. 发布前硬门槛

以下命令全部通过才继续：

```bash
test "$(id -u)" -eq 0
git -C "$repo" merge-base --is-ancestor \
  67050a816e5c4c17e599d024cf3847261d74becd HEAD
git -C "$repo" diff --exit-code
git -C "$repo" diff --cached --exit-code
curl -fsS http://127.0.0.1:13024/readyz >/dev/null
curl -fsS http://127.0.0.1:13024/ops/background-work \
  | jq -e '.ok == true and .pendingServerRequestCount == 0 and .activeTurnCount <= 1'
curl -fsS http://127.0.0.1:13014/ops/background-work \
  | jq -e '.ok == true and .active == false'
```

再连续运行五分钟：

```bash
source "$repo/ops/lib/release-switch.sh"
codexapp_wait_for_controller_safe
```

该函数会拒绝以下情况：A 不健康、A 有超过一个活动 turn、A 有 pending 请求、memory PSI full avg60 不低于 1%、IO PSI full avg60 不低于 2%、swap 持续进出。

## 2. 只读盘点 B

先列用户，不删除：

```bash
find /srv/aialra/state/codexapp-official/users \
  -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort
```

对每个用户验证数据库，并只输出 thread ID、标题、工作目录、归档状态和更新时间：

```bash
for user_root in /srv/aialra/state/codexapp-official/users/*; do
  test -d "$user_root" || continue
  db="$user_root/codex-home/state_5.sqlite"
  test -f "$db" || continue
  printf 'USER %s\n' "$(basename "$user_root")"
  sqlite3 -readonly "$db" 'pragma integrity_check;'
  sqlite3 -readonly -header -column "$db" \
    'select id,title,cwd,archived,updated_at from threads order by updated_at desc;'
done
```

人工核对必须得到四个唯一值：

- `b_user_key`：真实 Authentik 用户。
- `trillium_thread_id`：唯一要保留的 Trillium Note 对话。
- `trillium_project_id`：`host-state.json` 中与该 thread 绑定的项目。
- `trillium_project_basename`：真实项目目录 basename。

同时确认 `synthetic_user_key` 没有真实 thread、项目、上传或后台任务。不能确认时不删除。

## 3. 先做可恢复快照

不要直接依赖旧的 `backup-old-codexapp.sh`；它不是当前 B state 的生产快照。

B 保持无后台任务。先把大部分数据低优先级预复制，再停 B 做最终一致副本：

```bash
source "$repo/ops/lib/release-switch.sh"
codexapp_wait_for_controller_safe
codexapp_assert_no_background_work
codexapp_prepare_state_snapshot pre-b1-restore-drill
snapshot_root="$CODEXAPP_PREPARED_SNAPSHOT_ROOT"
systemctl stop codexapp-official-web-host.service
codexapp_finalize_state_snapshot \
  "$snapshot_root" \
  "$(readlink -f /srv/aialra/apps/codexapp-official-web-host/current)" \
  "$(readlink -f /srv/aialra/codexapp-official/current)" \
  pre-b1-restore-drill
systemctl start codexapp-official-web-host.service
codexapp_wait_for_health 90
```

验证快照本身：

```bash
jq -e '.cleanShutdown == true and .verified == true' "$snapshot_root/SNAPSHOT.json"
(
  cd "$snapshot_root/state"
  sha256sum -c --quiet "$snapshot_root/STATE-SHA256SUMS"
)
find "$snapshot_root/state/users" -name '*.sqlite' -type f -print0 \
  | while IFS= read -r -d '' db; do
      test "$(sqlite3 -readonly "$db" 'pragma integrity_check;')" = ok
    done
```

把快照恢复到隔离目录，绝不覆盖生产：

```bash
restore_root="$(mktemp -d /srv/aialra/state/codexapp-b-restore-check.XXXXXXXX)"
ionice -c3 nice -n 15 rsync -aHAXx --numeric-ids "$snapshot_root/state/" "$restore_root/"
(
  cd "$restore_root"
  sha256sum -c --quiet "$snapshot_root/STATE-SHA256SUMS"
)
```

在隔离副本中，用 26.803 和 26.810 CLI 各执行一次 `thread/list`、`thread/read`、只读 `thread/resume`，并核对：thread ID、cwd、turn 数、rollout SHA-256、最后一条正文哨兵完全一致。任何一个不一致，都禁止 B1/B2 切换。

## 4. 确认只保留 Trillium Note

只有在第 3 步快照完成且四个 Trillium 标识唯一后，才允许使用现有保留脚本。

先 check-only：

```bash
CODEXAPP_RETENTION_CHECK_ONLY=1 \
  "$repo/ops/retain-single-thread-project.sh" \
  "$b_user_key" \
  "$trillium_thread_id" \
  "$trillium_project_id" \
  "$trillium_project_basename" \
  "$validated_backup_id"
```

这里的 `validated_backup_id` 必须来自已经标记为 `consistent-service-stopped` 且通过 SQLite、session SHA-256 和文件一致性验证的既有 `codexapp-ab` 快照。若没有这种快照，不执行清理；先补同格式的验证备份。

审计产生的 `synthetic_user_key` 只有在 root 盘点确认完全为空后，才能移动到同一次维护备份的 `removed/`，不能直接 `rm -rf`。

## 5. 只发布 B1

若 `/tmp` 中 B1 worktree 不在，按提交重建：

```bash
if [[ ! -d "$b1_source/.git" && ! -f "$b1_source/.git" ]]; then
  b1_source="$(mktemp -d /tmp/codexapp-b1-ef5d3ae.XXXXXXXX)"
  rmdir "$b1_source"
  git -C "$repo" worktree add --detach "$b1_source" ef5d3ae
  ionice -c3 nice -n 15 npm --prefix "$b1_source" ci --include=dev
fi
```

构建不可变 release，只 stage：

```bash
QUALIFIED_OFFICIAL_SOURCE_ROOT="$official_26803" \
  ionice -c3 nice -n 15 \
  "$b1_source/ops/install-release.sh" "$b1_release" "$b1_source" --stage
```

安装 B 专用 systemd/resource/secret-group 配置，不会重启服务：

```bash
APPLICATION_ROOT="/srv/aialra/releases/codexapp-official-web-host/$b1_release" \
  "/srv/aialra/releases/codexapp-official-web-host/$b1_release/ops/install-host-service.sh"
```

再次跑第 1 步门槛，然后切 B1：

```bash
"/srv/aialra/releases/codexapp-official-web-host/$b1_release/ops/promote-release.sh" \
  "$b1_release"
```

发布脚本会锁住并发发布，重新等待五分钟 A/资源门槛，拒绝 B 后台任务，制作生产状态快照，原子切换并连续检查 B；失败时恢复代码、环境和状态。

## 6. B1 真实验收

B1 不通过，B2 不开始。

必须在 Authentik 后完成以下路径，每项至少冷/热各 3 次：

1. 登录 → logo → 外壳 → 项目 → Trillium 标题 → 最新正文 → spinner 消失。
2. 发送普通消息；确认 1 秒内收到接受反馈，回复流式出现，完成后刷新仍在。
3. 打开 Trillium 时并发发送；不得回到第一条、白屏、重复或丢失。
4. 新建、分支、改名、归档、恢复、删除；连续刷新后数量和状态一致。
5. en-US、zh-CN、zh-TW、ja-JP、fr-FR；检查实际文本，不只检查 locale 值，并验证刷新和新会话保持。
6. 关闭页面和断网，让任务在服务器完成；重新连接后事件无 gap/duplicate，正文完整。
7. 每个必需 Skill、MCP、App、Plugin：发现、OAuth/权限、真实低风险读取调用、重连和服务重启后再调用。
8. Terminal、Git、worktree、附件上传/下载、浏览器、审批允许和拒绝。

同时记录：

```bash
systemctl show codexapp-official-web-host.service \
  -p MemoryCurrent -p MemoryPeak -p MemorySwapCurrent -p NRestarts
cat /sys/fs/cgroup/system.slice/codexapp-official-web-host.service/memory.events
cat /proc/pressure/memory
cat /proc/pressure/io
curl -fsS http://127.0.0.1:13024/readyz
```

门槛：普通发送接受 p95 ≤ 1 秒；普通热对话正文 p95 ≤ 3 秒；Trillium 热正文 ≤ 15 秒、冷正文 ≤ 60 秒；B `memory.events max` 无增量；A 无重启和明显延迟恶化。

## 7. 安装并发布 B2

只有 B1 完整通过并再次做一份生产快照后继续。

先安装官方签名 pair；只 stage，不切服务：

```bash
APPLICATION_ROOT="$repo" \
  ionice -c3 nice -n 15 \
  "$repo/ops/install-qualified-linux-pair.sh" "$official_deb"
```

再构建 B2 release：

```bash
QUALIFIED_OFFICIAL_SOURCE_ROOT=/srv/aialra/codexapp-official/releases/26.810.41047/source \
  ionice -c3 nice -n 15 \
  "$repo/ops/install-release.sh" "$b2_release" "$b2_source" --stage
```

不要重新安装或重启共享依赖。第 1 步门槛再次通过后切 B2：

```bash
"/srv/aialra/releases/codexapp-official-web-host/$b2_release/ops/promote-release.sh" \
  "$b2_release"
```

完整重复第 6 步。B2 任一核心 p95 比 B1 恶化超过 20%，也不晋级。

## 8. 回滚

仅代码不对，状态没被写：

```bash
"/srv/aialra/apps/codexapp-official-web-host/current/ops/rollback-release.sh" \
  "$previous_release_id"
```

状态已被候选写入或旧 CLI 无法读取：停止 B，使用发布输出中的 `snapshot` 路径恢复代码、环境和状态；再启动 B 并连续检查健康。不要只切 symlink。

任何回滚都不操作 A，不重启共享 Xvfb/WARP/出口代理。

## 9. 最终收口

只有 B2 全矩阵通过后：

- 运行 B 专用密钥轮换；该脚本只重启 B，并对 Nginx 做 graceful reload。
- 核对 A 服务账号已无法读取 B session/proxy secret。
- 保留 B1、B2、两次切换前快照、测试证据和指标基线。
- 删除测试对话必须走可恢复移动，不直接递归删除。
- GitHub 只推送脱敏代码、文档和真实界面截图；禁止提交环境文件、密钥、token、auth.json、用户 state 和原始对话正文。
