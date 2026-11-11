$ErrorActionPreference = "Stop"

$Repo = "dittofleet/weblab"
$Asset = "weblab-windows-x64.exe"
$Dest = if ($env:WEBLAB_INSTALL_DIR) { $env:WEBLAB_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\weblab" }
$Url = "https://github.com/$Repo/releases/latest/download/$Asset"
$Exe = Join-Path $Dest "weblab.exe"

New-Item -ItemType Directory -Force $Dest | Out-Null
# Staged inside the destination so the install is a same-volume rename:
# an interruption can't leave a truncated binary in its place.
$Staged = Join-Path $Dest ".weblab-$PID.exe"
try {
  Write-Host "Downloading $Url..."
  Invoke-WebRequest -Uri $Url -OutFile $Staged
  # A running weblab can be moved aside, not written over or removed.
  Remove-Item -Force -ErrorAction SilentlyContinue "$Exe.old-*"
  if (Test-Path $Exe) { Move-Item $Exe "$Exe.old-$PID" }
  Move-Item $Staged $Exe
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $Staged
}
Write-Host "Installed weblab to $Exe"
& $Exe --fetch-ffmpeg

if (($env:PATH -split ";") -notcontains $Dest) {
  Write-Host "Note: $Dest is not on PATH. Add it to your user PATH to use weblab."
}
