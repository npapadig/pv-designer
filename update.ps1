# Checks GitHub for a newer version of PV Designer and installs it in place.
# Called by start_windows.bat; never touches .venv or the saved projects in data\.
$ErrorActionPreference = 'Stop'
$repo = 'npapadig/pv-designer'
$root = $PSScriptRoot
$verFile = Join-Path $root '.version'
$versionFile = Join-Path $root 'VERSION'
function Get-AppVersion { if (Test-Path $versionFile) { 'v' + (Get-Content $versionFile -Raw).Trim() } else { 'v0.1.0' } }
$oldVersion = Get-AppVersion

# A copy of the app that is still running locks files in .venv and holds port 8000.
# (The venv python.exe is a launcher, so match the server by its command line;
# since the hidden start it runs as "pythonw -m backend.lifecycle".)
Get-CimInstance Win32_Process -Filter "Name like 'python%'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*uvicorn*backend.main:app*' -or $_.CommandLine -like '*backend.lifecycle*' } |
  ForEach-Object { Write-Host 'Kleinei h efarmogh poy etrexe hdh...'; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

if ($root -match 'OneDrive') {
  Write-Host ''
  Write-Host 'PROSOXH: o fakelos ths efarmoghs einai mesa sto OneDrive. O sygxronismos mporei na'
  Write-Host 'kleidwnei arxeia kai na xalaei thn egkatastash. Kalytera metefere ton sto C:\pv-designer'
  Write-Host ''
}

# A git checkout (e.g. used by Claude Code on this PC) is updated with git, not by
# copying files over it, which would overwrite work that is not pushed yet.
if (Test-Path (Join-Path $root '.git')) {
  Write-Host "Fakelos git ($oldVersion): oi enhmerwseis ginontai me git pull, oxi automata."
  exit 0
}

try {
  $sha = (Invoke-RestMethod "https://api.github.com/repos/$repo/commits/main" -Headers @{ 'User-Agent' = 'pv-designer' } -TimeoutSec 15).sha
} catch {
  Write-Host 'Den egine elegxos gia enhmerwseis (xwris internet?). Synexeia me thn yparxousa ekdosh.'
  exit 0
}
$current = if (Test-Path $verFile) { (Get-Content $verFile -Raw).Trim() } else { '' }
if ($sha -eq $current) { Write-Host "H efarmogh einai enhmerwmenh ($oldVersion)."; exit 0 }

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
  Write-Host "Enhmerwsh apo $oldVersion se $(Get-AppVersion)."
  Start-Sleep -Seconds 2
} catch {
  Write-Host "Apetyxe h enhmerwsh ($_). Synexeia me thn yparxousa ekdosh."
}
exit 0
