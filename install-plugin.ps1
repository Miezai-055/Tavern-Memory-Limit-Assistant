# Install the Chat Memory Window *server plugin* into a SillyTavern installation.
#
# The frontend half of the extension is installed from the SillyTavern UI
# (Extensions -> Install extension). This script only handles the server plugin,
# which must live in <SillyTavern>\plugins\ and needs enableServerPlugins: true.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install-plugin.ps1 [-SillyTavern "D:\path\to\SillyTavern"]

[CmdletBinding()]
param(
    [string]$SillyTavern,
    [string]$RepoUrl = $(if ($env:CMW_REPO_URL) { $env:CMW_REPO_URL } else { 'https://github.com/liuyuanjianlyj-crypto/chat-memory-window.git' })
)

$ErrorActionPreference = 'Stop'
$PluginName = 'chat-memory-window'

function Write-Info { param([string]$Message) Write-Host "[info] $Message" -ForegroundColor Cyan }
function Write-Warn2 { param([string]$Message) Write-Host "[warn] $Message" -ForegroundColor Yellow }

function Test-SillyTavernRoot {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    return (Test-Path (Join-Path $Path 'server.js')) -and (Test-Path (Join-Path $Path 'public\script.js'))
}

function Resolve-SillyTavern {
    param([string]$Path)
    if (-not [string]::IsNullOrWhiteSpace($Path)) {
        if (-not (Test-SillyTavernRoot $Path)) {
            throw "Not a SillyTavern root (missing server.js / public\script.js): $Path"
        }
        return (Resolve-Path $Path).Path
    }

    $candidates = @(
        $PWD.Path,
        (Join-Path $PWD.Path 'SillyTavern'),
        (Join-Path $HOME 'SillyTavern'),
        (Join-Path $HOME 'sillytavern'),
        'C:\SillyTavern',
        'D:\SillyTavern'
    )

    foreach ($candidate in $candidates) {
        if (Test-SillyTavernRoot $candidate) { return (Resolve-Path $candidate).Path }
    }

    throw 'Could not locate SillyTavern. Pass its path explicitly: -SillyTavern "D:\path\to\SillyTavern"'
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'git is required but was not found in PATH.'
}

$stRoot = Resolve-SillyTavern -Path $SillyTavern
Write-Info "SillyTavern root: $stRoot"

$pluginDir = Join-Path $stRoot "plugins\$PluginName"
$pluginsDir = Join-Path $stRoot 'plugins'
if (-not (Test-Path $pluginsDir)) { New-Item -ItemType Directory -Path $pluginsDir | Out-Null }

if (Test-Path (Join-Path $pluginDir '.git')) {
    Write-Info 'Existing plugin checkout found, updating...'
    git -C $pluginDir pull --ff-only
} elseif (Test-Path $pluginDir) {
    Write-Warn2 "$pluginDir already exists but is not a git checkout."
    Write-Warn2 'Move it aside and re-run if you want the script to manage it.'
} else {
    Write-Info "Cloning server plugin into plugins\$PluginName ..."
    git clone --depth 1 $RepoUrl $pluginDir
}

if (-not (Test-Path (Join-Path $pluginDir 'index.mjs'))) {
    throw "index.mjs not found in $pluginDir - the checkout looks incomplete."
}

$configPath = Join-Path $stRoot 'config.yaml'
if (Test-Path $configPath) {
    $enabled = Select-String -Path $configPath -Pattern '^\s*enableServerPlugins:\s*true\s*$' -Quiet
    if ($enabled) {
        Write-Info 'enableServerPlugins is already true in config.yaml.'
    } else {
        Write-Warn2 "enableServerPlugins is NOT enabled in $configPath"
        Write-Warn2 "Set it to 'true' (config.yaml: enableServerPlugins: true) or the plugin will not load."
    }
} else {
    Write-Warn2 "config.yaml not found at $configPath - make sure enableServerPlugins is true."
}

@"

Server plugin installed at:
  $pluginDir

Next steps:
  1. Make sure config.yaml has: enableServerPlugins: true
  2. Fully restart SillyTavern (server plugins load only at startup).
  3. Hard-refresh the browser (Ctrl + Shift + R), then enable the extension
     in the chat-memory-window settings panel.

Frontend half (if you have not done it yet):
  SillyTavern -> Extensions -> Install extension ->
  $RepoUrl
"@ | Write-Host
