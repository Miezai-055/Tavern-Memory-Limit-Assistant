# 聊天内存限制助手 (Tavern Memory Limit Assistant)

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
| 前端扩展 | `public/scripts/extensions/third-party/Tavern-Memory-Limit-Assistant/` | 劫持 `fetch`、裁剪浏览器内存、提供设置面板 |
| 服务端插件 | `plugins/Tavern-Memory-Limit-Assistant/` | 只读尾部、合并保存、维护全历史快照 |

转发链路：

1. 加载聊天时，`/api/chats/get` 被转发到 `/api/plugins/tavern-memory-limit-assistant/chat/get?window_size=N`（`tavern-memory-limit-assistant` 是插件的**内部 ID**，与仓库名无关），
   服务端流式扫描聊天文件，**只把最近 N 条真实消息**返回浏览器。
2. 窗口外的楼层被替换成 `is_system: true` 的轻量占位符，保留原始 `is_user` 角色，
   因此绝对楼层号和 AI 楼层统计不受影响。
3. 保存时，`/api/chats/save` 被转发到 `/chat/save?windowed=1&window_start=…&base_total=…`，
   服务端从**全历史快照**读出前缀，与浏览器上传的尾部合并后原子写入。

数据安全防线（均在服务端实现）：

- `<chat>.jsonl.tavern-memory-limit-assistant.full` 是可更新的全历史缓存；每次读取都会先检查真实聊天文件的大小和修改时间。插件关闭期间由酒馆原生保存产生的新内容会先同步进缓存，重新启用不会回到第一次启用时的旧版本；
- `base_total` 与磁盘不一致时返回 `409`，拒绝覆盖；
- 窗口外前缀缺失、或 `window_start=0` 却拿长聊天的尾部来保存时直接拒绝；
- 经过前缀校验后，重roll/删除导致的大范围合法截断不会被固定的“最多删除几条”阈值误拒绝；
- 窗口聊天一旦加载成功，桥接失败会**阻止保存**，而不是退回原生保存；关闭扩展时也会保持桥接到完整聊天重新载入完成。

---

## 安装

需要装**两部分**，一共四步，只做一次。

> 下文用 `<酒馆目录>` 表示酒馆的安装位置，也就是里面有 `server.js`、`config.yaml`、`public`、`plugins` 的那个文件夹。
> Windows 上一般是 `D:\SillyTavern` 这种；手机 Termux 上一般是 `~/SillyTavern`。

---

### 第 1 步：打开服务端插件开关

用记事本打开 `<酒馆目录>\config.yaml`，找到这一行：

```yaml
enableServerPlugins: false
```

把 `false` 改成 `true`，保存文件：

```yaml
enableServerPlugins: true
```

**如果整个文件里都找不到这一行**，就在文件**末尾另起一行**加上（顶格写，前面不要留空格）：

```yaml
enableServerPlugins: true
```

> 用第 3 步的**方式 A（双击脚本）**或**方式 C（命令）**时，这一步可以跳过 —— 脚本会自动改好，并把原文件备份成 `config.yaml.bak-tavern-memory-limit-assistant`。

---

### 第 2 步：安装前端扩展

1. 打开酒馆网页界面
2. 点顶部的 **Extensions（扩展）**
3. 在 **Install extension** 的输入框里粘贴这一行：

```text
https://github.com/Miezai-055/Tavern-Memory-Limit-Assistant
```

4. 点确认安装

装好后，扩展列表里会出现「**聊天内存限制助手**」，就说明这步成功了。

---

### 第 3 步：安装服务端插件

服务端插件必须放在 `<酒馆目录>\plugins\` 下。下面三种方式**选一种**就行。

#### 方式 A：双击脚本（Windows 最省事）

1. 打开这个文件夹：

```text
<酒馆目录>\public\scripts\extensions\third-party\Tavern-Memory-Limit-Assistant\
```

2. 双击里面的 **`install-plugin.bat`**

脚本会自己找到酒馆目录、把插件放好、并打开 `enableServerPlugins`。
看到「安装完成」就可以了。

#### 方式 B：手动复制文件夹（不用命令行，任何系统都行）

1. 复制整个文件夹：

```text
<酒馆目录>\public\scripts\extensions\third-party\Tavern-Memory-Limit-Assistant
```

2. 粘贴到：

```text
<酒馆目录>\plugins\
```

#### 方式 C：一行命令

在 `<酒馆目录>` 里打开终端（PowerShell / CMD / Termux 都行），执行：

```bash
node plugins.js install https://github.com/Miezai-055/Tavern-Memory-Limit-Assistant.git
```

`plugins.js` 是酒馆**自带**的插件安装工具，它会自动把插件放到位。

#### 装完检查

不管用哪种方式，最后**一定要能看到这个文件**：

```text
<酒馆目录>\plugins\Tavern-Memory-Limit-Assistant\index.mjs
```

看不到它，第 4 步重启后服务端就不会加载。

---

### 第 4 步：完全重启酒馆

**把酒馆完全关掉，再重新启动**（是关掉进程，不是刷新网页 —— 服务端插件只在酒馆启动的那一刻加载）。

重启之后，在浏览器按一次 `Ctrl + Shift + R`。

启动日志里出现下面这一行，就说明服务端已经就绪：

```text
[tavern-memory-limit-assistant] Server plugin 1.4.0 loaded.
```

如果**看不到**这一行，按顺序检查：

| 要检查的 | 怎么确认 |
| --- | --- |
| `enableServerPlugins` 是否为 `true` | 打开 `config.yaml`，看第 1 步那一行 |
| 插件文件是否存在 | `<酒馆目录>\plugins\Tavern-Memory-Limit-Assistant\index.mjs` |
| 是否真的重启了 | 关掉酒馆窗口/进程再启动，而不是只刷新网页 |

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

取消勾选后会重新载入完整聊天，之后酒馆恢复使用原生加载与保存。关闭是安全的，不会留下占位符。重新启用时，扩展会先确认聊天文件是否在关闭期间被原生保存更新，避免把聊天回滚到旧的窗口快照。

---

## 手机端（Android / Termux）

手机端酒馆只要满足**前提条件**（完整 Node.js 后端 + 可写 `plugins/`），安装步骤和上面的四步完全一样，只是命令换成手机上的路径：

```bash
# 第 1 步：打开服务端插件开关
nano ~/SillyTavern/config.yaml     # 把 enableServerPlugins 改成 true

# 第 2 步：安装前端扩展（在酒馆界面 Extensions → Install extension 里粘贴仓库地址）

# 第 3 步：安装服务端插件（二选一）
cd ~/SillyTavern
node plugins.js install https://github.com/Miezai-055/Tavern-Memory-Limit-Assistant.git
# 或者用脚本（会自动定位酒馆目录并打开 enableServerPlugins）：
#   cd public/scripts/extensions/third-party/Tavern-Memory-Limit-Assistant && bash install-plugin.sh

# 第 4 步：完全重启酒馆
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
ls ~/SillyTavern/plugins/Tavern-Memory-Limit-Assistant/index.mjs

# d. 完全重启后，日志里应出现这一行
#    [tavern-memory-limit-assistant] Server plugin 1.4.0 loaded.
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
2. 删除酒馆根目录下的 `plugins/Tavern-Memory-Limit-Assistant/`。
3. 可选：删除聊天目录下遗留的 `*.tavern-memory-limit-assistant.full` 快照文件（不删也不影响正常使用）。

---


## 目录结构

```text
Tavern-Memory-Limit-Assistant/
├── manifest.json        # 前端扩展清单
├── index.js             # 前端扩展入口（fetch 桥接 + 内存裁剪 + UI）
├── style.css            # 设置面板样式
├── index.mjs            # 服务端插件入口（读取窗口 + 合并保存）
├── version.json         # 服务端插件版本信息
├── package.json         # 服务端插件入口声明（main: index.mjs）
├── install-plugin.sh    # 安装脚本：Linux/macOS/Termux
├── install-plugin.ps1   # 安装脚本：Windows（PowerShell）
├── install-plugin.bat   # 安装脚本：Windows（双击运行，内部调用上面的 ps1）
└── LICENSE              # Apache License 2.0
```

同一个仓库根目录**同时**是合法的酒馆扩展和合法的服务端插件：

- 装到 `third-party/Tavern-Memory-Limit-Assistant/` 时，`index.js` 的相对导入指向 `public/script.js`；
- 装到 `plugins/Tavern-Memory-Limit-Assistant/` 时，`index.mjs` 的相对导入指向 `src/util.js`。

因此两条安装路径可以共用同一个 Git URL。

> 安装脚本会把整个扩展目录（含服务端文件）复制进 `plugins/`，所以复制过去之后
> 酒馆的 `enableServerPluginsAutoUpdate` 就能把这个 git 仓库一起自动更新。
