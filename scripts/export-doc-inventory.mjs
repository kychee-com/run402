import { reviewStatus, publicationStatus } from './documentation-inventory.mjs';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
const [pub, priv, core] = process.argv.slice(2);
const data = [];
for (const [repo, base] of [['private', priv], ['core', core]]) {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: base, encoding: 'utf8'}).trim();
  const files = execFileSync('git', ['ls-files', '-z'], {cwd: base, encoding: 'utf8'}).split('\0').filter(p => repo === 'private'
    ? /^apps\/(marketing|kygit)\//.test(p) && /\.(txt|html|md|json)$/.test(p)
    : /\.(md|mdx)$/.test(p));
  for (const path of files) {
    const historical = /CHANGELOG|changelog|updates\.txt|humans\/run402-2-0\.html/.test(path);
    const legal = /terms|privacy|europe|legal\.html/.test(path);
    const protocol = /llms-full|openapi|schemas|how-it-works|gitvault/.test(path);
    const application = /\/(apps|billing|operator|escalations)\//.test(path);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(`${base}/${path}`)).digest('hex');
    data.push({repository: repo, path, revision, sourceState: 'working-tree snapshot; revision is baseline', sha256,
      owner: repo === 'private' ? 'hosted-docs' : 'core',
      purpose: historical ? 'history' : legal ? 'legal' : protocol ? 'protocol' : application ? 'application' : 'reference',
      interface: historical || legal || application ? 'native' : protocol ? 'http' : repo === 'core' ? 'runtime' : 'cli',
      exception: historical ? 'Dated history preserved; current guidance links and new entries reviewed.' : legal ? 'Legal/security obligations preserved; product instructions reviewed separately.' : application ? 'Browser UI and its native application code; not a shell tutorial.' : repo === 'core' ? 'Native runtime/provider contract and self-hosting references; normal operations prefer CLI.' : protocol ? 'Native protocol/schema contract; general onboarding is CLI-first.' : 'Native browser application code retained; general operations prefer CLI.',
      checks: repo === 'private' ? ['hosted-docs', 'gitvault-page-truth'] : ['core-applicability'],
      evidence: {editorial: reviewStatus(repo, path, sha256), local: 'See coordinated implementation evidence for named check results.', publication: publicationStatus(repo, path, sha256)}});
  }
}
fs.writeFileSync(`${pub}/docs/quality/external-inventory.json`, JSON.stringify(data, null, 2) + '\n');
