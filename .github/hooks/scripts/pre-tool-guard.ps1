# Pre-Tool-Use hook for the WikiSapMapper agent
# ---------------------------------------------
# Enforces, at the Agency CLI level, what wiki-sap-mapping.agent.md's
# Safety Rules state in prose: the agent may write ONLY under
# `AAAP_CodeWiki/General/` or `out/`, and may NOT push to or force-push
# any branch.
#
# Input  (stdin) : JSON `{ toolName, toolArgs|toolInput, ... }`
# Output (stdout): nothing  → allow
#                  `{"permissionDecision":"deny",
#                    "permissionDecisionReason":"..."}` → block
# Exit code      : always 0 (the deny is communicated via JSON body,
#                  per the Claude/Copilot preToolUse contract).
#
# Reference impl: One/Sentinel-TiE2E/.github/hooks/scripts/pre-tool-guard.ps1
# Doc reference : eng.ms .../session-manager/copilot-remote-approvals-plan

$ErrorActionPreference = 'Stop'

$raw = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }

try {
    $req = $raw | ConvertFrom-Json
} catch {
    # Malformed payload — fall through (allow). Logging only.
    [Console]::Error.WriteLine("[pre-tool-guard] non-JSON payload, allowing: $($_.Exception.Message)")
    exit 0
}

# ------------ Allowed write roots (repo-root relative) ------------
# `out/` is the agent's working scratch tree (gitignored).
# `$publishDir/` is where the published Wiki ↔ SAP Mapping pages live in
# the code wiki tree — the only spot in AAAP_CodeWiki/ the agent is
# allowed to touch. Everything else under AAAP_CodeWiki/ (other Draft/
# folders, the rest of the wiki) remains read-only.
#
# $publishDir is sourced from the pipeline variable PUBLISH_PARENT_DIR
# (defined in wiki-sap-mapping-pipeline.yml). Hardcoded fallback is used
# when the script is run locally outside the pipeline.
$publishDir = $env:PUBLISH_PARENT_DIR
if (-not $publishDir) { $publishDir = 'AAAP_CodeWiki/General' }
$publishDir = $publishDir.TrimEnd('/') + '/'
$ALLOWED_PREFIXES = @('out/', $publishDir)

# Tools that write files. Agency / Copilot / Claude all use different
# tool names for the same write-file capability; cover the full set.
# Note: Agency's newer schema namespaces these as `edit/editFiles` etc.,
# but the toolName forwarded on the wire is still the leaf name
# (`editFiles`). We match against both shapes defensively.
$WRITE_TOOLS = @(
    'edit', 'create', 'editFiles', 'edit/editFiles', 'edit/edit', 'edit/create',
    'str_replace_editor', 'str_replace_based_edit_tool', 'write', 'Edit', 'Write'
)

# Tools that execute shell commands
$SHELL_TOOLS = @(
    'bash', 'powershell', 'shell', 'execute', 'execute/execute', 'Bash'
)

# ------------ Helpers ------------
function Write-Deny([string]$reason) {
    @{ permissionDecision = 'deny'; permissionDecisionReason = $reason } |
        ConvertTo-Json -Compress
    exit 0
}

function Get-RepoRoot {
    try {
        $r = (& git rev-parse --show-toplevel 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($r)) {
            return [IO.Path]::GetFullPath($r.Trim()).TrimEnd('\','/')
        }
    } catch {}
    return [IO.Path]::GetFullPath((Get-Location).Path).TrimEnd('\','/')
}

function Resolve-Rel([string]$p, [string]$cwd, [string]$root) {
    if ([string]::IsNullOrWhiteSpace($p)) { return $null }
    $p = $p.Trim().Trim('"').Trim("'")
    try {
        $abs = if ([IO.Path]::IsPathRooted($p)) { $p } else { Join-Path $cwd $p }
        $abs = [IO.Path]::GetFullPath($abs)
        if ($abs.Length -le $root.Length) { return $null }
        if (-not $abs.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { return $null }
        return $abs.Substring($root.Length).TrimStart('\','/').Replace('\','/')
    } catch { return $null }
}

function Test-AllowedWrite([string]$relPath) {
    if (-not $relPath) { return $false }
    foreach ($pre in $ALLOWED_PREFIXES) {
        if ($relPath.StartsWith($pre, [StringComparison]::OrdinalIgnoreCase) -or
            $relPath -eq $pre.TrimEnd('/')) { return $true }
    }
    return $false
}

# The agent's tool_input is sometimes a JSON string, sometimes a parsed object.
function Get-ArgsObj($x) {
    if ($null -eq $x) { return $null }
    if ($x -is [string]) {
        if ([string]::IsNullOrWhiteSpace($x)) { return $null }
        try { return $x | ConvertFrom-Json } catch { return $null }
    }
    return $x
}

# ------------ Inputs ------------
$toolName = [string]$req.toolName
$argsObj  = Get-ArgsObj $req.toolArgs
if ($null -eq $argsObj) { $argsObj = Get-ArgsObj $req.toolInput }   # Copilot name
if ($null -eq $argsObj) { exit 0 }   # nothing to inspect → allow

$root = Get-RepoRoot
$cwd  = [IO.Path]::GetFullPath((Get-Location).Path).TrimEnd('\','/')

# ------------ File-write tools ------------
if ($toolName -in $WRITE_TOOLS) {
    # The target path key varies by tool ("path", "filePath", "file_path").
    $cand = $argsObj.path
    if (-not $cand) { $cand = $argsObj.filePath }
    if (-not $cand) { $cand = $argsObj.file_path }
    if (-not $cand) { exit 0 }   # unknown shape → allow (don't false-block)

    $rel = Resolve-Rel ([string]$cand) $cwd $root
    if (-not $rel) {
        Write-Deny "WikiSapMapper agent is not allowed to write outside the repo. Attempted target: $cand"
    }
    if (-not (Test-AllowedWrite $rel)) {
        Write-Deny "WikiSapMapper agent is only allowed to write under $($ALLOWED_PREFIXES -join ' or '). Attempted: $rel"
    }
    exit 0
}

# ------------ Shell-execution tools ------------
if ($toolName -in $SHELL_TOOLS) {
    $cmd = [string]$argsObj.command
    if (-not $cmd) { $cmd = [string]$argsObj.script }
    if (-not $cmd) { exit 0 }

    # 1. Block git push / force-push (the agent must NOT push manually —
    #    Agency framework owns commit + branch + PR).
    if ($cmd -match '(?im)\bgit\s+(?:\S+\s+)*push\b') {
        Write-Deny "WikiSapMapper agent must not run 'git push' — Agency owns commit/branch/PR. Command: $cmd"
    }

    # 2. Scan for write redirections / mutation commands referencing paths
    #    outside our allowlist.
    $writePatterns = @(
        '(?im)(?:^|[;&|`n])\s*[^#]*?(?:>|>>)\s*(?<path>"[^"]+"|''[^'']+''|[^\s;&|]+)',
        '(?im)\b(?:Out-File|Set-Content|Add-Content|New-Item|Remove-Item)\b[^;|`n]*?\s-(?:FilePath|Path|LiteralPath)\s+(?<path>"[^"]+"|''[^'']+''|[^\s;|]+)',
        '(?im)\b(?:Copy-Item|Move-Item)\b[^;|`n]*?\s-Destination\s+(?<path>"[^"]+"|''[^'']+''|[^\s;|]+)',
        '(?im)\b(?:cp|mv)\b\s+(?:"[^"]+"|''[^'']+''|[^\s;|]+)\s+(?<path>"[^"]+"|''[^'']+''|[^\s;|]+)',
        '(?im)\b(?:rm|rmdir|touch|mkdir)\b(?:\s+-[^\s]+)*\s+(?<path>"[^"]+"|''[^'']+''|[^\s;|]+)',
        '(?im)\btee\b(?:\s+-a)?\s+(?<path>"[^"]+"|''[^'']+''|[^\s;|]+)'
    )

    foreach ($pat in $writePatterns) {
        foreach ($m in [regex]::Matches($cmd, $pat)) {
            $p = $m.Groups['path'].Value.Trim('"').Trim("'")
            if (-not $p) { continue }
            if ($p -match '^(?:/dev/null|NUL|\$null|&\d+)$') { continue }
            if ($p -match '^(~|\$HOME|\$\{HOME\}|\$env:|%[^%]+%)') {
                Write-Deny "WikiSapMapper agent: shell write target uses unresolved expansion: $p"
            }
            $rel = Resolve-Rel $p $cwd $root
            if (-not $rel) {
                Write-Deny "WikiSapMapper agent: shell command writes outside the repo: $p"
            }
            if (-not (Test-AllowedWrite $rel)) {
                Write-Deny "WikiSapMapper agent: shell command writes outside allowed dirs ($($ALLOWED_PREFIXES -join ', ')). Target: $rel"
            }
        }
    }
    exit 0
}

# Any other tool (read, search, list_directory, etc.) → allow
exit 0
