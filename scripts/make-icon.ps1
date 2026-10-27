# icon/ 의 PNG 원본으로 Windows 아이콘(icon/app.ico)을 만든다.  실행: powershell -ExecutionPolicy Bypass -File scripts/make-icon.ps1
# 48px 원본은 그림 격자와 1:1 이라 그대로 쓰고, 128·256 은 480 원본을 가장 가까운 픽셀로 줄여 각진 모양을 유지한다.
# 격자와 나눠떨어지지 않는 작은 크기(16·24·32·64)는 얇은 선이 사라지지 않도록 고품질 축소를 쓴다.
param(
  [string]$Src = (Join-Path $PSScriptRoot '..\icon'),
  [string]$Out = (Join-Path $PSScriptRoot '..\icon\app.ico'),
  [string]$PreviewDir = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Find-Source([int]$size) {
  $file = Get-ChildItem $Src -Filter "*-$size.png" | Select-Object -First 1
  if (-not $file) { throw "원본을 찾지 못했습니다: *-$size.png" }
  return $file.FullName
}

function Resize-Png([System.Drawing.Image]$image, [int]$size, [bool]$pixel) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  if ($pixel) {
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  } else {
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  }
  $attr = New-Object System.Drawing.Imaging.ImageAttributes
  $attr.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY) # 가장자리 번짐 방지
  $g.DrawImage($image, (New-Object System.Drawing.Rectangle 0, 0, $size, $size), 0, 0, $image.Width, $image.Height, [System.Drawing.GraphicsUnit]::Pixel, $attr)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return ,$ms.ToArray()
}

$big = [System.Drawing.Image]::FromFile((Find-Source 480))
$entries = @()
foreach ($size in 16, 24, 32, 48, 64, 128, 256) {
  if ($size -eq 48) { $png = [System.IO.File]::ReadAllBytes((Find-Source 48)) }
  else { $png = Resize-Png $big $size ($size -ge 128) }
  $entries += ,@($size, $png)
  if ($PreviewDir) { [System.IO.File]::WriteAllBytes((Join-Path $PreviewDir "icon-$size.png"), $png) }
}
$big.Dispose()

# ICO: 머리글 6바이트 + 항목당 16바이트 + PNG 데이터 (Vista 이후 모든 크기에 PNG 허용)
$fs = [System.IO.File]::Create($Out)
$w = New-Object System.IO.BinaryWriter $fs
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$entries.Count)
$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
  $dim = if ($e[0] -ge 256) { 0 } else { $e[0] }
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$e[1].Length); $w.Write([UInt32]$offset)
  $offset += $e[1].Length
}
foreach ($e in $entries) { $w.Write($e[1]) }
$w.Close()
Write-Output "생성: $Out ($($entries.Count)개 크기)"
