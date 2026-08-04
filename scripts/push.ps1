# One-command publish. Run it via push.bat (double-click, or `push.bat "message"`).
#
# Does the whole dance: commit, sync with the remote, push, and optionally cut a version tag
# that triggers the multi-OS installer build.
#
# The tag is created on the REMOTE distrib head rather than locally, on purpose. Switching
# branches in this folder makes OneDrive lock files and git starts asking "Deletion of
# directory failed, try again?" in a loop. Talking to GitHub directly avoids ever needing a
# local branch switch.

[CmdletBinding()]
param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]] $Message,

    # Skip the "build installers?" question and just push.
    [switch] $NoBuild,

    # Cut a release without being asked.
    [switch] $Release
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$VersionLog = Join-Path $repo 'version.log'
$Remote = 'arnavaggarwal-dev/unblocked-games'

function Say  ($t) { Write-Host $t -ForegroundColor Cyan }
function Ok   ($t) { Write-Host $t -ForegroundColor Green }
function Warn ($t) { Write-Host $t -ForegroundColor Yellow }
function Die  ($t) { Write-Host $t -ForegroundColor Red; exit 1 }

# Runs a native command and judges success ONLY by its exit code.
#
# Necessary because git and gh write ordinary progress and warnings to stderr ("LF will be
# replaced by CRLF", "Enumerating objects..."). With $ErrorActionPreference = 'Stop', merging
# that stream via 2>&1 makes PowerShell raise NativeCommandError on a perfectly successful
# command. Dropping to 'Continue' for the duration of the call is the fix.
function Invoke-Native {
    param([string] $Exe, [string[]] $Arguments, [switch] $Quiet)

    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $Exe @Arguments 2>&1 | ForEach-Object { $_.ToString() }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }

    if ($code -ne 0) {
        if (-not $Quiet) { Write-Host ($out -join "`n") -ForegroundColor Red }
        return @{ Ok = $false; Output = $out }
    }
    return @{ Ok = $true; Output = $out }
}

function Invoke-Git {
    $r = Invoke-Native -Exe 'git' -Arguments $args
    if (-not $r.Ok) { Die "git $($args -join ' ') failed." }
    return $r.Output
}

# --- sanity ------------------------------------------------------------------

if (-not (Test-Path (Join-Path $repo '.git'))) { Die "Not a git repository: $repo" }

$branch = (& git rev-parse --abbrev-ref HEAD).Trim()
Say "Repo:   $repo"
Say "Branch: $branch"

if ($repo -like '*OneDrive*') {
    Warn 'Heads up: this folder is inside OneDrive, which sometimes locks files mid-push.'
    Warn 'If it stalls, pause OneDrive syncing and re-run.'
}

# --- commit ------------------------------------------------------------------

# --- validate workflows ------------------------------------------------------
# Before anything is committed. A malformed workflow file is not rejected by GitHub with an
# obvious error - it simply never runs - so it is worth catching here.

if (Test-Path (Join-Path $repo 'node_modules')) {
    Say "`nChecking workflow YAML ..."
    $wf = Invoke-Native -Exe 'node' -Arguments @('scripts/check-workflows.mjs')
    if (-not $wf.Ok) {
        Write-Host ($wf.Output -join "`n") -ForegroundColor Red
        Die "Workflow YAML is invalid. Fix it before pushing (nothing has been committed)."
    }
    Ok "Workflows valid."
} else {
    Warn "Skipping workflow check (run 'npm install' to enable it)."
}

# --- commit ------------------------------------------------------------------

$dirty = & git status --porcelain
if ($dirty) {
    $count = ($dirty | Measure-Object -Line).Lines
    Say "`n$count changed file(s):"
    $dirty | Select-Object -First 15 | ForEach-Object { Write-Host "   $_" }
    if ($count -gt 15) { Write-Host "   ... and $($count - 15) more" }

    $msg = if ($Message) { $Message -join ' ' } else { '' }
    if (-not $msg) {
        $msg = Read-Host "`nCommit message (blank = 'update')"
        if (-not $msg) { $msg = 'update' }
    }

    Invoke-Git add -A | Out-Null
    Invoke-Git commit -m $msg | Out-Null
    Ok "Committed: $msg"
} else {
    Say "`nNothing to commit."
}

# --- push --------------------------------------------------------------------

# Rebase first so a remote-ahead branch doesn't reject the push. This is exactly the
# "Updates were rejected because the remote contains work you do not have" case.
Say "`nSyncing with origin/$branch ..."
$pull = Invoke-Native -Exe 'git' -Arguments @('pull', '--rebase', 'origin', $branch)
if (-not $pull.Ok) {
    Die "Pull/rebase failed. Resolve it by hand, then re-run:`n  git status"
}

$ahead = (& git rev-list --count "origin/$branch..HEAD").Trim()
if ($ahead -eq '0') {
    Say "Nothing new to push."
} else {
    Say "Pushing $ahead commit(s) ..."
    Invoke-Git push origin $branch | Out-Null
    Ok "Pushed to origin/$branch"
}

if ($branch -eq 'main') {
    Ok "`nGitHub will now merge main into distrib automatically, then vendor any new assets."
}

# --- release -----------------------------------------------------------------

if ($NoBuild) { Say "`nDone (skipping build)."; exit 0 }

if (-not $Release) {
    $answer = Read-Host "`nBuild installers for Windows/macOS/Linux? This takes ~20 min on GitHub. (y/N)"
    if ($answer -notmatch '^[Yy]') { Ok "`nDone. No build started."; exit 0 }
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Die "The GitHub CLI (gh) is required to cut a release. Install it, or tag manually."
}

# Next version comes from version.log - a local-only record, deliberately gitignored so it
# never causes a merge conflict between branches.
$last = 'v1.0.0'
if (Test-Path $VersionLog) {
    $found = Select-String -Path $VersionLog -Pattern 'v(\d+)\.(\d+)\.(\d+)' -AllMatches |
             ForEach-Object { $_.Matches } | Select-Object -Last 1
    if ($found) { $last = $found.Value }
}
$parts = $last.TrimStart('v').Split('.')
$next = 'v{0}.{1}.{2}' -f $parts[0], $parts[1], ([int]$parts[2] + 1)

Say "`nLast released: $last  ->  new tag: $next"
$custom = Read-Host "Press Enter to accept, or type a different tag"
if ($custom) { $next = $custom.Trim() }
if ($next -notmatch '^v\d+\.\d+\.\d+$') { Die "Tag must look like v1.2.3 (got '$next')." }

# If we just pushed main, the sync workflow needs a moment to merge it into distrib -
# otherwise the tag would point at a commit from before the new game landed.
if ($branch -eq 'main') {
    Say "Waiting for the sync workflow to merge main into distrib ..."
    Start-Sleep -Seconds 20
    for ($i = 0; $i -lt 20; $i++) {
        $r = Invoke-Native -Exe 'gh' -Arguments @(
            'run', 'list', '--repo', $Remote, '--workflow', 'Sync main into distrib',
            '--status', 'in_progress', '--json', 'databaseId', '--jq', 'length'
        ) -Quiet
        if (-not $r.Ok) { break }
        if (($r.Output -join '').Trim() -eq '0') { break }
        Start-Sleep -Seconds 15
    }
}

$shaResult = Invoke-Native -Exe 'gh' -Arguments @('api', "repos/$Remote/git/ref/heads/distrib", '--jq', '.object.sha') -Quiet
if (-not $shaResult.Ok -or -not $shaResult.Output) {
    Die "Could not read the distrib branch on GitHub. Is it pushed?"
}
$sha = ($shaResult.Output -join '').Trim()
$short = $sha.Substring(0, 7)

Say "Tagging distrib@$short as $next ..."
$tag = Invoke-Native -Exe 'gh' -Arguments @(
    'api', '-X', 'POST', "repos/$Remote/git/refs",
    '-f', "ref=refs/tags/$next", '-f', "sha=$sha"
) -Quiet
if (-not $tag.Ok) { Die "Could not create tag $next - does it already exist? Try a different one." }

$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Add-Content -Path $VersionLog -Encoding utf8 -Value "$stamp  $next  distrib@$($sha.Substring(0,7))"

Ok "`nBuild started for $next"
Write-Host "  Progress: https://github.com/$Remote/actions"
Write-Host "  Installers appear at: https://github.com/$Remote/releases/tag/$next"
Write-Host "`n  Watch from here with:  gh run watch"
