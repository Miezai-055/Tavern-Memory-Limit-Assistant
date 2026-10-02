#
# 安装「聊天内存限制助手」的**服务端插件**部分。
#
# 优先做法：从已经装好的前端扩展目录直接复制（不需要联网，也不需要 git）。
# 备选做法：本地找不到前端扩展时，才从仓库地址克隆一份。
#
# 用法（可右键本文件 → 使用 PowerShell 运行，或双击同目录的 install-plugin.bat）：
#   powershell -ExecutionPolicy Bypass -File install-plugin.ps1 [-SillyTavern "D:\SillyTavern"]

[CmdletBinding()]
param(
    [string]$SillyTavern,
    [string]$RepoUrl = $(if ($env:CMW_REPO_URL) { $env:CMW_REPO_URL } else { 'https://github.com/Miezai-055/Tavern-Memory-Limit-Assistant.git' })
)

$ErrorActionPreference = 'Stop'
$PluginName = 'Tavern-Memory-Limit-Assistant'
$FrontendRel = 'public\scripts\extensions\third-party\Tavern-Memory-Limit-Assistant'

function Write-Info2 { param([string]$Message) Write-Host "[信息] $Message" -ForegroundColor Cyan }
function Write-Warn2 { param([string]$Message) Write-Host "[警告] $Message" -ForegroundColor Yellow }
function Fail { param([string]$Message) Write-Host "[错误] $Message" -ForegroundColor Red; exit 1 }

function Test-StRoot {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    return (Test-Path -LiteralPath (Join-Path $Path 'server.js') -PathType Leaf) -and
           (Test-Path -LiteralPath (Join-Path $Path 'config.yaml') -PathType Leaf)
}

function Resolve-StRoot {
    param([string]$Path)

    if (-not [string]::IsNullOrWhiteSpace($Path)) {
        if (-not (Test-StRoot $Path)) { Fail "不是有效的酒馆根目录（缺少 server.js / config.yaml）：$Path" }
        return (Resolve-Path -LiteralPath $Path).Path
    }

    # 扩展装在酒馆里时，脚本自身位置是最可靠的线索：
    # <酒馆>/public/scripts/extensions/third-party/tavern-memory-limit-assistant/install-plugin.ps1
    $selfRoot = $null
    if ($PSScriptRoot) {
        $selfRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))))
    }

    $candidates = @(
        $selfRoot,
        $PWD.Path,
        (Join-Path $PWD.Path 'SillyTavern'),
        (Join-Path $HOME 'SillyTavern'),
        (Join-Path $HOME 'sillytavern'),
        'C:\SillyTavern',
        'D:\SillyTavern',
        'E:\SillyTavern'
    )

    foreach ($candidate in $candidates) {
        if (Test-StRoot $candidate) { return (Resolve-Path -LiteralPath $candidate).Path }
    }

    Fail '找不到酒馆目录。请显式指定：-SillyTavern "D:\SillyTavern"'
}

$stRoot = Resolve-StRoot -Path $SillyTavern
Write-Info2 "酒馆根目录：$stRoot"

$pluginDir = Join-Path $stRoot "plugins\$PluginName"
$pluginsRoot = Join-Path $stRoot 'plugins'
$frontendDir = Join-Path $stRoot $FrontendRel
if (-not (Test-Path -LiteralPath $pluginsRoot)) { New-Item -ItemType Directory -Path $pluginsRoot | Out-Null }

# ---- 第 1 步：把服务端插件放到 plugins/ ----
if (Test-Path -LiteralPath (Join-Path $frontendDir 'index.mjs') -PathType Leaf) {
    Write-Info2 '从已安装的前端扩展复制（无需联网）...'
    Write-Info2 "  来源：$frontendDir"
    if (-not (Test-Path -LiteralPath $pluginDir)) { New-Item -ItemType Directory -Path $pluginDir | Out-Null }
    Copy-Item -Path (Join-Path $frontendDir '*') -Destination $pluginDir -Recurse -Force
    # 连同隐藏项（.git、.gitignore 等）一起复制，让酒馆的插件自动更新能认出这是 git 仓库。
    Get-ChildItem -LiteralPath $frontendDir -Force | Where-Object { $_.Name -like '.*' } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $pluginDir -Recurse -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Warn2 '本地没找到前端扩展，改为从仓库克隆...'
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail '需要 git，但 PATH 里找不到它。' }
    if (Test-Path -LiteralPath (Join-Path $pluginDir '.git')) {
        git -C $pluginDir pull --ff-only
    } else {
        if (Test-Path -LiteralPath $pluginDir) { Remove-Item -LiteralPath $pluginDir -Recurse -Force }
        git clone --depth 1 $RepoUrl $pluginDir
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $pluginDir 'index.mjs') -PathType Leaf)) {
    Fail "安装不完整：缺少 $pluginDir\index.mjs"
}
Write-Info2 "服务端插件已就位：$pluginDir"

# ---- 第 2 步：打开 enableServerPlugins ----
$configPath = Join-Path $stRoot 'config.yaml'
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $configText = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
    if ($configText -match '(?m)^enableServerPlugins:\s*true\s*$') {
        Write-Info2 'config.yaml 里的 enableServerPlugins 已经是 true。'
    } else {
        Copy-Item -LiteralPath $configPath -Destination "$configPath.bak-tavern-memory-limit-assistant" -Force
        if ($configText -match '(?m)^\s*enableServerPlugins:') {
            $newText = [regex]::Replace($configText, '(?m)^\s*enableServerPlugins:.*$', 'enableServerPlugins: true')
            Write-Info2 '已把 enableServerPlugins 改成 true（原文件备份为 config.yaml.bak-tavern-memory-limit-assistant）。'
        } else {
            $newText = $configText.TrimEnd() + "`r`n`r`nenableServerPlugins: true`r`n"
            Write-Info2 '已在 config.yaml 末尾补上 enableServerPlugins: true（原文件备份为 config.yaml.bak-tavern-memory-limit-assistant）。'
        }
        Set-Content -LiteralPath $configPath -Value $newText -Encoding UTF8 -NoNewline
    }
} else {
    Write-Warn2 "找不到 $configPath，请手动确认里面有 enableServerPlugins: true。"
}

Write-Host ''
Write-Host '安装完成。' -ForegroundColor Green
Write-Host @'

接下来：
  1. 完全关闭酒馆再重新启动（服务端插件只在启动时加载，刷新页面没用）。
  2. 浏览器按 Ctrl + Shift + R 强制刷新一次。
  3. 打开「聊天内存限制助手」面板，勾选启用，再点「重新加载当前聊天」。

启动日志里出现下面这一行，就说明服务端已经就绪：
  [tavern-memory-limit-assistant] Server plugin 1.4.0 loaded.
'@
