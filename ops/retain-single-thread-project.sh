#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

user_key="${1:-}"
thread_id="${2:-}"
project_id="${3:-}"
project_basename="${4:-}"
backup_id="${5:-}"

runtime_root="/srv/aialra/state/codexapp-official"
service_name="codexapp-official-web-host.service"
background_url="http://127.0.0.1:13014/ops/background-work"
backup_root="/srv/aialra/backups/codexapp-ab"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "run as root" >&2
  exit 77
fi
if [[ ! "$user_key" =~ ^[0-9a-f]{64}$ ]] ||
  [[ ! "$thread_id" =~ ^[0-9a-f-]{36}$ ]] ||
  [[ ! "$project_id" =~ ^[0-9a-f-]{36}$ ]] ||
  [[ ! "$project_basename" =~ ^[0-9A-Za-z._-]+$ ]] ||
  [[ ! "$backup_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
  echo "invalid retention arguments" >&2
  exit 64
fi

user_root="$runtime_root/users/$user_key"
codex_home="$user_root/codex-home"
database="$codex_home/state_5.sqlite"
host_state="$user_root/host-state.json"
snapshot_root="$backup_root/$backup_id/snapshot/$user_key"
backup_info="$backup_root/$backup_id/BACKUP_INFO"

for required in "$user_root" "$codex_home" "$database" "$host_state" \
  "$snapshot_root" "$backup_info"; do
  if [[ ! -e "$required" || -L "$required" ]]; then
    echo "required path is missing or symbolic: $required" >&2
    exit 66
  fi
done
if ! grep -Fxq 'status=consistent-service-stopped' "$backup_info" ||
  ! grep -Fxq 'validation=sqlite-ok-session-sha256-file-content-identical' "$backup_info"; then
  echo "the selected backup is not the validated stopped-service snapshot" >&2
  exit 65
fi

thread_count="$(sqlite3 "$database" \
  "select count(*) from threads where id='$thread_id';")"
if [[ "$thread_count" != "1" ]]; then
  echo "the retained thread is not unique in the live database" >&2
  exit 65
fi
rollout_path="$(sqlite3 "$database" \
  "select rollout_path from threads where id='$thread_id';")"
rollout_path="$(realpath -e -- "$rollout_path")"
sessions_root="$(realpath -e -- "$codex_home/sessions")"
if [[ "$rollout_path" != "$sessions_root"/* ]] ||
  [[ "$(basename -- "$rollout_path")" != *"$thread_id"*.jsonl ]]; then
  echo "the retained rollout escapes the user's sessions directory" >&2
  exit 65
fi
rollout_relative="${rollout_path#"$user_root/"}"
snapshot_rollout="$snapshot_root/$rollout_relative"
if [[ ! -f "$snapshot_rollout" || -L "$snapshot_rollout" ]] ||
  ! cmp -s -- "$rollout_path" "$snapshot_rollout"; then
  echo "the retained rollout does not exactly match the validated backup" >&2
  exit 65
fi
retained_rollout_sha256="$(sha256sum "$rollout_path" | cut -d' ' -f1)"

project_root="$(jq -er \
  --arg project "$project_id" \
  '.globalState["local-projects"][$project].rootPaths
   | select(type == "array" and length == 1)
   | .[0]' \
  "$host_state")"
project_root="$(realpath -e -- "$project_root")"
projects_root="$(realpath -e -- "$user_root/workspace/projects")"
if [[ "$project_root" != "$projects_root/$project_basename" ]] ||
  [[ ! -d "$project_root" || -L "$project_root" ]]; then
  echo "the retained project path is not the exact expected project" >&2
  exit 65
fi
jq -e \
  --arg thread "$thread_id" \
  --arg project "$project_id" \
  '.globalState["thread-project-assignments"][$thread].projectId == $project' \
  "$host_state" >/dev/null

if ! systemctl is-active --quiet "$service_name"; then
  echo "the B service must be healthy before maintenance" >&2
  exit 69
fi
background_snapshot="$(curl -fsS --max-time 5 "$background_url")"
if ! jq -e '.ok == true and .active == false' <<<"$background_snapshot" >/dev/null; then
  echo "B has active background work; retention refused" >&2
  exit 75
fi
if [[ "${CODEXAPP_RETENTION_CHECK_ONLY:-0}" == "1" ]]; then
  printf '{"ok":true,"checkOnly":true,"threadId":"%s","projectId":"%s","rolloutSha256":"%s"}\n' \
    "$thread_id" "$project_id" "$retained_rollout_sha256"
  exit 0
fi

maintenance_id="$(date -u +%Y%m%dT%H%M%SZ)-b-retain-${thread_id}"
maintenance_root="$backup_root/$maintenance_id"
mkdir -p "$maintenance_root/control" "$maintenance_root/removed"
chmod 0700 "$maintenance_root" "$maintenance_root/control" "$maintenance_root/removed"
cp -a -- "$database" "$host_state" "$user_root/host-state.json.bak" \
  "$maintenance_root/control/"
if [[ -f "$codex_home/session_index.jsonl" ]]; then
  cp -a -- "$codex_home/session_index.jsonl" "$maintenance_root/control/"
fi
printf '%s\n' \
  "backup_id=$backup_id" \
  "user_key=$user_key" \
  "thread_id=$thread_id" \
  "project_id=$project_id" \
  "rollout_relative=$rollout_relative" \
  "rollout_sha256=$retained_rollout_sha256" \
  "project_root=$project_root" >"$maintenance_root/RETENTION_INFO"

systemctl stop "$service_name"
if systemctl is-active --quiet "$service_name"; then
  echo "B did not stop cleanly" >&2
  exit 70
fi

move_out() {
  local source="$1"
  local relative
  [[ -e "$source" || -L "$source" ]] || return 0
  if [[ "$source" != "$user_root"/* ]]; then
    echo "refusing to move a path outside the user root: $source" >&2
    exit 65
  fi
  relative="${source#"$user_root/"}"
  mkdir -p "$maintenance_root/removed/$(dirname -- "$relative")"
  mv -- "$source" "$maintenance_root/removed/$relative"
}

while IFS= read -r -d '' candidate; do
  candidate="$(realpath -e -- "$candidate")"
  [[ "$candidate" == "$rollout_path" ]] && continue
  move_out "$candidate"
done < <(find "$codex_home/sessions" -type f -name 'rollout-*.jsonl' -print0)

while IFS= read -r -d '' candidate; do
  candidate="$(realpath -e -- "$candidate")"
  [[ "$candidate" == "$project_root" ]] && continue
  move_out "$candidate"
done < <(find "$projects_root" -mindepth 1 -maxdepth 1 -type d -print0)
move_out "$user_root/workspace/codexapp"
move_out "$user_root/private/migration"
move_out "$user_root/uploads"
move_out "$user_root/tmp"
move_out "$codex_home/shell_snapshots"

for database_name in goals_1.sqlite logs_2.sqlite memories_1.sqlite; do
  move_out "$codex_home/$database_name"
  move_out "$codex_home/$database_name-wal"
  move_out "$codex_home/$database_name-shm"
done
move_out "$codex_home/sqlite/codex.db"
move_out "$codex_home/sqlite/codex.db-wal"
move_out "$codex_home/sqlite/codex.db-shm"

sqlite3 "$database" <<SQL
PRAGMA foreign_keys=ON;
BEGIN IMMEDIATE;
DELETE FROM thread_dynamic_tools WHERE thread_id <> '$thread_id';
DELETE FROM thread_spawn_edges
 WHERE parent_thread_id <> '$thread_id' OR child_thread_id <> '$thread_id';
DELETE FROM threads WHERE id <> '$thread_id';
UPDATE threads SET cwd = '$project_root' WHERE id = '$thread_id';
DELETE FROM thread_sections
 WHERE id NOT IN (
   SELECT thread_section_id FROM threads WHERE thread_section_id IS NOT NULL
 );
COMMIT;
PRAGMA wal_checkpoint(TRUNCATE);
VACUUM;
PRAGMA integrity_check;
SQL

filtered_state="$maintenance_root/control/host-state.filtered.json"
jq \
  --arg thread "$thread_id" \
  --arg project "$project_id" \
  --arg project_root "$project_root" \
  '
    .globalState["local-projects"] |= with_entries(select(.key == $project))
    | .globalState["project-order"] = [$project]
    | .globalState["pinned-project-ids"] |= ((. // []) | map(select(. == $project)))
    | .globalState["project-appearances"] |= ((. // {}) | with_entries(select(.key == $project)))
    | .globalState["selected-project"] = {type: "local", projectId: $project}
    | .globalState["thread-project-assignments"] |= with_entries(select(.key == $thread))
    | .globalState["thread-workspace-root-hints"] |= ((. // {}) | with_entries(select(.key == $thread)))
    | .globalState["thread-project-assignments"][$thread].cwd = $project_root
    | .globalState["thread-workspace-root-hints"][$thread] = $project_root
    | .globalState["projectless-thread-ids"] |= ((. // []) | map(select(. == $thread)))
    | .globalState["pinned-thread-ids"] |= ((. // []) | map(select(. == $thread)))
    | .globalState["thread-projectless-output-directories"] |= ((. // {}) | with_entries(select(.key == $thread)))
    | .globalState["sidebar-thread-metadata"] |= ((. // {}) | with_entries(select(.key == $thread)))
    | .globalState["sidebar-project-thread-orders"] |= ((. // {}) | with_entries(select(.key == $project)))
    | del(.globalState["__browser-host-official-thread-catalog-v1"])
    | del(.globalState["__browser-host-official-thread-catalog-v2"])
    | .persistedAtoms |= with_entries(
        select(
          ((.key | test("^(thread-client-id-v1:|codex-writing-block-deleted-thread-v1:|thread-reference-capability:|sites-feedback-tags-v1:|sidebar-project-expanded-v1-codex:)") | not)
           or (.key | contains($thread))
           or (.key | contains($project)))
        )
      )
    | del(.persistedAtoms["composer-prompt-drafts-v1"])
    | del(.persistedAtoms["prompt-history"])
    | del(.persistedAtoms["unread-thread-ids-by-host-v1"])
    | .persistedAtoms["thread-descriptions-v1"] |= ((. // {}) | with_entries(select(.key | contains($thread))))
    | .persistedAtoms["heartbeat-thread-permissions-by-id"] |= ((. // {}) | with_entries(select(.key | contains($thread))))
    | .persistedAtoms["unified-sidebar-project-order-v1"] = [$project]
    | del(.sharedObjects["tray_menu_threads"])
  ' \
  "$host_state" >"$filtered_state"
jq -e \
  --arg thread "$thread_id" \
  --arg project "$project_id" \
  --arg project_root "$project_root" \
  '(.globalState["local-projects"] | keys) == [$project]
   and (.globalState["thread-project-assignments"] | keys) == [$thread]
   and .globalState["thread-project-assignments"][$thread].projectId == $project
   and .globalState["thread-project-assignments"][$thread].cwd == $project_root
   and .globalState["thread-workspace-root-hints"][$thread] == $project_root' \
  "$filtered_state" >/dev/null
chown --reference="$host_state" "$filtered_state"
chmod --reference="$host_state" "$filtered_state"
mv -f -- "$filtered_state" "$host_state"
cp -a -- "$host_state" "$user_root/host-state.json.bak"

: >"$codex_home/session_index.jsonl"
chown codexappweb:codexappweb "$codex_home/session_index.jsonl"
chmod 0600 "$codex_home/session_index.jsonl"

if [[ "$(sqlite3 "$database" 'select count(*) from threads;')" != "1" ]] ||
  [[ "$(sqlite3 "$database" "select count(*) from threads where id='$thread_id';")" != "1" ]] ||
  [[ "$(sqlite3 "$database" "select cwd from threads where id='$thread_id';")" != "$project_root" ]] ||
  [[ "$(sqlite3 "$database" 'pragma integrity_check;')" != "ok" ]] ||
  [[ "$(find "$codex_home/sessions" -type f -name 'rollout-*.jsonl' | wc -l)" != "1" ]] ||
  [[ "$(find "$projects_root" -mindepth 1 -maxdepth 1 -type d | wc -l)" != "1" ]] ||
  [[ "$(sha256sum "$rollout_path" | cut -d' ' -f1)" != "$retained_rollout_sha256" ]] ||
  [[ "$(jq '.globalState["local-projects"] | length' "$host_state")" != "1" ]] ||
  [[ "$(jq '.globalState["thread-project-assignments"] | length' "$host_state")" != "1" ]]; then
  echo "post-retention validation failed; B remains stopped" >&2
  exit 1
fi

systemctl start "$service_name"
for _ in $(seq 1 90); do
  if systemctl is-active --quiet "$service_name" &&
    curl -fsS --max-time 3 http://127.0.0.1:13014/readyz >/dev/null; then
    break
  fi
  sleep 1
done
if ! systemctl is-active --quiet "$service_name" ||
  ! curl -fsS --max-time 3 http://127.0.0.1:13014/readyz >/dev/null; then
  journalctl -u "$service_name" --no-pager -n 120 >&2 || true
  echo "B did not return healthy after retention" >&2
  exit 1
fi

printf '{"ok":true,"threadId":"%s","projectId":"%s","rolloutSha256":"%s","maintenanceRoot":"%s"}\n' \
  "$thread_id" "$project_id" "$retained_rollout_sha256" "$maintenance_root"
