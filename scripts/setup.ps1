# Install build prerequisites for SaiLoR on Windows.
# Every install step asks first. Nothing changes without a "y".
$ErrorActionPreference = 'Continue'
$NodeMin = 22

function Have($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

function Choose($question, $options) {
  Write-Host ""
  Write-Host $question
  for ($i = 0; $i -lt $options.Count; $i++) { Write-Host ("  {0}) {1}" -f ($i + 1), $options[$i].Label) }
  Write-Host "  s) Skip"
  $reply = Read-Host "Choice"
  if ($reply -match '^\d+$' -and [int]$reply -ge 1 -and [int]$reply -le $options.Count) {
    $cmd = $options[[int]$reply - 1].Cmd
    Write-Host "Running: $cmd"
    Invoke-Expression $cmd
  } else { Write-Host "Skipped." }
}

$hasWinget = Have 'winget'
$hasChoco = Have 'choco'
Write-Host "Package managers: winget=$hasWinget choco=$hasChoco"

function PmOptions($wingetId, $chocoName) {
  $o = @()
  if ($hasWinget) { $o += @{ Label = "winget: $wingetId"; Cmd = "winget install --id $wingetId -e" } }
  if ($hasChoco) { $o += @{ Label = "Chocolatey: $chocoName"; Cmd = "choco install $chocoName -y" } }
  return $o
}

$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasMsvc = (Test-Path $vsWhere) -and (& $vsWhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
if ($hasMsvc) { Write-Host "OK: MSVC build tools" } else {
  $o = @()
  if ($hasWinget) { $o += @{ Label = "winget: VS 2022 Build Tools with C++ workload"; Cmd = 'winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"' } }
  if ($o.Count -eq 0) { Write-Host "Install MSVC Build Tools by hand: https://visualstudio.microsoft.com/visual-cpp-build-tools/" }
  else { Choose "MSVC C++ build tools are missing." $o }
}

$webview = Test-Path 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
if ($webview) { Write-Host "OK: WebView2 runtime" } else {
  $o = PmOptions 'Microsoft.EdgeWebView2Runtime' 'webview2-runtime'
  if ($o.Count -eq 0) { Write-Host "Install WebView2 by hand: https://developer.microsoft.com/microsoft-edge/webview2/" }
  else { Choose "WebView2 runtime not detected (Windows 11 ships it)." $o }
}

$nodeOk = (Have 'node') -and ([int](node -p 'process.versions.node.split(".")[0]') -ge $NodeMin)
if ($nodeOk) { Write-Host "OK: Node.js $(node -v)" } else {
  $o = PmOptions 'OpenJS.NodeJS' 'nodejs'
  if ($o.Count -eq 0) { Write-Host "Install Node.js >= $NodeMin by hand: https://nodejs.org" }
  else { Choose "Node.js >= $NodeMin not found." $o }
}

if ((Have 'rustc') -and (Have 'cargo')) { Write-Host "OK: $(rustc --version)" } else {
  $o = PmOptions 'Rustlang.Rustup' 'rustup.install'
  if ($o.Count -eq 0) { Write-Host "Install Rust by hand: https://rustup.rs" }
  else { Choose "Rust not found." $o }
}

if ((Have 'node') -and (Test-Path package.json) -and -not (Test-Path node_modules)) {
  if ((Read-Host "Install npm dependencies now (npm ci)? [y/N]") -match '^[Yy]$') { npm ci }
}
Write-Host ""
Write-Host "Done. Open a new shell so PATH updates apply, then run 'make check'."
