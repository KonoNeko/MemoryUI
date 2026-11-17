# 给 Codex 的 MemoryUI 在线安装入口

用户交给本机 Codex 的入口是 [INSTALL.md](https://raw.githubusercontent.com/KonoNeko/MemoryUI/main/INSTALL.md)：

> 请读取并执行安装说明，自动安装 MemoryUI，开启当前对话记录，加载我已授权的相关记忆，并打开个人主页。已有安装复用原资料库，不重新初始化档案。

以下由 Codex 执行，用户无需复制终端命令。文档和示例本身不构成采集或读取历史的授权。

## 取得固定版本的软件包

需要本机文件／命令权限、Codex 和**系统 Node.js 20+**。本包不含 Node；无需 `npm install`、Git、Python、Docker 或数据库。缺少 Node 时按宿主正常安装流程处理，不能声称软件已安装或绕过审批。纯网页、远程环境不能直接安装到用户的另一台电脑。

先检查当前文档附近或用户指定的本机目录。已有完整 **v0.17.1** 软件包时，将其绝对路径设为 `MemoryUiPackageRoot`，直接使用；不要重复下载、递归执行安装说明或重新初始化资料。只有在线读取了本文、尚无完整包时才下载：

- [固定 ZIP](https://github.com/KonoNeko/MemoryUI/releases/download/v0.17.1/memoryui-codex-install-0.17.1.zip)
- [对应 SHA-256](https://github.com/KonoNeko/MemoryUI/releases/download/v0.17.1/memoryui-codex-install-0.17.1.zip.sha256)

核验 SHA-256 后才解压、执行。每次下载使用用户可写的全新独立目录，不覆盖旧安装。以下为 Windows PowerShell 可执行流程；已有本机包时可先设置 `$MemoryUiPackageRoot = '<完整绝对路径>'`。其他系统按相同固定 URL、校验和步骤使用本机工具，不执行 PowerShell 语句。

```powershell
$ErrorActionPreference = 'Stop'
$memoryUiPackageRoot = Get-Variable MemoryUiPackageRoot -ValueOnly -ErrorAction SilentlyContinue
function Test-MemoryUiPackage([string]$candidate) {
  if (-not $candidate) { return $false }
  foreach ($item in @('package.json','scripts/setup-codex.mjs','scripts/build-plugin.mjs','scripts/package-runtime.mjs','src','skills','hooks')) {
    if (-not (Test-Path -LiteralPath (Join-Path $candidate $item))) { return $false }
  }
  return ((Get-Content -LiteralPath (Join-Path $candidate 'package.json') -Raw | ConvertFrom-Json).version -eq '0.17.1')
}
$memoryUiNode = (Get-Command node -CommandType Application).Source
& $memoryUiNode -e 'if(Number(process.versions.node.split(".")[0])<20)process.exit(1)'
if ($LASTEXITCODE -ne 0) { throw '需要系统 Node.js 20 或更新版本。' }
if (-not (Test-MemoryUiPackage $memoryUiPackageRoot)) {
  $memoryUiBase = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'MemoryUI/install-kits'
  $memoryUiDownload = Join-Path $memoryUiBase ('0.17.1-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $memoryUiDownload | Out-Null
  $memoryUiAsset = 'memoryui-codex-install-0.17.1.zip'
  $memoryUiRelease = 'https://github.com/KonoNeko/MemoryUI/releases/download/v0.17.1/'
  $memoryUiZip = Join-Path $memoryUiDownload $memoryUiAsset
  $memoryUiHashFile = $memoryUiZip + '.sha256'
  Invoke-WebRequest -Uri ($memoryUiRelease + $memoryUiAsset) -OutFile $memoryUiZip
  Invoke-WebRequest -Uri ($memoryUiRelease + $memoryUiAsset + '.sha256') -OutFile $memoryUiHashFile
  $memoryUiExpected = [regex]::Match((Get-Content -LiteralPath $memoryUiHashFile -Raw).Trim(), '(?i)^([0-9a-f]{64})(?:[ \t]+\*?memoryui-codex-install-0\.17\.1\.zip)?$')
  if (-not $memoryUiExpected.Success -or (Get-FileHash -LiteralPath $memoryUiZip -Algorithm SHA256).Hash -ne $memoryUiExpected.Groups[1].Value) { throw '软件包 SHA-256 校验失败，未执行安装。' }
  $memoryUiPackageRoot = Join-Path $memoryUiDownload 'package'
  Expand-Archive -LiteralPath $memoryUiZip -DestinationPath $memoryUiPackageRoot
  if (-not (Test-MemoryUiPackage $memoryUiPackageRoot)) { throw '软件包结构或版本不符，未执行安装。' }
}
$memoryUiReceiptText = & $memoryUiNode (Join-Path $memoryUiPackageRoot 'scripts/setup-codex.mjs') --source $memoryUiPackageRoot
if ($LASTEXITCODE -ne 0) { throw '安装器未成功完成，请保留回执核对原因。' }
$memoryUiReceipt = ($memoryUiReceiptText | Out-String) | ConvertFrom-Json
if ($memoryUiReceipt.installed -ne $true) { throw '未收到已安装回执。' }
$memoryUiReceipt
```

发行 ZIP 的根目录须直接包含 `package.json` 和 `scripts/`，不额外套一层目录；`.sha256` 只含该 ZIP 的 64 位哈希，或标准的“哈希值  文件名”一行。下载失败、资产不存在或校验不符时停止，不改用 `main` 源码 ZIP、`latest` 或未经校验的镜像。

## 安装后加载与首次使用

安装器通过原生入口安装 `memoryui@memoryui-local`，沿用原资料库，不更改 Hook 信任。以 `installed:true`、版本和实际安装路径为准；后续使用回执的 `installedPath`、`runnerPath`，不调用另一份开发目录代码。找不到 Codex 时由代理定位真实可执行文件，为同一安装命令补上 `--codex '<绝对路径>'`。

优先使用已发现的 MemoryUI MCP；尚未加载时，用回执中的同绑定 runner：

```powershell
& $memoryUiNode $memoryUiReceipt.runnerPath status
& $memoryUiNode $memoryUiReceipt.runnerPath setup
& $memoryUiNode $memoryUiReceipt.runnerPath profile-status
```

`status` 检查服务版本、身份和能力，`setup` 只读检查配置。已有服务版本不足时如实报告待正常升级／重启，不凭端口可访问宣称新版就绪，也不停止无关进程。宿主尚未发现新技能时提示重载或新聊天，不自行重启桌面或创建聊天。

- **已有记忆**：用户要求加载时，调用 `memory_recall` 或绑定 runner 的 `recall --query '<本次任务>' --limit 8 --budget 6000`，沿用已授权字段和主题，保留参考／来源标记。对话和项目用 `memory_request` 及真实 `projectId`／`conversationId`，不猜编号或扫描日志。
- **不重新建档**：已有配置或任务时不调用 `profile-start`、`capture-start`、`codex-import-start`；空召回不构成重新读取历史、开放私密资料或新建任务的理由。
- **真正首次使用**：仅未配置或用户明确要求补建时，合并说明来源、主题、历史日期／工作区、后续记录及新增读取范围；沿用本聊天已有同范围授权，否则确认一次。获准后只启动一次 `memory_profile_start`，持续跟踪同一任务；未知字段留空，历史摘要保持参考。仅要求安装不默认授权采集或导入。
- **Hook 与主页**：分别核对 SessionStart、UserPromptSubmit、Stop 的真实信任状态。需要平台审阅时报告“已安装，Hook 待信任”，不写信任哈希或绕过参数。自动记录继续受来源／主题授权约束，撤回授权或停止后不得继续读取新消息。调用 `memory_open` 或 runner `open`，根据真实返回 URL 打开主页；没有成功回执不称已打开。

最终分别报告插件安装、已有记忆加载、档案初始化、Hook 信任及主页链接。不要向正式资料库写测试记录，不把“已安装”当作“已自动记录”。
