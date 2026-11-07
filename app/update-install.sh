#!/bin/sh
# 固定安装流程；所有路径通过位置参数传入，不解析或执行请求中的代码。
# @CfSecAICode 遵循消费金融安全编码 BE-EXEC-001 规范: 不使用 sh -c/eval，路径始终加引号，命令使用系统绝对路径。
set -u
[ "$#" -eq 10 ] || exit 2
target=$1
staged=$2
backup=$3
oldpid=$4
version=$5
token=$6
job=$7
userdata=$8
previous=$9
timeout=${10}
case "$oldpid:$timeout" in *[!0-9:]*|:*|*:) exit 2;; esac
[ "$timeout" -ge 1 ] && [ "$timeout" -le 120 ] || exit 2
case "$token" in *[!a-f0-9-]*|'') exit 2;; esac
[ "${#token}" -eq 36 ] || exit 2
parent=${target%/*}
case "$target" in /*/小蝌蚪点读制作.app|/*/Electron.app) ;; *) exit 2;; esac
[ "$staged" = "$parent/.rpm-update-$token.app" ] && [ "$backup" = "$parent/.rpm-backup-$token.app" ] || exit 2
[ "$job" = "$userdata/updates/$token" ] || exit 2
[ -d "$target" ] && [ ! -L "$target" ] && [ -d "$staged" ] && [ ! -e "$backup" ] || exit 2
executable() {
  program=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$target/Contents/Info.plist") || return 1
  case "$program" in 小蝌蚪点读制作|Electron) /usr/bin/printf '%s\n' "$target/Contents/MacOS/$program";; *) return 1;; esac
}
moved=0
installed=0
newpid=''
result() { /usr/bin/printf '%s\n' "$1" > "$job/result.partial" && /bin/mv "$job/result.partial" "$job/result.txt"; }
rollback() {
  trap - HUP INT TERM
  if [ -n "$newpid" ]; then
    kill "$newpid" 2>/dev/null || true
    count=0
    while kill -0 "$newpid" 2>/dev/null && [ "$count" -lt 40 ]; do /bin/sleep 0.2; count=$((count + 1)); done
    kill -KILL "$newpid" 2>/dev/null || true
    wait "$newpid" 2>/dev/null || true
  fi
  if [ "$installed" -eq 1 ]; then /bin/mv "$target" "$staged" || { result 'failed:新版退出，但无法移走新版，请手动恢复备份'; exit 1; }; fi
  if [ "$moved" -eq 1 ]; then /bin/mv "$backup" "$target" || { result 'failed:旧版备份保留，请手动恢复'; exit 1; }; fi
  result 'failed:新版未能启动，已恢复旧版，书籍和音频未改动'
  if [ "$moved" -eq 1 ]; then
    /bin/rm -rf "$staged" "$job/extracted"
    launch=$(executable) || exit 1
    "$launch" "--user-data-dir=$userdata" > "$job/rollback-startup.log" 2>&1 &
    /usr/bin/printf '%s\n' "$!" > "$job/rollback-pid.txt"
  fi
  exit 1
}
trap rollback HUP INT TERM
count=0
while kill -0 "$oldpid" 2>/dev/null; do
  if [ "$count" -ge 300 ]; then result 'failed:旧版没有退出，本次未安装'; exit 1; fi
  /bin/sleep 0.2; count=$((count + 1))
done
/bin/mv "$target" "$backup" || { result 'failed:无法备份旧版，本次未安装'; exit 1; }
moved=1
/bin/mv "$staged" "$target" || rollback
installed=1
launch=$(executable) || rollback
"$launch" "--user-data-dir=$userdata" "--rpm-update-job=$job" "--rpm-update-token=$token" > "$job/startup.log" 2>&1 &
newpid=$!
count=0
while [ "$count" -lt "$((timeout * 5))" ]; do
  if [ -f "$job/started.txt" ]; then
    ack=''; IFS= read -r ack < "$job/started.txt" || true
    if [ "$ack" = "$version:$newpid:$token" ]; then
      result "installed:$version" || rollback
      # @CfSecAICode 遵循消费金融安全编码 BE-FILE-002 规范: 只清理本次生成的、已验证名称的旧 App 备份，不触碰用户资料库。
      /bin/rm -rf "$backup"
      /bin/rm -rf "$job/extracted"
      /bin/rm -f "$job/update.zip"
      exit 0
    fi
  fi
  kill -0 "$newpid" 2>/dev/null || rollback
  /bin/sleep 0.2; count=$((count + 1))
done
rollback
