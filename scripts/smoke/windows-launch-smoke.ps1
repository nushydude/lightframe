param(
  [string]$ExePath = "src-tauri/target/release/lightframe.exe",
  [int]$TimeoutSeconds = 45,
  [int]$WindowStablePolls = 2,
  [int]$RespondingGraceSeconds = 5,
  [switch]$AllowExistingLightFrame
)

$ErrorActionPreference = "Stop"

function Resolve-SmokePath {
  param([string]$Path)

  if ([System.IO.Path]::IsPathRooted($Path)) {
    return (Resolve-Path -LiteralPath $Path).Path
  }

  $repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "../..")).Path
  return (Resolve-Path -LiteralPath (Join-Path $repoRoot $Path)).Path
}

function Get-LightFrameCrashEvents {
  param([datetime]$StartTime)

  $providers = @("Application Error", "Windows Error Reporting")
  foreach ($provider in $providers) {
    Get-WinEvent -FilterHashtable @{
      LogName = "Application"
      ProviderName = $provider
      StartTime = $StartTime
    } -ErrorAction SilentlyContinue |
      Where-Object { $_.Message -match "lightframe\.exe|LightFrame" } |
      Select-Object -First 3
  }
}

function Format-CrashEvent {
  param($Event)

  $message = [string]$Event.Message
  $message = $message -replace "\s+", " "
  if ($message.Length -gt 500) {
    $message = $message.Substring(0, 500)
  }

  return $Event.TimeCreated.ToString("o") + " " + $Event.ProviderName + ": " + $message
}

$resolvedExePath = Resolve-SmokePath $ExePath
$existing = @(Get-Process -Name "lightframe" -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0 -and -not $AllowExistingLightFrame) {
  $ids = ($existing | ForEach-Object { $_.Id }) -join ", "
  throw "LightFrame is already running (PID $ids). Close it or rerun with -AllowExistingLightFrame."
}

$appConfigDir = Join-Path $env:APPDATA "com.lightframe.app"
$settingsPath = Join-Path $appConfigDir "settings.json"
$backupPath = $null
$hadSettings = Test-Path -LiteralPath $settingsPath
$process = $null
$startedAt = Get-Date

try {
  New-Item -ItemType Directory -Force -Path $appConfigDir | Out-Null
  if ($hadSettings) {
    $backupPath = "$settingsPath.smoke-backup-$($startedAt.ToString('yyyyMMddHHmmssfff'))"
    Copy-Item -LiteralPath $settingsPath -Destination $backupPath -Force
  }

  $seedSettings = [ordered]@{
    theme = "dark"
    slideshow_interval_seconds = 4
    slideshow_direction = "forward"
    loop_slideshow = $false
    shuffle_slideshow = $false
    auto_fullscreen_on_slideshow = $true
    crop_save_mode = "copy"
    mouse_wheel_behavior = "zoom"
    default_fit_mode = "fit"
    remember_window_bounds = $true
    window_x = 48
    window_y = 48
    window_width = 1000
    window_height = 700
    last_window_display_key = $null
    window_bounds_by_display = @{}
    sort_order = "name"
    show_thumbnails = $true
    prompt_projector_grid_on_open = $true
    open_projector_in_grid_view = $false
    performance_mode = "balanced"
    auto_refresh_folder = $true
    update_channel = "stable"
    saved_view_presets = @("favorites", "rated4", "unreviewed")
    recent_folders = @()
    quick_destinations = @()
    pinned_toolbar_actions = @()
    persisted_marked_folders = @()
  }
  $settingsJson = $seedSettings | ConvertTo-Json -Depth 8
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($settingsPath, $settingsJson, $utf8NoBom)

  Write-Host "Launching $resolvedExePath"
  $process = Start-Process -FilePath $resolvedExePath -PassThru
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastTitle = ""
  $lastHandle = [IntPtr]::Zero
  $stableWindowPolls = 0
  $respondingGraceDeadline = $null

  while ((Get-Date) -lt $deadline) {
    $process.Refresh()
    if ($process.HasExited) {
      $crashes = @(Get-LightFrameCrashEvents -StartTime $startedAt)
      $crashText = if ($crashes.Count -gt 0) {
        ($crashes | ForEach-Object { Format-CrashEvent $_ }) -join "`n"
      } else {
        "No matching fresh Windows Error Reporting events found."
      }
      throw "LightFrame exited before showing a main window (exit code $($process.ExitCode)).`n$crashText"
    }

    $lastHandle = $process.MainWindowHandle
    $lastTitle = $process.MainWindowTitle
    if ($lastHandle -ne [IntPtr]::Zero -and $lastTitle -like "LightFrame*") {
      if ($stableWindowPolls -eq 0) {
        $respondingGraceDeadline = (Get-Date).AddSeconds($RespondingGraceSeconds)
      }
      $stableWindowPolls += 1
      if ($stableWindowPolls -lt $WindowStablePolls) {
        Start-Sleep -Milliseconds 250
        continue
      }

      if (-not $process.Responding) {
        if ($respondingGraceDeadline -and (Get-Date) -lt $respondingGraceDeadline) {
          Start-Sleep -Milliseconds 250
          continue
        }
        throw "LightFrame opened a main window but it is not responding after $RespondingGraceSeconds seconds."
      }

      $crashes = @(Get-LightFrameCrashEvents -StartTime $startedAt)
      if ($crashes.Count -gt 0) {
        $crashSummary = ($crashes | ForEach-Object { $_.TimeCreated.ToString("o") + " " + $_.ProviderName }) -join "; "
        throw "LightFrame opened, but fresh crash-reporting events were recorded: $crashSummary"
      }

      Write-Host "Smoke passed: PID $($process.Id), HWND $lastHandle, title '$lastTitle'."
      exit 0
    } else {
      $stableWindowPolls = 0
      $respondingGraceDeadline = $null
    }

    Start-Sleep -Milliseconds 250
  }

  throw "Timed out after $TimeoutSeconds seconds waiting for LightFrame to show a main window. Last HWND: $lastHandle, title: '$lastTitle'."
} finally {
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }

  if ($backupPath -and (Test-Path -LiteralPath $backupPath)) {
    Move-Item -LiteralPath $backupPath -Destination $settingsPath -Force
  } elseif (-not $hadSettings -and (Test-Path -LiteralPath $settingsPath)) {
    Remove-Item -LiteralPath $settingsPath -Force
  }
}
