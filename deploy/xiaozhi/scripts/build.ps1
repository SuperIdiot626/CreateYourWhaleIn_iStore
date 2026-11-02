# 小智固件：编译 / 刷机 一键脚本
#
# 为什么要包装一层：
#   ESP-IDF 的环境变量只能由 export.bat 在「同一个 cmd 会话」里设置，
#   PowerShell 里直接调用没用。所以所有 IDF 命令都塞进一次 cmd /c 里跑。
#
# 用法：
#   .\build.ps1 build            # 只编译
#   .\build.ps1 flash            # 只刷机（需先 build）
#   .\build.ps1 build-flash      # 编译 + 刷机
#   .\build.ps1 backup           # 备份当前整片 flash（改配置前先跑）
#
# 可调环境变量：COM_PORT（默认 COM5）、SRC（固件源码目录）、IDF（IDF 目录）

param(
  [Parameter(Position = 0)]
  [ValidateSet('build', 'flash', 'build-flash', 'backup')]
  [string]$Action = 'build-flash'
)

$ErrorActionPreference = 'Stop'

$ComPort = if ($env:COM_PORT) { $env:COM_PORT } else { 'COM5' }
$Src     = if ($env:SRC) { $env:SRC } else { 'D:\Code\LittleWhale\DSH\work\xiaozhi-esp32' }
$Idf     = if ($env:IDF) { $env:IDF } else { 'D:\esp\esp-idf' }
$Board   = 'bread-compact-wifi'   # 面包板板型（0.91" 128×32 OLED）
$Baud    = '921600'

function Assert-Path($p, $what) {
  if (-not (Test-Path $p)) { throw "$what 不存在：$p" }
}
Assert-Path $Src '固件源码'
Assert-Path $Idf 'ESP-IDF'

# 备份：读整片 flash 到本地。板子一共 16MB。
function Invoke-Backup {
  $dir = 'D:\Code\LittleWhale\DSH\backup'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $stamp = Get-Date -Format 'yyyy-MM-dd-HHmm'
  $out = Join-Path $dir "xiaozhi-flash-$stamp.bin"
  Write-Host ">> 读整片 flash -> $out" -ForegroundColor Cyan
  py -3.10 -m esptool --port $ComPort -b $Baud --before default-reset --after hard-reset `
     read-flash 0 0x1000000 $out
  if ((Get-Item $out).Length -ne 16777216) { throw '备份大小不对，别继续' }
  Write-Host '>> 备份 OK（16MB）' -ForegroundColor Green
}

function Invoke-Build {
  Write-Host ">> 编译 $Board（首次会下载工具链和托管组件，比较久）" -ForegroundColor Cyan
  $cmd = "call `"$Idf\export.bat`" && cd /d `"$Src`" && python scripts\build.py $Board --name $Board"
  cmd /c $cmd
  if ($LASTEXITCODE -ne 0) { throw "编译失败（exit $LASTEXITCODE）" }
  Assert-Path (Join-Path $Src 'build\xiaozhi.bin') '编译产物 xiaozhi.bin'
  Write-Host '>> 编译 OK' -ForegroundColor Green
  Get-ChildItem (Join-Path $Src 'build\xiaozhi.bin'), (Join-Path $Src 'build\bootloader\bootloader.bin') |
    Select-Object Name, @{n='大小KB';e={[int]($_.Length/1KB)}} | Format-Table -AutoSize
}

function Invoke-Flash {
  $flashArgs = Join-Path $Src 'build\flash_args'
  Assert-Path $flashArgs 'build\flash_args（先跑 build）'

  # 先擦掉 app 分区再写：官方固件和我们的分区表一致，但擦干净能避免 ota 数据错乱
  Write-Host ">> 擦除 flash（保留 nvs 里的 WiFi 凭据）" -ForegroundColor Cyan
  py -3.10 -m esptool --chip esp32s3 --port $ComPort -b $Baud `
     --before default-reset --after no-reset erase-region 0x00010000 0x00F00000
  if ($LASTEXITCODE -ne 0) { throw "擦除失败（exit $LASTEXITCODE）" }

  Write-Host ">> 写入固件" -ForegroundColor Cyan
  Push-Location (Join-Path $Src 'build')
  try {
    $args = Get-Content $flashArgs -Raw
    cmd /c "call `"$Idf\export.bat`" && cd /d `"$Src\build`" && python -m esptool --chip esp32s3 -p $ComPort -b $Baud write-flash $args"
    if ($LASTEXITCODE -ne 0) { throw "写入失败（exit $LASTEXITCODE）" }
  } finally { Pop-Location }
  Write-Host '>> 刷机完成，板子会自动重启' -ForegroundColor Green
}

switch ($Action) {
  'backup'      { Invoke-Backup }
  'build'       { Invoke-Build }
  'flash'       { Invoke-Flash }
  'build-flash' { Invoke-Build; Invoke-Flash }
}
