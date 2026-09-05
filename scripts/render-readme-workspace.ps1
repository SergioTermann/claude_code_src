param([string]$OutputPath = (Join-Path $PSScriptRoot '../assets/readme/workspace.png'))

Add-Type -AssemblyName System.Drawing
$sourcePath = Join-Path $PSScriptRoot '../hn/browser_experiment_screenshots/R_cwt_symptom_variants_04_1786294355.png'
$source = [System.Drawing.Bitmap]::new([System.IO.Path]::GetFullPath($sourcePath))
$crop = $null
try {
    # Omit the deployment-specific header while preserving the recorded answer.
    $bounds = [System.Drawing.Rectangle]::new(0, 76, $source.Width, $source.Height - 76)
    $crop = $source.Clone($bounds, $source.PixelFormat)
    $target = [System.IO.Path]::GetFullPath($OutputPath)
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
    $crop.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output $target
}
finally {
    if ($null -ne $crop) { $crop.Dispose() }
    $source.Dispose()
}
