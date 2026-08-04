import assert from 'node:assert/strict';

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv.at(index + 1);
};

export function resolveAuthenticodeRequirement({ provider, required }) {
  if (provider === 'azure-trusted-signing') return true;
  if (required === undefined || required === '') return false;
  assert.ok(
    required === 'true' || required === 'false',
    'REQUIRE_AUTHENTICODE_SIGNING must be true or false'
  );
  return required === 'true';
}

if (process.argv[1]?.endsWith('authenticode-policy.mjs')) {
  console.log(
    resolveAuthenticodeRequirement({
      provider: argument('--provider'),
      required: argument('--required'),
    })
  );
}
