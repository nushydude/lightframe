# Exercise deletion boundaries in disposable fixtures, never in real project caches.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'cleanup-generated.ps1'
$temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixture = Join-Path $temporary ('lightframe-cleanup-test-' + [guid]::NewGuid().ToString('N'))
$shell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$junctions = New-Object 'System.Collections.Generic.List[string]'
$cases = 0

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Write-FixtureFile {
    param([string]$Path, [string]$Content = 'fixture')
    $null = New-Item -ItemType Directory -Path (Split-Path $Path -Parent) -Force
    [IO.File]::WriteAllText($Path, $Content)
}

function Invoke-FixtureGit {
    param([string]$Root, [string[]]$Arguments)
    $output = @(& git -C $Root @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Fixture Git failed: $($output -join ' ')" }
    return $output
}

function New-FixtureRepository {
    param([string]$Name, [string]$Ignore = "src-tauri/target/`ndist/`ndist-ssr/`nnode_modules/`nlogs/`n.codex/`n")
    $root = Join-Path $fixture $Name
    Write-FixtureFile (Join-Path $root 'package.json') '{"name":"lightframe"}'
    Write-FixtureFile (Join-Path $root '.gitignore') $Ignore
    Write-FixtureFile (Join-Path $root 'src/keep.txt') 'source'
    $null = New-Item -ItemType Directory -Path (Join-Path $root 'scripts') -Force
    Copy-Item -LiteralPath $source -Destination (Join-Path $root 'scripts/cleanup-generated.ps1')
    $null = Invoke-FixtureGit $root @('init', '-q')
    $null = Invoke-FixtureGit $root @('config', 'user.email', 'cleanup-test@example.invalid')
    $null = Invoke-FixtureGit $root @('config', 'user.name', 'Cleanup fixture')
    $null = Invoke-FixtureGit $root @('add', '.')
    $null = Invoke-FixtureGit $root @('commit', '-qm', 'Fixture source')
    return $root
}

function Add-Caches {
    param([string]$Root)
    foreach ($path in @('src-tauri/target', 'dist', 'dist-ssr', 'node_modules/.vite')) {
        Write-FixtureFile (Join-Path $Root "$path/nested/cache.bin")
    }
}

function Invoke-Cleanup {
    param([string]$Root, [string[]]$Arguments = @(), [int]$ExpectedExit = 0)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts/cleanup-generated.ps1') @Arguments 2>&1)
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previous }
    if ($code -ne $ExpectedExit) { throw "Unexpected cleanup exit ${code}: $($output -join "`n")" }
    return $output -join "`n"
}

try {
    $root = New-FixtureRepository 'checkout with spaces'
    Add-Caches $root
    Write-FixtureFile (Join-Path $root 'src/uncommitted.txt') 'unfinished work'
    Write-FixtureFile (Join-Path $root 'logs/test.log') 'evidence'
    Write-FixtureFile (Join-Path $root '.codex/notes.txt') 'agent notes'
    Write-FixtureFile (Join-Path $root 'node_modules/library/index.js') 'dependency'
    $before = (Invoke-FixtureGit $root @('status', '--porcelain')) -join "`n"
    $head = (Invoke-FixtureGit $root @('rev-parse', 'HEAD')) -join ''
    $null = Invoke-Cleanup $root
    Assert-True (Test-Path -LiteralPath (Join-Path $root 'src-tauri/target/nested/cache.bin')) 'Default preview deleted files.'
    $cases++
    $null = Invoke-Cleanup $root @('-Apply', '-WhatIf')
    Assert-True (Test-Path -LiteralPath (Join-Path $root 'dist/nested/cache.bin')) 'WhatIf deleted files.'
    $cases++
    $null = Invoke-Cleanup $root @('-Apply')
    foreach ($path in @('src-tauri/target', 'dist', 'dist-ssr', 'node_modules/.vite')) {
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $root $path))) "Cache not removed: $path"
    }
    foreach ($path in @('src/keep.txt', 'src/uncommitted.txt', 'logs/test.log', '.codex/notes.txt', 'node_modules/library/index.js', '.git')) {
        Assert-True (Test-Path -LiteralPath (Join-Path $root $path)) "Protected file removed: $path"
    }
    Assert-True (((Invoke-FixtureGit $root @('status', '--porcelain')) -join "`n") -eq $before) 'Git working state changed.'
    Assert-True (((Invoke-FixtureGit $root @('rev-parse', 'HEAD')) -join '') -eq $head) 'Commit changed.'
    $cases++

    $linked = Join-Path $fixture 'linked checkout with spaces'
    $null = Invoke-FixtureGit $root @('worktree', 'add', '-q', '-b', 'fixture-linked', $linked)
    Add-Caches $root
    Add-Caches $linked
    Write-FixtureFile (Join-Path $linked 'src/uncommitted.txt') 'linked unfinished work'
    $linkedBefore = (Invoke-FixtureGit $linked @('status', '--porcelain')) -join "`n"
    $preview = Invoke-Cleanup $root @('-AllWorktrees')
    Assert-True ($preview.Contains($linked)) 'Registered linked worktree omitted from preview.'
    Assert-True (Test-Path -LiteralPath (Join-Path $linked 'src-tauri/target')) 'All-worktree preview deleted files.'
    $cases++
    $null = Invoke-Cleanup $root @('-Apply')
    Assert-True (Test-Path -LiteralPath (Join-Path $linked 'src-tauri/target')) 'Local cleanup touched another worktree.'
    $cases++
    Add-Caches $root
    $null = Invoke-Cleanup $root @('-Apply', '-AllWorktrees')
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $linked 'src-tauri/target'))) 'Linked worktree cache remained.'
    Assert-True (((Invoke-FixtureGit $linked @('status', '--porcelain')) -join "`n") -eq $linkedBefore) 'Linked checkout changes were touched.'
    $cases++

    $tracked = New-FixtureRepository 'tracked-output'
    Add-Caches $tracked
    $null = Invoke-FixtureGit $tracked @('add', '-f', 'dist/nested/cache.bin')
    $null = Invoke-FixtureGit $tracked @('commit', '-qm', 'Track an output deliberately')
    $failure = Invoke-Cleanup $tracked @('-Apply') 1
    Assert-True ($failure.Contains('Refusing tracked files')) 'Tracked output was not rejected.'
    Assert-True (Test-Path -LiteralPath (Join-Path $tracked 'src-tauri/target')) 'Deletion began before the full plan was checked.'
    $cases++

    $unignored = New-FixtureRepository 'unignored-output' "src-tauri/target/`n"
    Write-FixtureFile (Join-Path $unignored 'src-tauri/target/cache.bin')
    Write-FixtureFile (Join-Path $unignored 'dist/user.txt') 'user data'
    $failure = Invoke-Cleanup $unignored @('-Apply') 1
    Assert-True ($failure.Contains('Target must be ignored')) 'Non-ignored output was not rejected.'
    Assert-True (Test-Path -LiteralPath (Join-Path $unignored 'src-tauri/target')) 'Partial deletion occurred on invalid plan.'
    $cases++

    foreach ($kind in @('target', 'ancestor', 'descendant')) {
        $linkedRoot = New-FixtureRepository "junction-$kind"
        $external = Join-Path $fixture "external-$kind"
        Write-FixtureFile (Join-Path $external 'keep.txt') 'external data'
        $junction = switch ($kind) {
            'target' { Join-Path $linkedRoot 'src-tauri/target' }
            'ancestor' {
                Write-FixtureFile (Join-Path $external 'target/cache.bin')
                Join-Path $linkedRoot 'src-tauri'
            }
            'descendant' {
                Write-FixtureFile (Join-Path $linkedRoot 'src-tauri/target/cache.bin')
                Join-Path $linkedRoot 'src-tauri/target/link'
            }
        }
        $null = New-Item -ItemType Directory -Path (Split-Path $junction -Parent) -Force
        $null = New-Item -ItemType Junction -Path $junction -Target $external
        $junctions.Add($junction)
        $failure = Invoke-Cleanup $linkedRoot @('-Apply') 1
        Assert-True ($failure.Contains('Refusing linked')) "Junction not rejected: $kind"
        Assert-True ((Get-Content -LiteralPath (Join-Path $external 'keep.txt') -Raw) -eq 'external data') 'External data changed.'
        $cases++
    }
    Write-Host "PASS: $cases cleanup cases (preview, WhatIf, apply, worktrees, tracked files, ignore rules, and junction boundaries)."
} finally {
    # Detach only the junctions created above, without traversing them.
    foreach ($junction in $junctions) {
        if (Test-Path -LiteralPath $junction) { [IO.Directory]::Delete($junction) }
    }
    $resolved = [IO.Path]::GetFullPath($fixture)
    $prefix = $temporary.TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar + 'lightframe-cleanup-test-'
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture cleanup path.' }
    if (Test-Path -LiteralPath $resolved) {
        Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
    }
}
