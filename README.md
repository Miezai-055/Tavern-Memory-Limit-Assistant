# 聊天内存限制助手 (Chat Memory Window)

为 SillyTavern 长聊天提供**可选的真实内存窗口**：浏览器只加载最近 N 条消息，窗口外楼层变成轻量占位符。

- 绝对楼层号继续正常增长，依赖楼层号的插件不会错乱
- 完整历史始终保留在磁盘，窗口保存只提交真实尾部消息
- 为数据库 V2 回放保留必要锚点，避免 `boundary_after_data_mismatch`

适合世界书 / 角色卡 / 聊天记录很大、编辑消息或切换聊天时明显卡顿的场景。

---

## 它是怎么工作的

本扩展由**两部分**组成，缺一不可：

| 部分 | 安装位置 | 作用 |
| --- | --- | --- |
| 前端扩展 | `public/scripts/extensions/third-party/chat-memory-window/` | 劫持 `fetch`、裁剪浏览器内存、提供设置面板 |
| 服务端插件 | `plugins/chat-memory-window/` | 只读尾部、合并保存、维护全历史快照 |

转发链路：

1. 加载聊天时，`/api/chats/get` 被转发到 `/api/plugins/chat-memory-window/chat/get?window_size=N`，
   服务端流式扫描聊天文件，**只把最近 N 条真实消息**返回浏览器。
2. 窗口外的楼层被替换成 `is_system: true` 的轻量占位符，保留原始 `is_user` 角色，
   因此绝对楼层号和 AI 楼层统计不受影响。
3. 保存时，`/api/chats/save` 被转发到 `/chat/save?windowed=1&window_start=…&base_total=…`，
   服务端从**全历史快照**读出前缀，与浏览器上传的尾部合并后原子写入。

数据安全防线（均在服务端实现）：

- 首次读取时创建 `<chat>.jsonl.chat-memory-window.full` 全历史快照，之后一切读写都基于它；
- `base_total` 与磁盘不一致时返回 `409`，拒绝覆盖；
- `window_start=0` 且磁盘历史更长时直接拒绝（防止窗口尾部覆盖完整历史）；
- 窗口聊天一旦加载成功，桥接失败会**阻止保存**，而不是退回原生保存。

---

## 安装

> **为什么不能像「酒馆助手」那样一个 URL 装完？**
>
> 酒馆助手（JS-Slash-Runner）是**纯前端**扩展，酒馆的「Install extension」把它克隆到
> `third-party/` 就够了。本扩展还带一个**服务端插件**，而酒馆官方**没有为 `plugins/` 目录提供
> 任何 URL 安装入口** —— 已在 SillyTavern 1.18.0 源码中确认：`src/endpoints/` 下只有
> `extensions.js`（克隆到 `third-party/`），没有对应的 `plugins.js`。
>
> 所以安装分两步：**前端一个 URL，服务端一条命令**。两端装好后都能被酒馆自动更新
> （前端靠 `manifest.json` 的 `auto_update`，服务端靠 `enableServerPluginsAutoUpdate`）。

### 前提

- SillyTavern `1.11.1` 或更高（服务端插件 API 自该版本引入）
- `config.yaml` 中需要：

```yaml
enableServerPlugins: true
```

### 第一步：安装前端扩展（Git URL）

酒馆 → **Extensions** → **Install extension** → 粘贴：

```text
https://github.com/liuyuanjianlyj-crypto/chat-memory-window
```

安装后扩展会出现在扩展列表里，显示名为「聊天内存限制助手」。

### 第二步：安装服务端插件

前端扩展已刷新酒馆界面，但服务端插件需要放到酒馆根目录的 `plugins/` 下。

如果前端扩展已经从上面的 URL 装好了，**最省事的一条命令**是把它复制过去（无需重新下载）：

```bash
# Linux / macOS / Android Termux，在酒馆根目录执行
cp -r public/scripts/extensions/third-party/chat-memory-window plugins/chat-memory-window
```

也可以重新克隆一份，这样以后能跟着 `git pull` 自动更新：

**Windows（PowerShell / CMD，在酒馆根目录执行）：**

```powershell
git clone https://github.com/liuyuanjianlyj-crypto/chat-memory-window.git plugins/chat-memory-window
```

**Linux / macOS / Android Termux（在酒馆根目录执行）：**

```bash
git clone https://github.com/liuyuanjianlyj-crypto/chat-memory-window.git plugins/chat-memory-window
```

也可以直接运行本仓库附带的安装脚本，它会自动定位酒馆目录并把插件放好：

```bash
bash install-plugin.sh /path/to/SillyTavern
```

```powershell
powershell -ExecutionPolicy Bypass -File install-plugin.ps1 -SillyTavern "D:\path\to\SillyTavern"
```

> 路径参数可省略：脚本会在常见位置（含 Termux 的 `~/SillyTavern`）自动探测酒馆根目录。

### 第三步：重启酒馆

服务端插件**只在启动时加载**。安装或更新后必须完全重启酒馆，然后浏览器按 `Ctrl + Shift + R` 强制刷新。

---

## 使用

1. 打开一个具体聊天（未进入聊天时无法启用，这是有意的保护）。
2. 打开扩展设置，展开「聊天内存限制助手」，勾选 **启用真实内存窗口**。
3. 填写 **浏览器加载最近消息数**（推荐 `20`）。
4. 点击 **重新加载当前聊天**。

`20` 表示最近 **20 条消息**，不是 20 个完整回合。

扩展面板底部会显示当前状态，例如：

```text
状态：已启用；磁盘总消息 1204，浏览器窗口 20 条（索引 1184-1203）
```

### 关闭扩展

取消勾选后会重新载入完整聊天，之后酒馆恢复使用原生加载与保存。关闭是安全的，不会留下占位符。

---

## 手机端（Android / Termux）

手机端酒馆只要满足**前提条件**（完整 Node.js 后端 + 可安装服务端插件），本扩展同样可用，步骤与桌面一致：

```bash
# 1. 开启服务端插件
nano ~/SillyTavern/config.yaml     # 把 enableServerPlugins 改为 true

# 2. 安装服务端插件
cd ~/SillyTavern
git clone https://github.com/liuyuanjianlyj-crypto/chat-memory-window.git plugins/chat-memory-window

# 3. 完全重启酒馆
```

前端扩展走酒馆界面的 **Install extension**，或直接放进
`~/SillyTavern/public/scripts/extensions/third-party/chat-memory-window/`。

需要注意：

- 如果手机端酒馆**只提供浏览器前端、后端跑在别处**，那么服务端插件要装在后端那台机器上；
- 某些手机端打包版本可能未启用服务端插件，或 `plugins/` 目录不可写 —— 这种情况只能使用前端部分，
  内存窗口不会生效（此时扩展会明确提示「未找到服务端插件」，不会破坏任何数据）；
- 手机端浏览器同样支持本扩展依赖的 `fetch` 劫持与 `Request`/`Response` 重建，无需特殊处理。

### 手机端可用性检查清单

装完后按顺序确认这几点，任一条不满足就说明手机端环境不支持服务端插件：

```bash
# a. 后端必须是完整 Node.js 运行环境（不是纯浏览器壳）
cd ~/SillyTavern && node -v          # 应输出 v18 或更高

# b. 服务端插件开关必须打开
grep -n 'enableServerPlugins' ~/SillyTavern/config.yaml   # 应为 true

# c. 插件文件确实就位
ls ~/SillyTavern/plugins/chat-memory-window/index.mjs

# d. 完全重启后，日志里应出现这一行
#    [chat-memory-window] Server plugin 1.3.0 loaded.
```

浏览器端（手机浏览器打开酒馆）确认：

1. 扩展列表里能看到「聊天内存限制助手」；
2. 展开面板后状态栏不显示「未找到服务端插件」；
3. 启用 + 点击「重新加载当前聊天」后，状态栏显示 `磁盘总消息 N，浏览器窗口 M 条`。

> 移动端说明：本扩展依赖的都是跨平台能力（`fetch` 劫持、`Request`/`Response` 重建、Node 标准库流式读文件），
> 没有任何桌面专属依赖；服务端用到的两个 npm 包是纯 JavaScript，不含原生模块，因此在 ARM64 / Android 上无需编译工具链。

---

## 兼容性

- 窗口外的楼层保留**原始 AI / 用户角色**并使用 `is_system` 占位，不影响依赖绝对楼层号或 AI 楼层统计的插件。
- 窗口外消息的正文与 `variables` 不会进入浏览器内存。
- 数据库 V2 仅保留回放所需的 checkpoint / log 元数据，避免丢失数据库锚点。
- 需要窗口外旧消息**完整正文**的脚本，请自行按需读取聊天文件。

### 已知限制

- 服务端插件没有沙箱，请只从可信来源安装。
- 前端扩展与酒馆的 `cocktail-plus` 等同样包装 `fetch` 的扩展可以共存（本扩展会重建 `Request`，避免流被占用）。

---

## 卸载

1. 取消勾选扩展，或直接在扩展列表里删除扩展。
2. 删除酒馆根目录下的 `plugins/chat-memory-window/`。
3. 可选：删除聊天目录下遗留的 `*.chat-memory-window.full` 快照文件（不删也不影响正常使用）。

---

## 目录结构

目录结构：

```text
chat-memory-window/
├── manifest.json        # 前端扩展清单
├── index.js             # 前端扩展入口（fetch 桥接 + 内存裁剪 + UI）
├── style.css            # 设置面板样式
├── index.mjs            # 服务端插件入口（读取窗口 + 合并保存）
├── version.json         # 服务端插件版本信息
├── package.json         # 服务端插件入口声明（main: index.mjs）
├── install-plugin.sh    # 可选的 Linux/macOS/Termux 一键安装脚本
└── install-plugin.ps1   # 可选的 Windows 一键安装脚本
```

同一个仓库根目录**同时**是合法的酒馆扩展和合法的服务端插件：

- 装到 `third-party/chat-memory-window/` 时，`index.js` 的相对导入指向 `public/script.js`；
- 装到 `plugins/chat-memory-window/` 时，`index.mjs` 的相对导入指向 `src/util.js`。

因此两条安装路径可以共用同一个 Git URL。
