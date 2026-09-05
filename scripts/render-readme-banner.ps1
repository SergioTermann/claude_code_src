param([string]$OutputPath = (Join-Path $PSScriptRoot '../assets/readme/windrise-banner.png'))

Add-Type -AssemblyName System.Drawing
$bitmap = [System.Drawing.Bitmap]::new(1600, 480)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#141C1A'))

function Draw-Label([string]$Text, [float]$Size, [string]$Color, [float]$X, [float]$Y, [bool]$Bold = $false) {
    $style = if ($Bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
    $font = [System.Drawing.Font]::new('Segoe UI', $Size, $style, [System.Drawing.GraphicsUnit]::Pixel)
    $brush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($Color))
    try { $graphics.DrawString($Text, $font, $brush, $X, $Y) }
    finally { $font.Dispose(); $brush.Dispose() }
}

$accent = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#88D5AD'))
$line = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#3B4B44'), 1)
try {
    $graphics.FillRectangle($accent, 76, 62, 8, 22)
    Draw-Label 'WIND ENERGY / OPERATIONS INTELLIGENCE' 21 '#B5C7BD' 102 57
    Draw-Label 'Windrise' 132 '#F4F7F5' 68 99 $true
    Draw-Label 'Evidence-grounded intelligence for wind turbine operations.' 28 '#B5C7BD' 78 265
    $graphics.DrawLine($line, 80, 345, 1520, 345)
    Draw-Label '01' 19 '#88D5AD' 80 391
    Draw-Label 'LOCAL INFERENCE' 21 '#F4F7F5' 123 387
    Draw-Label '02' 19 '#88D5AD' 592 391
    Draw-Label 'TRACEABLE KNOWLEDGE' 21 '#F4F7F5' 635 387
    Draw-Label '03' 19 '#88D5AD' 1150 391
    Draw-Label 'CONTEXT-AWARE RETRIEVAL' 20 '#F4F7F5' 1193 387
    $target = [System.IO.Path]::GetFullPath($OutputPath)
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
    $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output $target
}
finally { $accent.Dispose(); $line.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
