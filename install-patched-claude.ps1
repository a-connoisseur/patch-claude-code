param(
  [string]$RepoSlug = ""
)

$ErrorActionPreference = "Stop"

if (-not $RepoSlug) {
  $RepoSlug = if ($env:PATCH_CLAUDE_REPO) { $env:PATCH_CLAUDE_REPO } else { "a-connoisseur/patch-claude-code" }
}

function Fail {
  param([string]$Message)
  Write-Error "Error: $Message"
  exit 1
}

function Get-ReleaseSuffix {
  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }

  switch ($arch.ToUpperInvariant()) {
    "AMD64" { return "win32-x64" }
    "ARM64" { return "win32-arm64" }
    default { Fail "Unsupported Windows architecture: $arch" }
  }
}

function Get-GitHubHeaders {
  $headers = @{
    "Accept" = "application/vnd.github+json"
    "User-Agent" = "patch-claude-code-installer"
  }

  if ($env:GITHUB_TOKEN) {
    $headers["Authorization"] = "Bearer $($env:GITHUB_TOKEN)"
  } elseif ($env:GH_TOKEN) {
    $headers["Authorization"] = "Bearer $($env:GH_TOKEN)"
  }

  return $headers
}

$releaseSuffix = Get-ReleaseSuffix
$assetName = "claude.native.windows.patched.exe"
$releaseBaseUrl = "https://github.com/$RepoSlug/releases/download"

$claudeCommand = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $claudeCommand) {
  Fail "Could not find an existing native Claude installation. Install the official native Claude binary first, then run this installer again."
}

$claudePath = if ($claudeCommand.Source) { $claudeCommand.Source } else { $claudeCommand.Path }
if (-not $claudePath) {
  Fail "Could not resolve the installed Claude executable path."
}

$headers = Get-GitHubHeaders
$feedUrl = "$releaseBaseUrl/patched-updates/$releaseSuffix.json"
try {
  $release = Invoke-RestMethod -Uri $feedUrl -Headers $headers
} catch {
  Fail "Could not find a patched update feed for $releaseSuffix"
}
$claudeVersion = $release.version
$releaseTag = $release.tag
$tagPattern = "^v$([regex]::Escape($claudeVersion))-$releaseSuffix(?:-(?:[2-9]|[1-9][0-9]+))?$"
if ($claudeVersion -notmatch "^[0-9]+\.[0-9]+\.[0-9]+$" -or $releaseTag -notmatch $tagPattern -or
    $release.platform -ne $releaseSuffix -or $release.assetName -ne $assetName -or
    $release.url -ne "$releaseBaseUrl/$releaseTag/$assetName" -or
    $release.sha256 -notmatch "^[a-f0-9]{64}$" -or $release.size -le 0) {
  Fail "Invalid patched update feed for $releaseSuffix"
}

$tmpDir = New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString()))
try {
  $downloadedPath = Join-Path $tmpDir.FullName $assetName
  Write-Host "Downloading $assetName from $releaseTag"
  Invoke-WebRequest -Uri $release.url -OutFile $downloadedPath
  $checksum = (Get-FileHash -LiteralPath $downloadedPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($checksum -ne $release.sha256 -or (Get-Item -LiteralPath $downloadedPath).Length -ne $release.size) {
    Fail "Patched download checksum mismatch; keeping the current installation"
  }
  $versionOutput = (& $downloadedPath --version) -join "`n"
  $reportedVersion = [regex]::Match($versionOutput, "[0-9]+\.[0-9]+\.[0-9]+").Value
  if ($LASTEXITCODE -ne 0 -or $versionOutput -notmatch "\(patched\)" -or
      $reportedVersion -ne $claudeVersion) {
    Fail "Downloaded binary does not identify as the expected patched Claude version"
  }

  Copy-Item -LiteralPath $downloadedPath -Destination $claudePath -Force

  Write-Host "Installed patched Claude to $claudePath"
  & $claudePath --version
} finally {
  Remove-Item -LiteralPath $tmpDir.FullName -Recurse -Force -ErrorAction SilentlyContinue
}
