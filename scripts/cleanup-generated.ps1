# Preview or remove regenerable LightFrame build caches. Requires Windows PowerShell 5.1+ and Git.
# Stop development servers, builds, and tests in the selected checkouts before using -Apply.
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$AllWorktrees,
    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Keep this allowlist narrow: no source, dependencies, logs, app data, or global temp folders.
$generatedPaths = @('src-tauri/target', 'dist', 'dist-ssr', 'node_modules/.vite')
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Invoke-RepositoryGit {
    param([string]$Root, [string[]]$Arguments)
    $output = @(& git -C $Root @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Git failed in ${Root}: $($output -join ' ')"
    }
    return $output
}

function Assert-NoLinkedAncestors {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force
    while ($null -ne $item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Refusing linked path: $($item.FullName)"
        }
        $item = $item.Parent
    }
}

function Get-CommonGitDirectory {
    param([string]$Root)
    $path = (Invoke-RepositoryGit $Root @('rev-parse', '--git-common-dir')) -join ''
    if (-not [IO.Path]::IsPathRooted($path)) { $path = Join-Path $Root $path }
    return [IO.Path]::GetFullPath($path)
}

function Get-SafeTargetSize {
    param([string]$Root, [string]$RelativePath)
    if ($RelativePath -notin $generatedPaths) { throw 'Target is not allowlisted.' }
    $target = [IO.Path]::GetFullPath((Join-Path $Root $RelativePath))
    $prefix = $Root.TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
    if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Target escapes checkout: $target"
    }
    if (-not (Get-Item -LiteralPath $target -Force).PSIsContainer) {
        throw "Expected a directory: $target"
    }
    Assert-NoLinkedAncestors $target

    $tracked = @(Invoke-RepositoryGit $Root @('ls-files', '--', $RelativePath))
    if ($tracked.Count -gt 0) { throw "Refusing tracked files under: $target" }
    & git -C $Root check-ignore -q -- $RelativePath
    if ($LASTEXITCODE -ne 0) { throw "Target must be ignored by Git: $target" }

    # Walk explicitly so junctions and symlinks are rejected before traversing them.
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($target)
    [long]$bytes = 0
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        Assert-NoLinkedAncestors $directory
        foreach ($entry in Get-ChildItem -LiteralPath $directory -Force) {
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing linked content: $($entry.FullName)"
            }
            if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
            else { $bytes += $entry.Length }
        }
    }
    return $bytes
}

Assert-NoLinkedAncestors $repository
$top = [IO.Path]::GetFullPath(((Invoke-RepositoryGit $repository @('rev-parse', '--show-toplevel')) -join ''))
if ($top -ne $repository) { throw 'Script must live in the checkout scripts directory.' }
$package = Get-Content -LiteralPath (Join-Path $repository 'package.json') -Raw | ConvertFrom-Json
if ($package.name -ne 'lightframe') { throw 'Expected a LightFrame checkout.' }
$common = Get-CommonGitDirectory $repository
$roots = @($repository)
if ($AllWorktrees) {
    $listing = (Invoke-RepositoryGit $repository @('worktree', 'list', '--porcelain', '-z')) -join "`n"
    $roots = @($listing.Split([char]0) | Where-Object { $_.StartsWith('worktree ') } |
        ForEach-Object { [IO.Path]::GetFullPath($_.Substring(9)) } | Select-Object -Unique)
    if ($roots.Count -eq 0) { throw 'No registered worktrees found.' }
}

# Validate the complete plan before deleting anything, including across worktrees.
$plan = @(foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) {
        Write-Host "Skipping missing registered checkout: $root"
        continue
    }
    Assert-NoLinkedAncestors $root
    if ((Get-CommonGitDirectory $root) -ne $common) { throw "Unrelated checkout: $root" }
    foreach ($relative in $generatedPaths) {
        $target = [IO.Path]::GetFullPath((Join-Path $root $relative))
        if (-not (Test-Path -LiteralPath $target)) { continue }
        [pscustomobject]@{
            Root = $root
            RelativePath = $relative
            Path = $target
            Bytes = Get-SafeTargetSize $root $relative
        }
    }
})

if ($plan.Count -eq 0) { Write-Host 'No generated caches found.'; return }
foreach ($entry in $plan) {
    Write-Host ('{0,8:N2} GiB  {1}' -f ($entry.Bytes / 1GB), $entry.Path)
}
$total = ($plan | Measure-Object Bytes -Sum).Sum
Write-Host ('Eligible generated files: {0:N2} GiB.' -f ($total / 1GB))
if (-not $Apply) {
    Write-Host 'Preview only. Run again with -Apply to remove these caches after stopping builds and tests.'
    return
}

[long]$removed = 0
foreach ($entry in $plan) {
    if ($PSCmdlet.ShouldProcess($entry.Path, 'Remove generated cache')) {
        # Recheck links, containment, and tracked files immediately before each removal.
        $bytes = Get-SafeTargetSize $entry.Root $entry.RelativePath
        Remove-Item -LiteralPath $entry.Path -Recurse -Force -ErrorAction Stop
        $removed += $bytes
        Write-Host "Removed: $($entry.Path)"
    }
}
Write-Host ('Removed approximately {0:N2} GiB of generated files.' -f ($removed / 1GB))
