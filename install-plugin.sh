#!/usr/bin/env bash
#
# 安装「聊天内存限制助手」的**服务端插件**部分。
#
# 优先做法：从已经装好的前端扩展目录直接复制（不需要联网，也不需要 git）。
# 备选做法：本地找不到前端扩展时，才从仓库地址克隆一份。
#
# 用法：
#   bash install-plugin.sh [酒馆根目录]
#
# 酒馆根目录可以省略，脚本会依次尝试：
#   1. 自身所在位置往上推算（扩展装在酒馆里时最准）
#   2. 当前目录、./SillyTavern、~/SillyTavern 等常见位置

set -euo pipefail

REPO_URL="${CMW_REPO_URL:-https://github.com/Miezai-055/Tavern-Memory-Limit-Assistant.git}"
PLUGIN_NAME="Tavern-Memory-Limit-Assistant"
FRONTEND_REL="public/scripts/extensions/third-party/Tavern-Memory-Limit-Assistant"

info() { printf '\033[36m[信息]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[警告]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[错误]\033[0m %s\n' "$*" >&2; exit 1; }

is_st_root() {
    [ -n "${1:-}" ] && [ -f "$1/server.js" ] && [ -f "$1/config.yaml" ]
}

find_st() {
    if [ -n "${1:-}" ]; then
        is_st_root "$1" || die "不是有效的酒馆根目录（缺少 server.js / config.yaml）：$1"
        printf '%s' "$1"
        return 0
    fi

    local self_root=''
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    self_root="$(cd "$script_dir/../../../../.." 2>/dev/null && pwd || true)"

    local candidate
    for candidate in \
        "$self_root" \
        "$PWD" \
        "$PWD/SillyTavern" \
        "$HOME/SillyTavern" \
        "$HOME/sillytavern" \
        "$HOME/SillyTavern-release" \
        "/opt/SillyTavern" \
        "/usr/local/SillyTavern"; do
        if is_st_root "$candidate"; then
            printf '%s' "$candidate"
            return 0
        fi
    done

    return 1
}

ST_ROOT="$(find_st "${1:-}")" || die "找不到酒馆目录。请显式指定：bash install-plugin.sh /path/to/SillyTavern"
ST_ROOT="$(cd "$ST_ROOT" && pwd)"
info "酒馆根目录：$ST_ROOT"

PLUGIN_DIR="$ST_ROOT/plugins/$PLUGIN_NAME"
FRONTEND_DIR="$ST_ROOT/$FRONTEND_REL"
mkdir -p "$ST_ROOT/plugins"

# ---- 第 1 步：把服务端插件放到 plugins/ ----
if [ -f "$FRONTEND_DIR/index.mjs" ]; then
    info "从已安装的前端扩展复制（无需联网）..."
    info "  来源：$FRONTEND_DIR"
    mkdir -p "$PLUGIN_DIR"
    cp -R "$FRONTEND_DIR/." "$PLUGIN_DIR/"
else
    warn "本地没找到前端扩展，改为从仓库克隆..."
    command -v git >/dev/null 2>&1 || die "需要 git，但 PATH 里找不到它。"
    if [ -d "$PLUGIN_DIR/.git" ]; then
        git -C "$PLUGIN_DIR" pull --ff-only
    else
        rm -rf "$PLUGIN_DIR"
        git clone --depth 1 "$REPO_URL" "$PLUGIN_DIR"
    fi
fi

[ -f "$PLUGIN_DIR/index.mjs" ] || die "安装不完整：缺少 $PLUGIN_DIR/index.mjs"
info "服务端插件已就位：$PLUGIN_DIR"

# ---- 第 2 步：打开 enableServerPlugins ----
CONFIG="$ST_ROOT/config.yaml"
if [ -f "$CONFIG" ]; then
    if grep -Eq '^enableServerPlugins:[[:space:]]*true[[:space:]]*$' "$CONFIG"; then
        info "config.yaml 里的 enableServerPlugins 已经是 true。"
    else
        cp "$CONFIG" "$CONFIG.bak-tavern-memory-limit-assistant"
        if grep -Eq '^[[:space:]]*enableServerPlugins:' "$CONFIG"; then
            awk '
                /^[[:space:]]*enableServerPlugins:[[:space:]]*/ { print "enableServerPlugins: true"; next }
                { print }
            ' "$CONFIG" > "$CONFIG.cmw-tmp" && mv "$CONFIG.cmw-tmp" "$CONFIG"
            info "已把 enableServerPlugins 改成 true（原文件备份为 config.yaml.bak-tavern-memory-limit-assistant）。"
        else
            printf '\nenableServerPlugins: true\n' >> "$CONFIG"
            info "已在 config.yaml 末尾补上 enableServerPlugins: true（原文件备份为 config.yaml.bak-tavern-memory-limit-assistant）。"
        fi
    fi
else
    warn "找不到 $CONFIG，请手动确认里面有 enableServerPlugins: true。"
fi

cat <<EOF

安装完成。

接下来：
  1. 完全关闭酒馆再重新启动（服务端插件只在启动时加载，刷新页面没用）。
  2. 浏览器按 Ctrl + Shift + R 强制刷新一次。
  3. 打开「聊天内存限制助手」面板，勾选启用，再点「重新加载当前聊天」。

启动日志里出现下面这一行，就说明服务端已经就绪：
  [tavern-memory-limit-assistant] Server plugin 1.4.0 loaded.
EOF
