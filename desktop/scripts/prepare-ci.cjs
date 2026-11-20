// @ts-nocheck
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..', '..');
const desktopDir = path.resolve(__dirname, '..');
const appDir = path.join(desktopDir, 'app');

fs.mkdirSync(appDir, { recursive: true });
fs.copyFileSync(path.join(rootDir, 'index.html'), path.join(appDir, 'index.html'));
console.log('[prepare-ci] Copied index.html -> desktop/app/index.html');

const repoSlug = process.env.GITHUB_REPOSITORY || '';
if (repoSlug.includes('/')) {
  const [owner, repo] = repoSlug.split('/');
  const pkgPath = path.join(desktopDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.build = pkg.build || {};
  pkg.build.publish = [
    {
      provider: 'github',
      owner,
      repo,
      releaseType: 'release'
    }
  ];
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`[prepare-ci] Bound electron-updater publish target to ${owner}/${repo}`);
} else {
  console.log('[prepare-ci] GITHUB_REPOSITORY not set; keeping default publish config.');
}
