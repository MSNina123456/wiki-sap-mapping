# .update.ps1 — Sync session-state to GitHub repo MSNina123456/wiki-sap-mapping
#
# Usage:
#   & 'C:\Users\nali2\wsm-push-staging\.update.ps1'
#   (or cd into staging and run: .\.update.ps1)
#
# What it does:
#   1. Mirrors the session-state wiki-sap-mapping/ folder into this staging dir
#      (excludes session-internal files + smoke files; preserves .git/ and this script).
#   2. Shows git diff summary.
#   3. Asks for a commit message; commits and pushes to origin/main.

$ErrorActionPreference = 'Stop'

$src   = 'C:\Users\nali2\.copilot\session-state\e75e5758-24ab-4992-bb60-fe443be6b375\files\wiki-sap-mapping'
$stage = 'C:\Users\nali2\wsm-push-staging'

# Files to NEVER push to GitHub (session-internal + retired smoke files)
$exclude = @(
    'OVERVIEW.md',
    '_resume.md',
    '_decisions-log.md',
    '_tunables-and-paths.md',
    '_known-issues-and-howto.md',
    '_progress.md',
    '_review.md',
    'smoke-pipeline.yml',
    'smoke.agent.md',
    '.update.ps1'
)

# 1. Mirror session-state → staging
#    /MIR  = mirror (delete files in dst not present in src)
#    /XD   = exclude these directories
#    /XF   = exclude these filenames (anywhere in tree)
#    /NFL /NDL /NJH /NJS = quieter output
Write-Host "==== Mirroring session-state -> staging ====" -ForegroundColor Cyan
robocopy $src $stage /MIR /XD ".git" /XF $exclude /NFL /NDL /NJH /NJS
$rc = $LASTEXITCODE
if ($rc -ge 8) {
    Write-Host "##[error]robocopy failed with exit code $rc" -ForegroundColor Red
    return
}
Write-Host "robocopy OK (exit $rc)" -ForegroundColor Green
Write-Host ""

# 2. Show what changed in git
Set-Location $stage
$status = git status --short
if (-not $status) {
    Write-Host "==== No changes - staging matches GitHub ====" -ForegroundColor Yellow
    return
}

Write-Host "==== Git changes detected ====" -ForegroundColor Cyan
$status | ForEach-Object { Write-Host "  $_" }
Write-Host ""

# 3. Commit and push
$msg = Read-Host "Commit message (Enter for default)"
if (-not $msg -or $msg.Trim() -eq '') {
    $msg = "Update $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
}

git add -A
git commit -m $msg
git push

Write-Host ""
Write-Host "Pushed to GitHub: https://github.com/MSNina123456/wiki-sap-mapping" -ForegroundColor Green
