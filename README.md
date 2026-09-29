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

本扩展由**两部分**组成，两部分都要装，缺一不可：

| 部分 | 必须安装到 | 包含的文件 |
| --- | --- | --- |
| 前端扩展 | `<酒馆根目录>/public/scripts/extensions/third-party/chat-memory-window/` | `manifest.json`、`index.js`、`style.css` |
| 服务端插件 | `<酒馆根目录>/plugins/chat-memory-window/` | `index.mjs`、`package.json`、`version.json` |

> 下文的 **酒馆根目录**，指的是里面有 `server.js`、`config.yaml`、`public/`、`plugins/` 的那个目录。
> 例如 Windows 上的 `D:\SillyTavern`，Termux 上的 `~/SillyTavern`。

安装一共四步：改开关 → 装前端 → 装服务端 → 重启。全程只需要做一次。

---

### 第一步：打开服务端插件开关

用文本编辑器打开酒馆根目录下的 `config.yaml`，找到这一行：

```yaml
enableServerPlugins: false
```

改成：

```yaml
enableServerPlugins: true
```

如果文件里**根本没有** `enableServerPlugins` 这一行，就在任意一个顶层位置（行首不缩进）自己加上：

```yaml
enableServerPlugins: true
```

> 这一步不做，服务端插件不会被加载，扩展启用后只会提示「未找到服务端插件」，不会生效。
>
> 如果用第三步的**安装脚本**，脚本会自动帮你改好这一行（原文件会备份成 `config.yaml.bak-chat-memory-window`），可以跳过本步。

---

### 第二步：安装前端扩展

打开酒馆网页界面 → 顶部 **Extensions（扩展）** 面板 → 找到 **Install extension** 输入框 → 粘贴下面的地址 → 确认安装：

```text
https://github.com/liuyuanjianlyj-crypto/chat-memory-window
```

装好后扩展列表里会出现「聊天内存限制助手」。

<details>
<summary>界面装不了时的手动安装方式</summary>

在酒馆根目录执行：

```bash
git clone https://github.com/liuyuanjianlyj-crypto/chat-memory-window.git public/scripts/extensions/third-party/chat-memory-window
```

装完确认文件存在：

```text
<酒馆根目录>/public/scripts/extensions/third-party/chat-memory-window/manifest.json
```

</details>

---

### 第三步：安装服务端插件

打开酒馆的**扩展面板**，如果看到「还差最后一步：安装服务端插件」，说明服务端插件还没装。

**方法一（推荐）：点面板上的「一键复制安装命令」按钮**，然后：

1. 打开酒馆根目录的终端（Windows 用 PowerShell 或 CMD，手机用 Termux）
2. 粘贴并回车

命令本身是这一条（`plugins.js` 是酒馆自带的官方插件安装工具）：

```bash
node plugins.js install https://github.com/liuyuanjianlyj-crypto/chat-memory-window.git
```

**方法二：复制文件夹**（完全不用命令行）

把 `<酒馆根目录>/public/scripts/extensions/third-party/chat-memory-window` 整个文件夹，
复制到 `<酒馆根目录>/plugins/` 下即可。

<details>
<summary>其他安装方式（安装脚本 / git clone）</summary>

**安装脚本** —— 脚本就在前端扩展目录里，它会**把本地的前端扩展复制到 `plugins/`**（不需要联网），
并**自动打开 `enableServerPlugins`**：

```bash
# Linux / macOS / Android Termux
bash install-plugin.sh "<酒馆根目录>"
```

```powershell
# Windows，也可以直接双击同目录的 install-plugin.bat
powershell -ExecutionPolicy Bypass -File install-plugin.ps1 -SillyTavern "<酒馆根目录>"
```

酒馆根目录可以省略不写，脚本会自己探测。

**git clone** —— 在酒馆根目录执行：

```bash
git clone https://github.com/liuyuanjianlyj-crypto/chat-memory-window.git plugins/chat-memory-window
```

这样装出来的是独立 git 仓库，酒馆启动时会自动 `git pull` 更新它。

</details>

装完确认存在这个文件：

```text
<酒馆根目录>/plugins/chat-memory-window/index.mjs
```

---

### 第四步：完全重启酒馆

服务端插件**只在酒馆启动时加载**，所以必须把酒馆**完整关闭再重新启动**（关掉进程，不是刷新页面）。

重启后，在浏览器按 `Ctrl + Shift + R` 强制刷新一次，清掉旧的前端缓存。

启动日志里出现下面这一行，就说明服务端插件已经加载成功：

```text
[chat-memory-window] Server plugin 1.3.0 loaded.
```

如果没有这一行，按顺序检查：`config.yaml` 里的 `enableServerPlugins` 是不是 `true`、`plugins/chat-memory-window/index.mjs` 是否存在、酒馆是不是真的完整重启了。

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

手机端酒馆只要满足**前提条件**（完整 Node.js 后端 + 可写 `plugins/`），安装步骤和上面的四步完全一样，只是命令换成手机上的路径：

```bash
# 第一步：打开服务端插件开关
nano ~/SillyTavern/config.yaml     # 把 enableServerPlugins 改成 true

# 第二步：安装前端扩展（在酒馆界面 Extensions → Install extension 里粘贴仓库地址）

# 第三步：安装服务端插件
cd ~/SillyTavern
git clone https://github.com/liuyuanjianlyj-crypto/chat-memory-window.git plugins/chat-memory-window

# 第四步：完全重启酒馆
```

注意：

- 如果手机端酒馆**只提供浏览器前端、后端跑在别处**，那么服务端插件要装在后端那台机器上；
- 某些手机端打包版本可能没打开服务端插件开关，或 `plugins/` 目录不可写 —— 这种情况只能装前端部分，
  内存窗口不会生效（此时扩展会明确提示「未找到服务端插件」，不会破坏任何数据）。

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

## 发布到 GitHub（维护者）

如果你 fork 或改名了仓库，需要同步替换这几处 URL：

| 文件 | 位置 |
| --- | --- |
| `manifest.json` | `homePage` |
| `index.js` | `SERVER_INSTALL_COMMAND`（面板里展示给用户的命令） |
| `install-plugin.sh` | `REPO_URL` 默认值（可用环境变量 `CMW_REPO_URL` 覆盖） |
| `install-plugin.ps1` | `$RepoUrl` 默认值（可用环境变量 `CMW_REPO_URL` 覆盖） |
| `README.md` | 安装章节里的示例 URL |

推送后，别人在酒馆扩展面板输入仓库 URL 即可装好前端；服务端插件按上面的第三步处理。

> 仓库名会影响克隆后的文件夹名。本仓库按 `chat-memory-window` 命名，
> 与 `index.js` 里的 `EXTENSION_NAME`、`SERVER_PREFIX` 和服务端 `plugin id` 保持一致。
> 如果改了仓库名，扩展本身仍能工作（前端靠 manifest，服务端靠 package.json 的 `main`），
> 但建议同时统一 `SERVER_PREFIX` 与服务端 `info.id`，否则前后端桥接会找不到对方。

---

## 目录结构

```text
chat-memory-window/
├── manifest.json        # 前端扩展清单
├── index.js             # 前端扩展入口（fetch 桥接 + 内存裁剪 + UI）
├── style.css            # 设置面板样式
├── index.mjs            # 服务端插件入口（读取窗口 + 合并保存）
├── version.json         # 服务端插件版本信息
├── package.json         # 服务端插件入口声明（main: index.mjs）
├── install-plugin.sh    # 安装脚本：Linux/macOS/Termux
├── install-plugin.ps1   # 安装脚本：Windows（PowerShell）
└── install-plugin.bat   # 安装脚本：Windows（双击运行，内部调用上面的 ps1）
```

同一个仓库根目录**同时**是合法的酒馆扩展和合法的服务端插件：

- 装到 `third-party/chat-memory-window/` 时，`index.js` 的相对导入指向 `public/script.js`；
- 装到 `plugins/chat-memory-window/` 时，`index.mjs` 的相对导入指向 `src/util.js`。

因此两条安装路径可以共用同一个 Git URL。

> 安装脚本会把整个扩展目录（含服务端文件）复制进 `plugins/`，所以复制过去之后
> 酒馆的 `enableServerPluginsAutoUpdate` 就能把这个 git 仓库一起自动更新。
