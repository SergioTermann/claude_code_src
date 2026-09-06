param([string]$OutputPath = (Join-Path $PSScriptRoot '../assets/readme/windrise-banner.png'))

$ErrorActionPreference = 'Stop'

$renderScript = Join-Path $PSScriptRoot 'render-readme-architecture.py'
python $renderScript

$target = [System.IO.Path]::GetFullPath($OutputPath)
$generated = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../assets/readme/windrise-banner.png'))

if ($target -ne $generated) {
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
    Copy-Item -LiteralPath $generated -Destination $target -Force
}

Write-Output $target
