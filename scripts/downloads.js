'use strict';

const fs = require('fs');
const path = require('path');

const startMarker = '<!-- GENERATED:FIELD_SHORTCUT_DOWNLOADS:START -->';
const endMarker = '<!-- GENERATED:FIELD_SHORTCUT_DOWNLOADS:END -->';

function shanghaiTime(value) {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) throw new Error(`无效的打包时间：${value}`);
  return new Date(time.getTime() + 8 * 60 * 60 * 1000).toISOString();
}

function packageName(definition, packedAt) {
  const displayName = definition.i18n?.['zh-CN']?.fieldName || definition.outputName;
  const name = `${displayName.replace(/\s*[（(]ADP[）)]\s*$/i, '').trim()}（ADP）${shanghaiTime(packedAt).slice(0, 10).replace(/-/g, '')}.zip`;
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) throw new Error(`无效的安装包名称：${name}`);
  return name;
}

function updateReadmeDownloads(rootDir, definitions, artifacts, outputRoot) {
  // 测试环境构建仍留在历史目录，不替换 README 中的正式安装包。
  const productionPackages = artifacts.filter((item) => item.adpDomain === 'adp.laiye.com');
  if (!productionPackages.length) return;

  const readmePath = path.join(rootDir, 'README.md');
  const readme = fs.readFileSync(readmePath, 'utf8');
  const start = readme.indexOf(startMarker);
  const end = readme.indexOf(endMarker);
  if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) {
    throw new Error('README 下载表标记不完整。');
  }

  const downloadsDir = path.join(rootDir, 'output', 'downloads');
  for (const info of productionPackages) {
    const definition = definitions.find((item) => item.id === info.id);
    if (!definition || !/^[a-z0-9][a-z0-9-]*$/.test(info.id)) throw new Error(`未知字段 ID：${info.id}`);
    if (!info.version || !info.packedAt || path.basename(info.zip) !== info.zip) {
      throw new Error(`安装包缺少有效的版本、时间或文件名：${info.id}`);
    }
    const sourceZip = path.join(outputRoot, info.id, info.zip);
    if (!fs.statSync(sourceZip).size) throw new Error(`安装包为空：${info.id}`);
    const zip = packageName(definition, info.packedAt);
    const targetDir = path.join(downloadsDir, info.id);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(sourceZip, path.join(targetDir, zip));
    fs.writeFileSync(path.join(targetDir, 'shortcut.json'), `${JSON.stringify({ ...info, zip }, null, 2)}\n`);
  }

  const lines = [
    startMarker,
    '## 插件下载',
    '',
    '> 运行 `npm run pack:all` 会生成全部安装包并自动刷新此下载表；单独打包只更新对应捷径。',
    '',
    '| 英文 ID | 安装包（点击下载） | 版本 | 打包时间 | utm_source |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const definition of definitions) {
    const metadataPath = path.join(downloadsDir, definition.id, 'shortcut.json');
    if (!fs.existsSync(metadataPath)) continue;
    const info = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (info.id !== definition.id || info.adpDomain !== 'adp.laiye.com' || !info.version || !info.packedAt ||
        path.basename(info.zip) !== info.zip || !fs.existsSync(path.join(downloadsDir, definition.id, info.zip))) {
      throw new Error(`下载目录元数据无效：${definition.id}`);
    }
    const time = `${shanghaiTime(info.packedAt).slice(0, 19).replace('T', ' ')} +08:00`;
    const href = `./output/downloads/${definition.id}/${encodeURIComponent(info.zip)}`;
    const utmSource = definition.utmSource || `dingdingzdjj-${definition.id}`;
    lines.push(`| \`${definition.id}\` | [${info.zip}](${href}) | \`${info.version}\` | \`${time}\` | \`${utmSource}\` |`);
  }
  lines.push(endMarker);
  const section = lines.join('\n');
  const updated = start >= 0
    ? readme.slice(0, start) + section + readme.slice(end + endMarker.length)
    : readme.replace(/^(#[^\r\n]*\r?\n)/, (heading) => `${heading}\n${section}\n`);
  const tempPath = path.join(rootDir, `.readme-downloads-${process.pid}.tmp`);
  fs.writeFileSync(tempPath, updated);
  fs.renameSync(tempPath, readmePath);
}

module.exports = { updateReadmeDownloads };
