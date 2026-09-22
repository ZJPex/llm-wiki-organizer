$ErrorActionPreference = 'Stop'

# 复用本机已验证的上游扫描器，避免依赖 WSL 的临时构建目录。
if (-not $env:ORGANIZER_RESCAN_BINARY) {
    $organizerVerifier = Join-Path $env:USERPROFILE '.llm-wiki-organizer\tools\organizer-upstream-rescan-e8082119-linux'
    if (Test-Path -LiteralPath $organizerVerifier -PathType Leaf) {
        $organizerDrive = $organizerVerifier.Substring(0, 1).ToLowerInvariant()
        $env:ORGANIZER_RESCAN_BINARY = '/mnt/' + $organizerDrive + $organizerVerifier.Substring(2).Replace('\', '/')
        $env:ORGANIZER_RESCAN_WSL_DISTRIBUTION = 'Ubuntu-24.04'
    }
}

& node (Join-Path $PSScriptRoot '..\src\server.mjs')
exit $LASTEXITCODE
