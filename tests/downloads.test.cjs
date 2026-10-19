const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { updateReadmeDownloads } = require('../scripts/downloads');

const definitions = [
  { id: 'invoice', outputName: '发票识别', i18n: { 'zh-CN': { fieldName: '发票+明细（ADP）' } } },
  { id: 'passport', outputName: '护照识别' },
];
const originalReadme = '# 钉钉测试项目\n\n原有简介。\n\n## 调试\n\n保留操作说明。\n';

function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'dingding-download-test-');
  const root = fs.mkdtempSync(prefix);
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(prefix)));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'README.md'), originalReadme);
  return root;
}

function buildFixture(root, ids, options = {}) {
  const outputRoot = path.join(root, 'history', options.run || 'run-1');
  const artifacts = ids.map((id) => {
    const info = {
      id,
      outputName: definitions.find((item) => item.id === id).outputName,
      zip: `${id}.zip`,
      version: options.version || '1.2.3',
      packedAt: options.packedAt || '2026-10-18T18:20:30.000Z',
      adpDomain: options.adpDomain || 'adp.laiye.com',
    };
    const dir = path.join(outputRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, info.zip), `validated-zip-fixture-${info.version}`);
    return info;
  });
  return { outputRoot, artifacts };
}

function update(root, build) {
  updateReadmeDownloads(root, definitions, build.artifacts, build.outputRoot);
  return fs.readFileSync(path.join(root, 'README.md'), 'utf8');
}

test('download table links real Chinese package names with original version and Shanghai time', (t) => {
  const root = fixture(t);
  const readme = update(root, buildFixture(root, ['invoice', 'passport']));
  assert.ok(readme.includes('| 英文 ID | 安装包（点击下载） | 版本 | 打包时间 |'));
  assert.ok(readme.includes('发票+明细（ADP）20261019.zip'));
  assert.ok(readme.includes('`1.2.3` | `2026-10-19 02:20:30 +08:00`'));
  const links = [...readme.matchAll(/\]\((\.\/output\/downloads\/[^)]+)\)/g)];
  assert.equal(links.length, 2);
  assert.ok(links[0][1].includes('%2B'));
  for (const [, href] of links) assert.ok(fs.existsSync(path.join(root, decodeURIComponent(href))));
  assert.ok(readme.endsWith(originalReadme.slice(originalReadme.indexOf('原有简介'))));
});

test('single package update preserves other packages and README text without requiring archive history', (t) => {
  const root = fixture(t);
  update(root, buildFixture(root, ['invoice', 'passport']));
  const checkout = fixture(t);
  fs.cpSync(path.join(root, 'output'), path.join(checkout, 'output'), { recursive: true });
  fs.copyFileSync(path.join(root, 'README.md'), path.join(checkout, 'README.md'));
  const oldPassport = fs.readFileSync(path.join(checkout, 'output/downloads/passport/shortcut.json'), 'utf8');
  const readme = update(checkout, buildFixture(checkout, ['invoice'], {
    version: '2.0.0', packedAt: '2026-10-19T08:30:00Z',
  }));
  assert.equal(fs.readFileSync(path.join(checkout, 'output/downloads/passport/shortcut.json'), 'utf8'), oldPassport);
  assert.equal(readme.split('\n').filter((line) => line.startsWith('| `')).length, 2);
  assert.ok(readme.includes('`2.0.0` | `2026-10-19 16:30:00 +08:00`'));
  assert.ok(readme.includes('`1.2.3` | `2026-10-19 02:20:30 +08:00`'));
  assert.ok(readme.endsWith('保留操作说明。\n'));
});

test('repeated updates replace one generated table', (t) => {
  const root = fixture(t);
  const build = buildFixture(root, ['invoice']);
  const first = update(root, build);
  assert.equal(update(root, build), first);
  assert.equal(first.split('<!-- GENERATED:FIELD_SHORTCUT_DOWNLOADS:START -->').length, 2);
  assert.equal(first.split('<!-- GENERATED:FIELD_SHORTCUT_DOWNLOADS:END -->').length, 2);
});

test('test environment builds cannot replace production download links', (t) => {
  const root = fixture(t);
  const first = update(root, buildFixture(root, ['invoice']));
  const metadataPath = path.join(root, 'output/downloads/invoice/shortcut.json');
  const metadata = fs.readFileSync(metadataPath, 'utf8');
  const result = update(root, buildFixture(root, ['invoice'], {
    run: 'test-env', adpDomain: 'test-adp.laiye.com', version: '9.0.0',
  }));
  assert.equal(result, first);
  assert.equal(fs.readFileSync(metadataPath, 'utf8'), metadata);
});

test('missing package does not write a download table', (t) => {
  const root = fixture(t);
  const build = buildFixture(root, ['invoice']);
  fs.unlinkSync(path.join(build.outputRoot, 'invoice/invoice.zip'));
  assert.throws(() => update(root, build), /ENOENT/);
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), originalReadme);
});

test('incomplete generated table markers are reported without replacing README content', (t) => {
  const root = fixture(t);
  const malformed = `${originalReadme}\n<!-- GENERATED:FIELD_SHORTCUT_DOWNLOADS:START -->\n`;
  fs.writeFileSync(path.join(root, 'README.md'), malformed);
  assert.throws(() => update(root, buildFixture(root, ['invoice'])), /标记不完整/);
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), malformed);
});
