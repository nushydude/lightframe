import path from 'node:path';
import { assertVersionContract } from './version-contract.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tagArgumentIndex = process.argv.indexOf('--tag');
const explicitTag = tagArgumentIndex === -1 ? undefined : process.argv.at(tagArgumentIndex + 1);
if (tagArgumentIndex !== -1 && !explicitTag) {
  throw new Error('Expected a tag after --tag');
}
const workflowTag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
const version = await assertVersionContract({ root, tag: explicitTag ?? workflowTag });
console.log(`version metadata and Cargo.lock synchronized at ${version}`);
