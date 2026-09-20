# 朋友 · 启动脚本
#
# 用法：
#   .\start-friend.ps1              前台启动（看得到日志，Ctrl+C 停止）
#   .\start-friend.ps1 -Background  后台启动（日志写进 logs\）
#   .\start-friend.ps1 -Install     注册开机自启（需要管理员）
#   .\start-friend.ps1 -Uninstall   取消开机自启（需要管理员）
#   .\start-friend.ps1 -Status      看运行状态
#
# 为什么单独写一个脚本而不是让计划任务直接跑 node：
# 计划任务直接跑 node 时，相对路径、日志位置、启动目录都容易出错，
# 而且服务挂了没人管。这个脚本把"找 node、设目录、重定向日志、注册任务"都收在一处。

[CmdletBinding()]
param(
  [switch]$Background,
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Status,
  # 内部用：标记"我是被提权后重新拉起来的"，避免无限递归提权
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$LogDir = Join-Path $Root 'logs'
$TaskName = 'Friend-Service'
$Port = 8787

function Write-Step($text) { Write-Host "  $text" }
function Write-Ok($text)   { Write-Host "  ✓ $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "  ⚠ $text" -ForegroundColor Yellow }
function Write-Err($text)  { Write-Host "  ✗ $text" -ForegroundColor Red }

# ---------------------------------------------------------------- 找 node

function Get-NodePath {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @(
      "$env:ProgramFiles\nodejs\node.exe",
      "${env:ProgramFiles(x86)}\nodejs\node.exe",
      "$env:LOCALAPPDATA\nvs\NodeJs\node.exe"
    )) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

function Test-ServiceUp {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3 -UseBasicParsing
    return $r.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Get-ListenerPid {
  # 优先用 netstat：它不依赖 Get-NetTCPConnection 的权限，受限环境下更可靠
  try {
    $line = netstat -ano -p TCP 2>$null |
      Select-String -Pattern ":$Port\s+.*LISTENING\s+(\d+)" |
      Select-Object -First 1
    if ($line -and $line.Matches.Count -gt 0) {
      return [int]$line.Matches[0].Groups[1].Value
    }
  } catch { }
  return $null
}

# ---------------------------------------------------------------- 状态

function Show-Status {
  Write-Host ''
  Write-Host '  朋友 · 状态' -ForegroundColor Cyan
  Write-Host ''
  $node = Get-NodePath
  Write-Host "  node            $(if ($node) { $node } else { '（找不到！）' })"
  Write-Host "  项目目录        $Root"

  if (Test-ServiceUp) {
    $pid2 = Get-ListenerPid
    Write-Ok "服务在跑（端口 $Port，进程 $pid2）"
  } else {
    Write-Err "服务没在跑"
  }

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Ok "已注册开机自启（状态：$($task.State)）"
    if ($info -and $info.LastRunTime -gt [datetime]'2000-01-01') {
      Write-Step "上次运行：$($info.LastRunTime)   结果：$($info.LastTaskResult)"
    }
  } else {
    Write-Warn2 '没有注册开机自启 —— 重启电脑后服务不会自己起来'
    Write-Step '在命令行里跑：friend.cmd install'
    Write-Step '（会自动弹出 UAC 授权窗口，点"是"即可）'
  }

  $logs = Get-ChildItem $LogDir -Filter '*.log' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 3
  if ($logs) {
    Write-Host ''
    Write-Host '  最近的日志：'
    foreach ($l in $logs) {
      Write-Host "    $($l.Name)  ($([math]::Round($l.Length/1KB,1)) KB, $($l.LastWriteTime))"
    }
  }
  Write-Host ''
}

# ---------------------------------------------------------------- 安装 / 卸载

<# 判断当前是不是管理员 #>
function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

<#
  提权重跑自己。

  为什么要这样：注册计划任务必须管理员权限，而"请你自己去开管理员窗口"
  这种提示很容易被忽略或搞错（实测用户就在这里卡住过）。
  直接用 UAC 弹窗让用户点一下"是"，体验好得多。

  另一个坑：提权窗口是独立进程，一闪就没了，出错时什么都看不到。
  所以这里把输出同时写进 logs\install.log，装不上时有据可查。
#>
function Restart-Elevated {
  $scriptPath = Join-Path $Root 'start-friend.ps1'
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $installLog = Join-Path $LogDir 'install.log'

  Write-Host ''
  Write-Step '需要管理员权限，正在弹出授权窗口…'
  Write-Step '（在弹出的对话框里点"是"）'
  Write-Host ''

  try {
    # 提权后用 -Command 而不是 -File：这样才能把输出重定向到日志，
    # 并在结束时停住窗口，让人看得到结果或错误。
    $inner = "& '$scriptPath' -Install -Elevated *>&1 | Tee-Object -FilePath '$installLog'; " +
      "Write-Host ''; Write-Host '按回车键关闭这个窗口'; Read-Host | Out-Null"
    Start-Process -FilePath 'powershell.exe' `
      -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $inner) `
      -Verb RunAs
  } catch {
    Write-Err '提权被取消或失败。'
    Write-Step '你也可以手动开一个管理员 PowerShell，然后执行：'
    Write-Step "  cd $Root"
    Write-Step '  .\start-friend.ps1 -Install'
    exit 1
  }
  exit 0
}

function Install-Autostart {
  if (-not (Test-Admin)) { Restart-Elevated }

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)

  $node = Get-NodePath
  if (-not $node) { Write-Err '找不到 node.exe，无法注册'; exit 1 }

  $scriptPath = Join-Path $Root 'start-friend.ps1'
  $argLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`" -Background"

  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory $Root

  # 登录时启动
  $trigger = New-ScheduledTaskTrigger -AtLogOn

  # 挂了自动重拉：每 5 分钟检查一次，最多重试 999 次
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 5) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

  $principalObj = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Highest

  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Step '已移除旧的计划任务'
  }

  Register-ScheduledTask -TaskName $TaskName `
    -Action $action -Trigger $trigger -Settings $settings -Principal $principalObj `
    -Description '朋友：一个会主动找你聊天的 AI，本地常驻服务' | Out-Null

  Write-Ok "已注册开机自启：$TaskName"
  Write-Step '下次登录 Windows 时会自动启动，并且挂了会自动重启'
  Write-Host ''
  Write-Step '现在就启动它：'
  Write-Step "  .\start-friend.ps1 -Background"
}

function Uninstall-Autostart {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Err '取消开机自启需要管理员权限'
    exit 1
  }
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Ok "已移除：$TaskName"
  } else {
    Write-Step '本来就没有注册'
  }
}

# ---------------------------------------------------------------- 启动

function Start-Foreground {
  <#
    启动前必须先看端口有没有被占。

    这里踩过一次：后台启动有这道检查，前台启动忘了加，
    于是在服务已经跑着的时候再执行一次就直接撞端口报错
    （"端口 8787 已被占用"），让人以为是程序坏了。
  #>
  if (Test-ServiceUp) {
    $existing = Get-ListenerPid
    Write-Warn2 "服务已经在跑了（端口 $Port，进程 $existing）"
    Write-Step '不用再启动。看状态用： friend.cmd status'
    return
  }

  # 端口被别的程序占着（不是我们的服务）也要说清楚
  $occupier = Get-ListenerPid
  if ($occupier) {
    Write-Err "端口 $Port 被别的程序占用（进程 $occupier）"
    Write-Step '改 config.json 里的 port，或先关掉占用它的程序。'
    return
  }

  $node = Get-NodePath
  if (-not $node) { Write-Err '找不到 node.exe'; exit 1 }
  Write-Step "启动中（前台，Ctrl+C 停止）…"
  Set-Location $Root
  & $node 'src/server.js'
}

function Start-Background {
  if (Test-ServiceUp) {
    Write-Warn2 "服务已经在跑了（端口 $Port）"
    return
  }

  $node = Get-NodePath
  if (-not $node) { Write-Err '找不到 node.exe'; exit 1 }

  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $stamp = Get-Date -Format 'yyyy-MM-dd'
  $outLog = Join-Path $LogDir "friend-$stamp.log"
  $errLog = Join-Path $LogDir "friend-$stamp.err.log"

  # 用 Start-Process 让它脱离当前终端独立运行；
  # 这样关掉这个 PowerShell 窗口服务也不会停。
  $proc = Start-Process -FilePath $node `
    -ArgumentList 'src/server.js' `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -WindowStyle Hidden `
    -PassThru

  Write-Step "已拉起进程 $($proc.Id)，等它就绪…"

  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 700
    if (Test-ServiceUp) {
      Write-Ok "服务已就绪：http://127.0.0.1:$Port"
      Write-Step "日志：$outLog"
      return
    }
    if ($proc.HasExited) {
      Write-Err "进程退出了（退出码 $($proc.ExitCode)）"
      Write-Step "看错误日志：$errLog"
      if (Test-Path $errLog) { Get-Content $errLog -Tail 15 | ForEach-Object { Write-Host "    $_" } }
      return
    }
  }

  Write-Warn2 '等了 14 秒还没就绪，它可能还在启动（首次加载或模型请求较慢）'
  Write-Step "日志：$outLog"
}

# ---------------------------------------------------------------- 入口

Write-Host ''
Write-Host '  朋友 · 启动器' -ForegroundColor Cyan
Write-Host ''

if ($Install) { Install-Autostart }
elseif ($Uninstall) { Uninstall-Autostart }
elseif ($Status) { Show-Status }
elseif ($Background) { Start-Background }
else { Start-Foreground }
