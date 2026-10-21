# Checks GitHub for a newer version of PV Designer and installs it in place.
# Called by start_windows.bat; never touches .venv or the saved projects in data\.
$ErrorActionPreference = 'Stop'
$repo = 'npapadig/pv-designer'
$root = $PSScriptRoot
$verFile = Join-Path $root '.version'

try {
  $sha = (Invoke-RestMethod "https://api.github.com/repos/$repo/commits/main" -Headers @{ 'User-Agent' = 'pv-designer' } -TimeoutSec 15).sha
} catch {
  Write-Host 'Den egine elegxos gia enhmerwseis (xwris internet?). Synexeia me thn yparxousa ekdosh.'
  exit 0
}
$current = if (Test-Path $verFile) { (Get-Content $verFile -Raw).Trim() } else { '' }
if ($sha -eq $current) { Write-Host 'H efarmogh einai enhmerwmenh.'; exit 0 }

try {
  Write-Host 'Brethhke nea ekdosh, katebainei...'
  $tmp = Join-Path $env:TEMP 'pv-designer-update'
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory $tmp | Out-Null
  $zip = Join-Path $tmp 'update.zip'
  Invoke-WebRequest "https://github.com/$repo/archive/$sha.zip" -OutFile $zip -UseBasicParsing -TimeoutSec 180
  Expand-Archive $zip -DestinationPath $tmp -Force
  $src = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName

  $req = Join-Path $root 'requirements.txt'
  $oldReq = if (Test-Path $req) { (Get-FileHash $req).Hash } else { '' }
  robocopy $src $root /E /XD (Join-Path $src '.venv') (Join-Path $src 'data') /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy $LASTEXITCODE" }
  # New libraries needed: make the launcher reinstall them.
  if ((Get-FileHash $req).Hash -ne $oldReq) { Remove-Item (Join-Path $root '.venv\ready-312.txt') -ErrorAction SilentlyContinue }

  Set-Content $verFile $sha
  New-Item (Join-Path $root '.updated') -ItemType File -Force | Out-Null
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'H enhmerwsh oloklhrwthhke.'
} catch {
  Write-Host "Apetyxe h enhmerwsh ($_). Synexeia me thn yparxousa ekdosh."
}
exit 0
