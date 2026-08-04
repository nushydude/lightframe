import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertSemver,
  assertVersionContract,
  extractCargoManifestVersion,
  extractLockPackageVersion,
  parseReleaseTag,
  versionedManifestContents,
} from './version-contract.mjs';
import {
  assertReportedArtifactVersion,
  assertUpdaterMetadataVersion,
  parseArtifactPaths,
} from './verify-release-artifacts.mjs';
import {
  createGitHubApi,
  findReleaseByTag,
  runDraftCleanup,
  runPostflightReleaseGuard,
  runPreflightReleaseGuard,
} from './release-draft-guard.mjs';
import { setVersion } from './set-version.mjs';

const rootLockEntry = 'name = "lightframe"\nversion = "8.7.5"\ndependencies = []';
const lockfile = `version = 4\n\n[[package]]\nname = "lightframe"\nversion = "8.7.5"\nsource = "registry+https://example.invalid"\nchecksum = "fixture"\n\n[[package]]\nname = "dependency-with-same-version"\nversion = "8.7.5"\n\n[[package]]\n${rootLockEntry}\n`;

test('accepts synchronized stable and prerelease semantic versions', () => {
  assert.equal(assertSemver('8.7.5'), '8.7.5');
  assert.equal(assertSemver('8.8.0-beta.1'), '8.8.0-beta.1');
  assert.equal(parseReleaseTag('v8.8.0-beta.1'), '8.8.0-beta.1');
});

test('accepts synchronized stable and prerelease version contracts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lightframe-version-contract-'));
  try {
    await fs.mkdir(path.join(root, 'src-tauri'));
    await fs.mkdir(path.join(root, 'src-tauri', 'src'));
    async function writeContract(version) {
      await Promise.all([
        fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version })),
        fs.writeFile(
          path.join(root, 'src-tauri', 'Cargo.toml'),
          `[package]\nversion = "${version}"\n`
        ),
        fs.writeFile(
          path.join(root, 'src-tauri', 'Cargo.lock'),
          lockfile.replaceAll('8.7.5', version)
        ),
        fs.writeFile(path.join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ version })),
      ]);
    }
    await writeContract('8.7.5');
    await assert.doesNotReject(assertVersionContract({ root, tag: 'v8.7.5' }));
    await writeContract('8.8.0-beta.1');
    await assert.doesNotReject(assertVersionContract({ root, tag: 'v8.8.0-beta.1' }));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects malformed and prefixed manifest versions and tags', () => {
  assert.throws(() => assertSemver('v8.7.5'), /Invalid semantic version/);
  assert.throws(() => parseReleaseTag('release-8.7.5'), /must start/);
  assert.throws(() => parseReleaseTag('v8.7'), /Invalid semantic version/);
  assert.throws(() => parseReleaseTag('v8.7.5+build.1'), /cannot include SemVer build metadata/);
});

test('selects the LightFrame root package rather than a dependency version', () => {
  assert.equal(extractLockPackageVersion(lockfile), '8.7.5');
  assert.equal(
    extractCargoManifestVersion('[package]\nname = "lightframe"\nversion = "8.7.5"\n'),
    '8.7.5'
  );
  assert.equal(
    extractLockPackageVersion(
      lockfile.replace(rootLockEntry, 'name = "lightframe"\nversion = "8.7.4"')
    ),
    '8.7.4'
  );
});

test('rejects a mismatched root lockfile package even when a dependency has the expected version', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lightframe-version-contract-'));
  try {
    await fs.mkdir(path.join(root, 'src-tauri'));
    await Promise.all([
      fs.writeFile(path.join(root, 'package.json'), '{"version":"8.7.5"}\n'),
      fs.writeFile(path.join(root, 'src-tauri', 'Cargo.toml'), '[package]\nversion = "8.7.5"\n'),
      fs.writeFile(
        path.join(root, 'src-tauri', 'Cargo.lock'),
        lockfile.replace(rootLockEntry, 'name = "lightframe"\nversion = "8.7.4"')
      ),
      fs.writeFile(path.join(root, 'src-tauri', 'tauri.conf.json'), '{\n  "version": "8.7.5"\n}\n'),
    ]);
    await assert.rejects(
      assertVersionContract({ root }),
      /Cargo\.lock root lightframe package version differs/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('prepares every declared manifest for a reproducible version update', () => {
  const updated = versionedManifestContents({
    packageText: '{"name":"lightframe","version":"8.7.4"}\n',
    cargoToml: '[package]\nname = "lightframe"\nversion = "8.7.4"\n',
    tauriText: '{\n  "version": "8.7.4"\n}\n',
    version: '8.8.0-beta.1',
  });
  assert.match(updated.packageText, /"version": "8\.8\.0-beta\.1"/);
  assert.match(updated.cargoToml, /version = "8\.8\.0-beta\.1"/);
  assert.match(updated.tauriText, /"version": "8\.8\.0-beta\.1"/);
});

test('repairs a stale root lockfile entry for an unchanged requested version and is clean on repeat', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lightframe-set-version-'));
  try {
    await fs.mkdir(path.join(root, 'src-tauri'));
    await fs.mkdir(path.join(root, 'src-tauri', 'src'));
    await Promise.all([
      fs.writeFile(path.join(root, 'package.json'), '{"name":"lightframe","version":"8.7.5"}\n'),
      fs.writeFile(
        path.join(root, 'src-tauri', 'Cargo.toml'),
        '[package]\nname = "lightframe"\nversion = "8.7.5"\nedition = "2021"\n'
      ),
      fs.writeFile(
        path.join(root, 'src-tauri', 'Cargo.lock'),
        'version = 4\n\n[[package]]\nname = "lightframe"\nversion = "8.7.4"\n'
      ),
      fs.writeFile(path.join(root, 'src-tauri', 'src', 'lib.rs'), ''),
      fs.writeFile(path.join(root, 'src-tauri', 'tauri.conf.json'), '{\n  "version": "8.7.5"\n}\n'),
    ]);
    await setVersion({ root, version: '8.7.5' });
    const repairedLockfile = await fs.readFile(path.join(root, 'src-tauri', 'Cargo.lock'), 'utf8');
    assert.equal(extractLockPackageVersion(repairedLockfile), '8.7.5');
    await setVersion({ root, version: '8.7.5' });
    assert.equal(
      await fs.readFile(path.join(root, 'src-tauri', 'Cargo.lock'), 'utf8'),
      repairedLockfile
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('discovers a draft release by exact tag through authenticated pagination', async () => {
  const calls = [];
  const unrelated = Array.from({ length: 100 }, (_, index) => ({ tag_name: `app-v0.0.${index}` }));
  const apiGet = createGitHubApi({
    repository: 'owner/lightframe',
    token: 'fixture-token',
    apiBase: 'https://fixture.invalid',
    fetchImpl: async (url) => {
      calls.push(url);
      const page = new URL(url).searchParams.get('page');
      const payload = page === '1' ? unrelated : [{ id: 42, tag_name: 'app-v8.7.5', draft: true }];
      return { status: 200, ok: true, json: async () => payload };
    },
  });
  assert.deepEqual(await findReleaseByTag({ apiGet, tag: 'app-v8.7.5' }), {
    id: 42,
    tag_name: 'app-v8.7.5',
    draft: true,
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /releases\?per_page=100&page=1/);
  assert.match(calls[1], /releases\?per_page=100&page=2/);
  await assert.rejects(
    findReleaseByTag({
      apiGet: async () => [{ tag_name: 'app-v8.7.5' }, { tag_name: 'app-v8.7.5' }],
      tag: 'app-v8.7.5',
    }),
    /ambiguous/
  );
});

test('preflight rejects every preexisting release or tag before Tauri action', async () => {
  const sha = 'a'.repeat(40);
  await assert.rejects(
    runPreflightReleaseGuard({
      tag: 'app-v8.7.5',
      expectedSha: sha,
      apiGet: async (pathname) => {
        if (pathname.startsWith('/git/ref/')) return { object: { type: 'commit', sha } };
        if (pathname.startsWith('/releases?'))
          return [{ tag_name: 'app-v8.7.5', draft: false, target_commitish: sha }];
        throw new Error(`Unexpected API request: ${pathname}`);
      },
    }),
    /already exists/
  );
  await assert.rejects(
    runPreflightReleaseGuard({
      tag: 'app-v8.7.5',
      expectedSha: sha,
      apiGet: async (pathname) => {
        if (pathname.startsWith('/git/ref/')) return undefined;
        if (pathname.startsWith('/releases?'))
          return [{ id: 77, tag_name: 'app-v8.7.5', draft: true, target_commitish: sha }];
        throw new Error(`Unexpected API request: ${pathname}`);
      },
    }),
    /already exists/
  );
  await assert.rejects(
    runPreflightReleaseGuard({
      tag: 'app-v8.7.5',
      expectedSha: sha,
      apiGet: async (pathname) => {
        if (pathname.startsWith('/git/ref/'))
          return { object: { type: 'commit', sha: 'b'.repeat(40) } };
        if (pathname.startsWith('/releases?'))
          return [{ tag_name: 'app-v8.7.5', draft: true, target_commitish: sha }];
        throw new Error(`Unexpected API request: ${pathname}`);
      },
    }),
    /already exists/
  );
  await assert.rejects(
    runPreflightReleaseGuard({
      tag: 'app-v8.7.5',
      expectedSha: sha,
      apiGet: async (pathname) => {
        if (pathname.startsWith('/git/ref/')) return { object: { type: 'commit', sha } };
        if (pathname.startsWith('/releases?'))
          return [{ id: 77, tag_name: 'app-v8.7.5', draft: true, target_commitish: sha }];
        throw new Error(`Unexpected API request: ${pathname}`);
      },
    }),
    /already exists/
  );
});

test('postflight fetches Tauri release ID and requires exact same-SHA draft state', async () => {
  const sha = 'a'.repeat(40);
  const calls = [];
  await assert.doesNotReject(
    runPostflightReleaseGuard({
      tag: 'app-v8.7.5',
      expectedSha: sha,
      releaseId: '77',
      apiGet: async (pathname) => {
        calls.push(pathname);
        if (pathname.startsWith('/git/ref/'))
          return { object: { type: 'tag', sha: 'b'.repeat(40) } };
        if (pathname === '/git/tags/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
          return { object: { type: 'commit', sha } };
        if (pathname === '/releases/77')
          return { tag_name: 'app-v8.7.5', draft: true, target_commitish: sha };
        throw new Error(`Unexpected API request: ${pathname}`);
      },
    })
  );
  assert.ok(calls.includes('/releases/77'));
  await assert.rejects(
    runPostflightReleaseGuard({
      tag: 'app-v8.7.5',
      expectedSha: sha,
      releaseId: '77',
      apiGet: async (pathname) => {
        if (pathname.startsWith('/git/ref/')) return { object: { type: 'commit', sha } };
        if (pathname === '/releases/77')
          return { tag_name: 'app-v8.7.5', draft: true, target_commitish: 'c'.repeat(40) };
        throw new Error(`Unexpected API request: ${pathname}`);
      },
    }),
    /not gated SHA/
  );
});

test('cleanup deletes only the exact Tauri-created same-SHA draft and tag', async () => {
  const sha = 'a'.repeat(40);
  const deleted = [];
  await runDraftCleanup({
    tag: 'app-v8.7.5',
    expectedSha: sha,
    releaseId: '77',
    apiGet: async (pathname) => {
      if (pathname.startsWith('/git/ref/')) return { object: { type: 'commit', sha } };
      if (pathname === '/releases/77')
        return { id: 77, tag_name: 'app-v8.7.5', draft: true, target_commitish: sha };
      throw new Error(`Unexpected API request: ${pathname}`);
    },
    apiDelete: async (pathname) => deleted.push(pathname),
  });
  assert.deepEqual(deleted, ['/releases/77', '/git/refs/tags/app-v8.7.5']);
  const noDelete = [];
  await assert.rejects(
    runDraftCleanup({
      tag: 'app-v8.7.5',
      expectedSha: sha,
      releaseId: '',
      apiGet: async () => undefined,
      apiDelete: async (pathname) => noDelete.push(pathname),
    }),
    /numeric/
  );
  assert.deepEqual(noDelete, [], 'cleanup without a created release ID must not delete anything');
  await assert.rejects(
    runDraftCleanup({
      tag: 'app-v8.7.5',
      expectedSha: sha,
      releaseId: '78',
      apiGet: async (pathname) => {
        if (pathname.startsWith('/git/ref/')) return { object: { type: 'commit', sha } };
        if (pathname === '/releases/78')
          return { id: 78, tag_name: 'other', draft: true, target_commitish: sha };
      },
      apiDelete: async () => {
        throw new Error('must not delete unowned release');
      },
    }),
    /does not match/
  );
});

test('verifies existing, versioned Tauri Action installer outputs', async () => {
  assert.deepEqual(parseArtifactPaths('["a.msi","b.exe"]'), ['a.msi', 'b.exe']);
  assert.deepEqual(parseArtifactPaths('a.msi\nb.exe'), ['a.msi', 'b.exe']);
  const artifactDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'lightframe-release-artifacts-')
  );
  try {
    const installer = path.join(artifactDirectory, 'LightFrame_8.7.5_x64-setup.exe');
    await fs.writeFile(installer, 'fixture');
    await assert.doesNotReject(
      assertReportedArtifactVersion({
        expectedVersion: '8.7.5',
        reportedVersion: '8.7.5',
        artifactPaths: [installer],
      })
    );
    await assert.rejects(
      assertReportedArtifactVersion({
        expectedVersion: '8.7.5',
        reportedVersion: '8.7.5',
        artifactPaths: [path.join(artifactDirectory, 'LightFrame_8.7.4_x64-setup.exe')],
      })
    );
    await assert.rejects(
      assertReportedArtifactVersion({
        expectedVersion: '8.7.5',
        reportedVersion: '8.7.4',
        artifactPaths: [installer],
      })
    );
  } finally {
    await fs.rm(artifactDirectory, { recursive: true, force: true });
  }
});

test('verifies generated updater metadata after a release build', async () => {
  const artifactDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'lightframe-updater-metadata-')
  );
  try {
    await fs.writeFile(
      path.join(artifactDirectory, 'latest.json'),
      JSON.stringify({
        version: '8.7.5',
        platforms: { 'windows-x86_64': { signature: 'fixture' } },
      })
    );
    await assertUpdaterMetadataVersion({ expectedVersion: '8.7.5', artifactDirectory });
    await fs.writeFile(
      path.join(artifactDirectory, 'latest.json'),
      JSON.stringify({ version: '8.7.4', platforms: {} })
    );
    await assert.rejects(
      assertUpdaterMetadataVersion({ expectedVersion: '8.7.5', artifactDirectory })
    );
  } finally {
    await fs.rm(artifactDirectory, { recursive: true, force: true });
  }
});

test('release workflow uses the local same-SHA quality workflow before drafting artifacts', async () => {
  const workflow = await fs.readFile(
    path.resolve(import.meta.dirname, '..', '.github', 'workflows', 'release.yml'),
    'utf8'
  );
  assert.match(workflow, /uses: \.\/\.github\/workflows\/ci\.yml/);
  assert.match(workflow, /quality-gates:[\s\S]*needs: version-tag-preflight/);
  assert.match(workflow, /needs: \[version-tag-preflight, quality-gates\]/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /security-events: write/);
  assert.match(workflow, /group: release-\$\{\{ github\.ref \}\}/);
  assert.ok(
    workflow.includes(`run: |
          VERSION="$(node -p 'require("./package.json").version')"
          printf 'value=%s\\n' "$VERSION" >> "$GITHUB_OUTPUT"`)
  );
  assert.doesNotMatch(workflow, /node -p \\"/);
  assert.match(workflow, /releaseDraft: true/);
  assert.match(workflow, /releaseCommitish: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /release-draft-guard\.mjs pre/);
  assert.match(workflow, /release-draft-guard\.mjs post "\$TAG" "\$SHA" "\$RELEASE_ID"/);
  assert.match(workflow, /RELEASE_ID: \$\{\{ steps\.tauri\.outputs\.releaseId \}\}/);
  assert.match(workflow, /steps\.tauri\.outputs\.appVersion/);
  assert.match(workflow, /Tauri Action reported duplicate artifact basenames/);
  assert.match(workflow, /authenticode-policy\.mjs --provider "\$env:WINDOWS_SIGNING_PROVIDER"/);
  assert.match(workflow, /verify-uploaded-release-assets\.mjs --release-id "\$env:RELEASE_ID"/);
  assert.match(workflow, /release-draft-guard\.mjs cleanup "\$TAG" "\$SHA" "\$RELEASE_ID"/);
  const cleanupIndex = workflow.indexOf("Remove only this run's exact draft after failure");
  assert.ok(
    cleanupIndex > workflow.indexOf('Verify uploaded final assets match final local bytes')
  );
  assert.match(
    workflow.trimEnd(),
    /run: node scripts\/release-draft-guard\.mjs cleanup "\$TAG" "\$SHA" "\$RELEASE_ID"$/
  );
  const ciWorkflow = await fs.readFile(
    path.resolve(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'),
    'utf8'
  );
  assert.match(ciWorkflow, /Run version contract tests[\s\S]*pnpm run test:version/);
  assert.match(
    ciWorkflow,
    /Verify version metadata and Cargo\.lock[\s\S]*pnpm run quality:version/
  );
});

test('native package keeps the desktop app as Cargo default-run when helper binaries exist', async () => {
  const manifest = await fs.readFile(
    path.resolve(import.meta.dirname, '..', 'src-tauri', 'Cargo.toml'),
    'utf8'
  );
  assert.match(manifest, /^default-run = "lightframe"$/m);
  assert.match(manifest, /\[\[bin\]\]\nname = "lightframe"\npath = "src\/main\.rs"/);
});
