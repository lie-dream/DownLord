<#
.SYNOPSIS
  DownLord 图标生成器 —— 从根目录 icon.png(1028×1028)一次性生成成品位图。

.DESCRIPTION
  为什么是 PowerShell 而不是 npm 脚本:
  TODO #43 明写「不引 sharp / jimp」⇒ 仓库里不能有「从大图程序化生成 ico」这一构建步骤
  ⇒ 所有位图只能一次性生成好、成品入库。本脚本用 Windows 自带的 .NET(System.Drawing)干这件事,
  零新依赖、不装任何软件、不加 npm 包。

  它【不接进门禁、不被 npm 调用】—— 入库只是为了让「这几个尺寸怎么来的」不失传。
  产出是确定性的:同一命令跑两次,字节完全一致。

.PARAMETER Style
  square = 直角(源图自带的圆角原样保留);round = 在此之上再做几何圆角裁切。
  ⚠️ 圆角处的透明是【几何裁切,不是抠图】,质量无损。做与不做由用户看样图后拍板。

.PARAMETER Preview
  额外生成三张呈现用样图(圆角 vs 直角对比 / 16px 放大 / 256px 效果),供定稿卡口用。
  加了它会同时渲染两种 Style,与 -Style 参数无关。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-icons.ps1 -Style square
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-icons.ps1 -Style round
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-icons.ps1 -Preview

.NOTES
  定稿(去掉 -Prefix、直接覆盖 build/icon.ico 与 build/icon.png)由拍板后的那一步做,本脚本不自作主张覆盖。
#>
[CmdletBinding()]
param(
  # ⚠️ 默认值刻意留空:Windows PowerShell 5.1 在【参数绑定阶段】$PSScriptRoot 还没赋值,
  #    写成 (Join-Path $PSScriptRoot ...) 会当场报「Path 为空字符串」。故在主流程里再兜底。
  [string] $SourcePath = '',
  [string] $OutDir     = '',
  [ValidateSet('square', 'round')]
  [string] $Style      = 'square',
  # 圆角半径占边长的百分比。默认 12% —— 源图本就自带圆角,这里是「轻微再收一点」,不是从方块开始倒角。
  [double] $CornerPercent = 12,
  # 候选文件前缀。定稿时传 -Prefix '' 才会写成正式文件名。
  [string] $Prefix     = '_cand-',
  [switch] $Preview
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
# 控制台按 UTF-8 输出,否则中文提示在非 GBK 终端里是乱码(不影响产出,只影响可读性)
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$scriptDir = Split-Path -Parent $PSCommandPath
if (-not $SourcePath) { $SourcePath = Join-Path $scriptDir '..\icon.png' }
if (-not $OutDir)     { $OutDir     = Join-Path $scriptDir '..\build' }

# ICO 里要打包的四层。16/32/48 是 Windows 资源管理器与任务栏真正会取的尺寸,256 是大图标视图。
$IcoSizes = @(16, 32, 48, 256)
# 扩展 manifest 声明的四个尺寸 key(TODO #43 第 2 件事的备料;本脚本只生成,不接线)。
$ExtSizes = @(16, 32, 48, 128)

function New-EmptyBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bmp.SetResolution(96, 96)
  return $bmp
}

function New-HighQualityGraphics([System.Drawing.Bitmap]$target) {
  $g = [System.Drawing.Graphics]::FromImage($target)
  $g.CompositingMode    = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  return $g
}

function Copy-Scaled([System.Drawing.Bitmap]$src, [int]$size) {
  $dst = New-EmptyBitmap $size
  $g = New-HighQualityGraphics $dst
  $g.Clear([System.Drawing.Color]::Transparent)
  # WrapMode=TileFlipXY:双三次采样在边缘会去取图外像素,不钳住就会渗出一圈半透明鬼影。
  $attr = New-Object System.Drawing.Imaging.ImageAttributes
  $attr.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $g.DrawImage($src, $rect, 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attr)
  $attr.Dispose()
  $g.Dispose()
  return $dst
}

<#
  1028 → 16 一步到位的双三次会丢掉大量像素(采样核覆盖不到 64×64 里的绝大多数点),细笔画会断。
  故逐级折半到目标的 2 倍以内再做最后一次 —— 每级都是完整重采样,等效于面积平均,且完全确定性。
#>
function Resize-Progressive([System.Drawing.Bitmap]$src, [int]$size) {
  $cur = $src
  $owned = $false
  while ($cur.Width -ge ($size * 2) -and $cur.Width -gt $size) {
    $next = [int][Math]::Max($size, [Math]::Floor($cur.Width / 2))
    $tmp = Copy-Scaled $cur $next
    if ($owned) { $cur.Dispose() }
    $cur = $tmp
    $owned = $true
  }
  $out = Copy-Scaled $cur $size
  if ($owned) { $cur.Dispose() }
  return $out
}

function New-RoundedPath([int]$size, [double]$percent) {
  $r = [single]([Math]::Round($size * $percent / 100.0))
  if ($r -lt 1) { $r = [single]1 }
  $d = [single]($r * 2)
  $s = [single]$size
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc([single]0,      [single]0,      $d, $d, [single]180, [single]90)
  $path.AddArc([single]($s-$d), [single]0,      $d, $d, [single]270, [single]90)
  $path.AddArc([single]($s-$d), [single]($s-$d), $d, $d, [single]0,   [single]90)
  $path.AddArc([single]0,      [single]($s-$d), $d, $d, [single]90,  [single]90)
  $path.CloseFigure()
  return $path
}

# 渲染某一尺寸的成品位图。round 走「贴图刷 + 抗锯齿填充圆角路径」——
# 不用 SetClip 是因为剪裁边是硬边、16px 下会呈锯齿;FillPath 的边是抗锯齿的。
function Render-Icon([System.Drawing.Bitmap]$src, [int]$size, [string]$style, [double]$percent) {
  $flat = Resize-Progressive $src $size
  if ($style -eq 'square') { return $flat }

  $dst = New-EmptyBitmap $size
  $g = New-HighQualityGraphics $dst
  $g.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.TextureBrush($flat)
  $path = New-RoundedPath $size $percent
  $g.FillPath($brush, $path)
  $path.Dispose(); $brush.Dispose(); $g.Dispose(); $flat.Dispose()
  return $dst
}

function Save-Png([System.Drawing.Bitmap]$bmp, [string]$path) {
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  return (Get-Item $path).Length
}

function Get-BgraRows([System.Drawing.Bitmap]$bmp) {
  $rect = New-Object System.Drawing.Rectangle(0, 0, $bmp.Width, $bmp.Height)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $data.Stride
  $buf = New-Object byte[] ($stride * $bmp.Height)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buf, 0, $buf.Length)
  $bmp.UnlockBits($data)
  return @{ Bytes = $buf; Stride = $stride }
}

<#
  ICO 的一层可以是「PNG 整文件」也可以是「BMP DIB」。
  ⚠️ 刻意分开:256 用 PNG(否则单这一层就 256KB,且 Vista 起本就以 PNG 为常规做法),
  16/32/48 用 DIB —— NSIS 的安装器/卸载器图标嵌入路径对 PNG 压缩的小尺寸层历来最挑,
  用 DIB 是所有工具都认的那条路。
  DIB 布局:BITMAPINFOHEADER(biHeight = 2×高,含 AND 掩码那一半)+ 自下而上的 BGRA + 全 0 AND 掩码
  (32bpp 的透明由 alpha 通道表达,掩码留 0 即可)。
#>
function ConvertTo-IcoDib([System.Drawing.Bitmap]$bmp) {
  $size = $bmp.Width
  $src = Get-BgraRows $bmp
  $rowBytes = $size * 4
  $maskRow = [int]([Math]::Floor((($size + 31) / 32))) * 4   # 每行位掩码按 4 字节对齐
  $out = New-Object byte[] (40 + $rowBytes * $size + $maskRow * $size)
  $ms = New-Object System.IO.MemoryStream($out, $true)
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write([uint32]40)            # biSize
  $bw.Write([int32]$size)          # biWidth
  $bw.Write([int32]($size * 2))    # biHeight(XOR + AND)
  $bw.Write([uint16]1)             # biPlanes
  $bw.Write([uint16]32)            # biBitCount
  $bw.Write([uint32]0)             # biCompression = BI_RGB
  $bw.Write([uint32]($rowBytes * $size + $maskRow * $size))
  $bw.Write([int32]0); $bw.Write([int32]0)   # 分辨率(不写,避免引入环境相关值)
  $bw.Write([uint32]0); $bw.Write([uint32]0)
  for ($y = $size - 1; $y -ge 0; $y--) {
    $bw.Write($src.Bytes, $y * $src.Stride, $rowBytes)
  }
  # AND 掩码:全 0(out 已零初始化,直接跳过对应长度)
  $bw.Flush(); $bw.Dispose(); $ms.Dispose()
  # ⚠️ 前置逗号不可省:PowerShell 从函数 return 数组会【逐元素展开】成 Object[],
  #    调用方拿到的就不再是 byte[],BinaryWriter.Write 会选错重载、每层只写进 1 字节。
  return ,$out
}

function ConvertTo-PngBytes([System.Drawing.Bitmap]$bmp) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose()
  return ,$bytes
}

function Write-Ico([hashtable]$layers, [string]$path) {
  $sizes = $layers.Keys | Sort-Object
  $blobs = @()
  foreach ($s in $sizes) {
    $bmp = $layers[$s]
    if ($s -ge 256) { $blobs += ,@{ Size = $s; Data = (ConvertTo-PngBytes $bmp);  Kind = 'png' } }
    else            { $blobs += ,@{ Size = $s; Data = (ConvertTo-IcoDib $bmp);    Kind = 'dib' } }
  }
  $fs = [System.IO.File]::Create($path)
  $bw = New-Object System.IO.BinaryWriter($fs)
  $bw.Write([uint16]0)                 # reserved
  $bw.Write([uint16]1)                 # type = icon
  $bw.Write([uint16]$blobs.Count)
  $offset = 6 + 16 * $blobs.Count
  foreach ($b in $blobs) {
    $dim = if ($b.Size -ge 256) { 0 } else { $b.Size }   # 256 在目录项里写 0
    $bw.Write([byte]$dim); $bw.Write([byte]$dim)
    $bw.Write([byte]0); $bw.Write([byte]0)               # 调色板数 / 保留
    $bw.Write([uint16]1)                                 # planes
    $bw.Write([uint16]32)                                # bpp
    $bw.Write([uint32]$b.Data.Length)
    $bw.Write([uint32]$offset)
    $offset += $b.Data.Length
  }
  foreach ($b in $blobs) { $bw.Write([byte[]]$b.Data, 0, [int]$b.Data.Length) }
  $bw.Flush(); $bw.Dispose(); $fs.Dispose()
  return @{ Path = $path; Layers = ($blobs | ForEach-Object { "$($_.Size)/$($_.Kind)" }) -join ' ' ; Bytes = (Get-Item $path).Length }
}

# —— 样图:把位图按整数倍最近邻放大,让 16px 的实际像素肉眼可辨(不是「看起来更清楚」,是看清它糊没糊) ——
function Copy-Nearest([System.Drawing.Bitmap]$src, [int]$factor) {
  $dst = New-EmptyBitmap ($src.Width * $factor)
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  $g.DrawImage($src, 0, 0, $dst.Width, $dst.Height)
  $g.Dispose()
  return $dst
}

function New-Sheet([int]$width, [int]$height, [System.Drawing.Color]$bg) {
  $bmp = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bmp.SetResolution(96, 96)
  $g = New-HighQualityGraphics $bmp
  $g.Clear($bg)
  return @{ Bitmap = $bmp; Graphics = $g }
}

function Draw-Label([System.Drawing.Graphics]$g, [string]$text, [int]$x, [int]$y, [int]$pt, [System.Drawing.Color]$color) {
  $font = New-Object System.Drawing.Font('Segoe UI', $pt, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
  $brush = New-Object System.Drawing.SolidBrush($color)
  $g.DrawString($text, $font, $brush, [single]$x, [single]$y)
  $brush.Dispose(); $font.Dispose()
}

# ———————————————————————— 主流程 ————————————————————————

$SourcePath = (Resolve-Path $SourcePath).Path
$OutDir     = (Resolve-Path $OutDir).Path
$src = New-Object System.Drawing.Bitmap($SourcePath)
Write-Host "[icons] 源图: $SourcePath  $($src.Width)x$($src.Height)"

if (-not $Preview) {
  Write-Host "[icons] 风格: $Style" -NoNewline
  if ($Style -eq 'round') { Write-Host "  圆角半径: $CornerPercent% (= $([int][Math]::Round(256*$CornerPercent/100))px @256)" } else { Write-Host "  (源图自带圆角,不再裁切)" }

  # ① 主程序 ico:四层
  $layers = @{}
  foreach ($s in $IcoSizes) { $layers[$s] = Render-Icon $src $s $Style $CornerPercent }
  $icoPath = Join-Path $OutDir "$Prefix`icon-$Style.ico"
  $ico = Write-Ico $layers $icoPath
  Write-Host "[icons] ico  -> $($ico.Path)  层: $($ico.Layers)  $([Math]::Round($ico.Bytes/1KB,1))KB"

  # ② build/icon.png 的候选:512×512(⚠️ 尺寸不许改小 —— 它同时是扩展图标唯一源,
  #    且 scripts/build-extension.mjs 步骤 0c 断言正方形且边长 ≥128)
  $png512 = Render-Icon $src 512 $Style $CornerPercent
  $p = Join-Path $OutDir "$Prefix`icon-$Style-512.png"
  $n = Save-Png $png512 $p
  Write-Host "[icons] png  -> $p  512x512  $([Math]::Round($n/1KB,1))KB"
  $png512.Dispose()

  # ③ 扩展四个真实尺寸(TODO #43 第 2 件事的备料;本步只生成,接线留下一 Step)
  foreach ($s in $ExtSizes) {
    $bmp = if ($layers.ContainsKey($s)) { $layers[$s] } else { Render-Icon $src $s $Style $CornerPercent }
    $p = Join-Path $OutDir "$Prefix`icon-$Style-$s.png"
    $n = Save-Png $bmp $p
    Write-Host "[icons] png  -> $p  ${s}x${s}  $([Math]::Round($n/1KB,1))KB"
    if (-not $layers.ContainsKey($s)) { $bmp.Dispose() }
  }
  foreach ($s in $IcoSizes) { $layers[$s].Dispose() }
}
else {
  # ———— 定稿卡口用的三张样图 ————
  $styles = @('square', 'round')
  $r = @{}
  foreach ($st in $styles) {
    $r[$st] = @{}
    foreach ($s in @(16, 32, 48, 256)) { $r[$st][$s] = Render-Icon $src $s $st $CornerPercent }
  }

  $dark  = [System.Drawing.Color]::FromArgb(255, 32, 32, 32)
  $light = [System.Drawing.Color]::FromArgb(255, 243, 243, 243)
  $fgOnDark  = [System.Drawing.Color]::FromArgb(255, 235, 235, 235)
  $fgOnLight = [System.Drawing.Color]::FromArgb(255, 30, 30, 30)

  # 样图 1:圆角 vs 直角,同尺寸并排(256),浅底 + 深底各一行 —— 圆角只有在非纯色底上才看得出来
  $sheet = New-Sheet 660 700 $light
  Draw-Label $sheet.Graphics 'SQUARE (as-is)' 60 24 12 $fgOnLight
  Draw-Label $sheet.Graphics ("ROUND ($CornerPercent%)") 400 24 12 $fgOnLight
  $sheet.Graphics.DrawImage($r['square'][256], 40, 56, 256, 256)
  $sheet.Graphics.DrawImage($r['round'][256], 364, 56, 256, 256)
  $sheet.Graphics.FillRectangle((New-Object System.Drawing.SolidBrush($dark)), 0, 340, 660, 360)
  Draw-Label $sheet.Graphics 'SQUARE (as-is)' 60 356 12 $fgOnDark
  Draw-Label $sheet.Graphics ("ROUND ($CornerPercent%)") 400 356 12 $fgOnDark
  $sheet.Graphics.DrawImage($r['square'][256], 40, 388, 256, 256)
  $sheet.Graphics.DrawImage($r['round'][256], 364, 388, 256, 256)
  $p1 = Join-Path $OutDir "$Prefix`preview-compare.png"
  $sheet.Graphics.Dispose(); Save-Png $sheet.Bitmap $p1 | Out-Null; $sheet.Bitmap.Dispose()
  Write-Host "[icons] 样图1 圆角vs直角 -> $p1"

  # 样图 2:16px 放大 —— 上排是 16/32/48 的【真实大小】(判「任务栏里认不认得出」),
  #        下排是 16×16 最近邻放大 16 倍(判「糊没糊」)。左浅底右深底。
  $sheet = New-Sheet 900 370 $light
  $sheet.Graphics.FillRectangle((New-Object System.Drawing.SolidBrush($dark)), 450, 0, 450, 370)
  foreach ($col in @(0, 1)) {
    $x0 = 30 + $col * 450
    $fg = if ($col -eq 0) { $fgOnLight } else { $fgOnDark }
    Draw-Label $sheet.Graphics 'actual size: 16 / 32 / 48' $x0 20 10 $fg
    $sheet.Graphics.DrawImage($r['square'][16], $x0, 50, 16, 16)
    $sheet.Graphics.DrawImage($r['square'][32], ($x0 + 40), 42, 32, 32)
    $sheet.Graphics.DrawImage($r['square'][48], ($x0 + 96), 34, 48, 48)
    Draw-Label $sheet.Graphics 'round:' ($x0 + 180) 44 10 $fg
    $sheet.Graphics.DrawImage($r['round'][16], ($x0 + 240), 50, 16, 16)
    $sheet.Graphics.DrawImage($r['round'][32], ($x0 + 280), 42, 32, 32)
    $sheet.Graphics.DrawImage($r['round'][48], ($x0 + 336), 34, 48, 48)
    Draw-Label $sheet.Graphics '16px zoomed x12   [left square | right round]' $x0 110 10 $fg
    # ⚠️ 放大倍数受栏宽约束:每栏 450px 要并排放两张,x16(256px)会互相压住,故取 x12(192px)。
    $z1 = Copy-Nearest $r['square'][16] 12
    $z2 = Copy-Nearest $r['round'][16] 12
    $sheet.Graphics.DrawImage($z1, $x0, 140, 192, 192)
    $sheet.Graphics.DrawImage($z2, ($x0 + 205), 140, 192, 192)
    $z1.Dispose(); $z2.Dispose()
  }
  $p2 = Join-Path $OutDir "$Prefix`preview-16px.png"
  $sheet.Graphics.Dispose(); Save-Png $sheet.Bitmap $p2 | Out-Null; $sheet.Bitmap.Dispose()
  Write-Host "[icons] 样图2 16px放大   -> $p2"

  # 样图 3:256px 效果(ico 最大那层的原始大小,深浅底各一)
  $sheet = New-Sheet 600 320 $light
  $sheet.Graphics.FillRectangle((New-Object System.Drawing.SolidBrush($dark)), 300, 0, 300, 320)
  Draw-Label $sheet.Graphics '256px on light' 20 16 10 $fgOnLight
  Draw-Label $sheet.Graphics '256px on dark' 320 16 10 $fgOnDark
  $sheet.Graphics.DrawImage($r['square'][256], 22, 44, 256, 256)
  $sheet.Graphics.DrawImage($r['round'][256], 322, 44, 256, 256)
  $p3 = Join-Path $OutDir "$Prefix`preview-256.png"
  $sheet.Graphics.Dispose(); Save-Png $sheet.Bitmap $p3 | Out-Null; $sheet.Bitmap.Dispose()
  Write-Host "[icons] 样图3 256px效果  -> $p3  (左 square 右 round)"

  foreach ($st in $styles) { foreach ($s in @(16, 32, 48, 256)) { $r[$st][$s].Dispose() } }
}

$src.Dispose()
Write-Host '[icons] 完成。产出是确定性的:同一命令跑两次字节一致。'
