import assert from 'node:assert/strict';

export function createGitHubApi({
  repository,
  token,
  fetchImpl = fetch,
  apiBase = 'https://api.github.com',
}) {
  assert.ok(token, 'GH_TOKEN is required');
  assert.ok(repository, 'GH_REPO is required');
  return async function apiGet(pathname) {
    const response = await fetchImpl(`${apiBase}/repos/${repository}${pathname}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitHub API ${pathname} failed with ${response.status}`);
    return response.json();
  };
}

function selectUniqueReleaseByTag(releases, tag) {
  const matches = releases.filter((release) => release.tag_name === tag);
  assert.ok(
    matches.length <= 1,
    `Found ${matches.length} releases for ${tag}; refusing ambiguous release state`
  );
  return matches[0];
}

export async function findReleaseByTag({ apiGet, tag }) {
  const releases = [];
  for (let page = 1; page <= 10_000; page += 1) {
    const pageReleases = await apiGet(`/releases?per_page=100&page=${page}`);
    assert.ok(Array.isArray(pageReleases), `GitHub releases page ${page} was not an array`);
    releases.push(...pageReleases);
    if (pageReleases.length < 100) return selectUniqueReleaseByTag(releases, tag);
  }
  throw new Error('GitHub releases pagination exceeded 10,000 pages');
}

async function resolveGitObjectCommit(object, fetchAnnotatedTag) {
  let current = object;
  while (current?.type === 'tag') {
    current = (await fetchAnnotatedTag(current.sha)).object;
  }
  assert.equal(current?.type, 'commit', 'Release tag does not resolve to a commit');
  return current.sha;
}

async function assertDraftReleaseIsSafe({
  expectedSha,
  expectedTag,
  refObject,
  release,
  fetchAnnotatedTag,
  requireRelease = false,
}) {
  if (refObject) {
    const commit = await resolveGitObjectCommit(refObject, fetchAnnotatedTag);
    assert.equal(
      commit,
      expectedSha,
      `Existing release tag points at ${commit}, not gated SHA ${expectedSha}`
    );
  }
  if (!release) {
    assert.ok(!requireRelease, 'Tauri Action did not create the expected draft release');
    return;
  }
  assert.equal(
    release.tag_name,
    expectedTag,
    `Release tag ${release.tag_name} does not match expected ${expectedTag}`
  );
  assert.equal(release.draft, true, 'Existing release is public; refusing to modify it');
  assert.equal(
    release.target_commitish,
    expectedSha,
    `Existing draft targets ${release.target_commitish}, not gated SHA ${expectedSha}`
  );
}

export async function runPreflightReleaseGuard({ apiGet, tag, expectedSha }) {
  assert.match(expectedSha, /^[0-9a-f]{40}$/i, 'Expected a full release commit SHA');
  const [ref, release] = await Promise.all([
    apiGet(`/git/ref/tags/${encodeURIComponent(tag)}`),
    findReleaseByTag({ apiGet, tag }),
  ]);
  assert.ok(!ref, `Release tag ${tag} already exists; refusing to reuse an existing tag`);
  assert.ok(!release, `Release ${tag} already exists; refusing to reuse an existing release`);
}

export async function runPostflightReleaseGuard({ apiGet, tag, expectedSha, releaseId }) {
  assert.match(String(releaseId), /^\d+$/, 'Tauri Action did not report a numeric release ID');
  const [ref, release] = await Promise.all([
    apiGet(`/git/ref/tags/${encodeURIComponent(tag)}`),
    apiGet(`/releases/${releaseId}`),
  ]);
  await assertDraftReleaseIsSafe({
    expectedSha,
    expectedTag: tag,
    refObject: ref?.object,
    release,
    fetchAnnotatedTag: async (sha) => {
      const tagObject = await apiGet(`/git/tags/${sha}`);
      assert.ok(tagObject, `Annotated tag object ${sha} was not found`);
      return tagObject;
    },
    requireRelease: true,
  });
}

export async function runDraftCleanup({ apiGet, apiDelete, tag, expectedSha, releaseId }) {
  assert.match(String(releaseId), /^\d+$/, 'Cleanup requires the Tauri Action numeric release ID');
  const [ref, release] = await Promise.all([
    apiGet(`/git/ref/tags/${encodeURIComponent(tag)}`),
    apiGet(`/releases/${releaseId}`),
  ]);
  await assertDraftReleaseIsSafe({
    expectedSha,
    expectedTag: tag,
    refObject: ref?.object,
    release,
    fetchAnnotatedTag: async (sha) => {
      const tagObject = await apiGet(`/git/tags/${sha}`);
      assert.ok(tagObject, `Annotated tag object ${sha} was not found`);
      return tagObject;
    },
    requireRelease: true,
  });
  assert.equal(
    String(release.id),
    String(releaseId),
    'Cleanup release ID does not match the created draft'
  );
  await apiDelete(`/releases/${releaseId}`);
  const refBeforeTagDelete = await apiGet(`/git/ref/tags/${encodeURIComponent(tag)}`);
  if (!refBeforeTagDelete) return;
  const commitBeforeTagDelete = await resolveGitObjectCommit(
    refBeforeTagDelete.object,
    async (sha) => {
      const tagObject = await apiGet(`/git/tags/${sha}`);
      assert.ok(tagObject, `Annotated tag object ${sha} was not found`);
      return tagObject;
    }
  );
  assert.equal(commitBeforeTagDelete, expectedSha, 'Release tag changed before cleanup deletion');
  await apiDelete(`/git/refs/tags/${encodeURIComponent(tag)}`);
}

async function main() {
  const [phase, tag, expectedSha, releaseId] = process.argv.slice(2);
  assert.ok(
    phase === 'pre' || phase === 'post' || phase === 'cleanup',
    'Usage: release-draft-guard.mjs <pre|post|cleanup> <tag> <sha> [releaseId]'
  );
  assert.ok(tag, 'Release tag is required');
  assert.match(expectedSha ?? '', /^[0-9a-f]{40}$/i, 'Expected a full release commit SHA');
  const apiGet = createGitHubApi({ repository: process.env.GH_REPO, token: process.env.GH_TOKEN });
  if (phase === 'pre') {
    await runPreflightReleaseGuard({ apiGet, tag, expectedSha });
  } else if (phase === 'post') {
    await runPostflightReleaseGuard({ apiGet, tag, expectedSha, releaseId });
  } else {
    const apiDelete = async (pathname) => {
      const response = await fetch(
        `https://api.github.com/repos/${process.env.GH_REPO}${pathname}`,
        {
          method: 'DELETE',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${process.env.GH_TOKEN}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );
      if (!response.ok) throw new Error(`GitHub delete ${pathname} failed with ${response.status}`);
    };
    await runDraftCleanup({ apiGet, apiDelete, tag, expectedSha, releaseId });
  }
  console.log(`${phase} release guard accepted ${tag} at ${expectedSha}`);
}

if (process.argv[1]?.endsWith('release-draft-guard.mjs')) {
  await main();
}
