# memdrive installer for Windows (PowerShell).
#   irm https://raw.githubusercontent.com/AjaySingh-a/memdrive/main/install.ps1 | iex
$ErrorActionPreference = "Stop"

$Repo = if ($env:MEMDRIVE_REPO) { $env:MEMDRIVE_REPO } else { "AjaySingh-a/memdrive" }
# Install the latest published release (falls back to main if there is none yet).
$Ref = $env:MEMDRIVE_REF
if (-not $Ref) {
  try { $Ref = (Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing).tag_name } catch { $Ref = "main" }
}
$Home_ = $env:USERPROFILE
$AppDir = Join-Path $Home_ ".memdrive\app"
$BinDir = Join-Path $Home_ ".memdrive\bin"

# claude-mem installs Bun, so it is normally already here.
$Bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $Bun -and (Test-Path "$Home_\.bun\bin\bun.exe")) { $Bun = "$Home_\.bun\bin\bun.exe" }
if (-not $Bun) {
  Write-Host "Bun not found, installing it (https://bun.sh)..."
  powershell -c "irm bun.sh/install.ps1 | iex"
  $Bun = "$Home_\.bun\bin\bun.exe"
}

$DataDir = if ($env:CLAUDE_MEM_DATA_DIR) { $env:CLAUDE_MEM_DATA_DIR } else { Join-Path $Home_ ".claude-mem" }
if (-not (Test-Path $DataDir)) {
  Write-Host "Note: claude-mem's data folder was not found. Install claude-mem first, or memdrive will have nothing to back up."
}

Write-Host "Downloading memdrive..."
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("memdrive-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Tmp | Out-Null
try {
  $Zip = Join-Path $Tmp "memdrive.zip"
  Invoke-WebRequest "https://github.com/$Repo/archive/$Ref.zip" -OutFile $Zip -UseBasicParsing
  Expand-Archive $Zip -DestinationPath $Tmp
  if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
  New-Item -ItemType Directory -Path (Split-Path $AppDir) -Force | Out-Null
  Move-Item (Get-ChildItem $Tmp -Directory -Filter "memdrive-*")[0].FullName $AppDir
} finally {
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
Set-Content -Path (Join-Path $BinDir "memdrive.cmd") -Value "@`"$Bun`" `"$AppDir\src\cli.ts`" %*" -Encoding ASCII

# Teach Claude Code about memdrive, so "is my memory backed up?" just works.
$ClaudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $Home_ ".claude" }
$SkillDir = Join-Path $ClaudeDir "skills\memdrive"
New-Item -ItemType Directory -Path $SkillDir -Force | Out-Null
Copy-Item (Join-Path $AppDir "skill\SKILL.md") (Join-Path $SkillDir "SKILL.md") -Force

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($UserPath -split ";") -notcontains $BinDir) {
  [Environment]::SetEnvironmentVariable("Path", "$UserPath;$BinDir", "User")
  $env:Path = "$env:Path;$BinDir"
  Write-Host "Added $BinDir to your PATH (open a new terminal to use memdrive there)."
}

Write-Host "Connecting Google Drive..."
& (Join-Path $BinDir "memdrive.cmd") setup
