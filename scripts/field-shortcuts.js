'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const vm = require('vm');
const zlib = require('zlib');
const readline = require('readline');
const { createRequire } = require('module');

const rootDir = path.resolve(__dirname, '..');
const productionAdpDomain = 'adp.laiye.com';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  const result = { mode: argv[0] || 'build', all: false, shortcutId: '', list: false };
  if (!['start', 'build', 'pack'].includes(result.mode)) {
    throw new Error('用法：node scripts/field-shortcuts.js <start|build|pack> [--all|--shortcut <id>|--list]');
  }
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--all') result.all = true;
    else if (arg === '--list') result.list = true;
    else if (arg === '--shortcut' || arg === '--id') {
      if (!argv[index + 1] || argv[index + 1].startsWith('-')) {
        throw new Error(`${arg} 后需要提供字段 ID。`);
      }
      if (result.shortcutId) throw new Error('一次只能选择一个字段 ID。');
      result.shortcutId = argv[++index];
    } else if (arg.startsWith('--shortcut=') || arg.startsWith('--id=')) {
      if (result.shortcutId) throw new Error('一次只能选择一个字段 ID。');
      result.shortcutId = arg.slice(arg.indexOf('=') + 1);
      if (!result.shortcutId) throw new Error('字段 ID 不能为空。');
    } else if (!arg.startsWith('-') && !result.shortcutId) result.shortcutId = arg;
    else throw new Error(`未知参数：${arg}`);
  }
  if (result.all && result.shortcutId) throw new Error('--all 不能与字段 ID 同时使用。');
  if (result.mode === 'start' && result.all) throw new Error('本地调试一次只能启动一个字段模板。');
  return result;
}

function loadLocalEnv() {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function validateDomain(domain) {
  // SDK 白名单只接受主机名；统一限制为 HTTPS 公网/测试环境域名。
  const value = String(domain).trim();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value) || value.includes('..')) {
    throw new Error('ADP_DOMAIN 必须为不含协议、端口或路径的域名。');
  }
  return value.toLowerCase();
}

function getDefinitions(manifest, options) {
  const ids = new Set();
  for (const item of manifest.shortcuts || []) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(item.id) || ids.has(item.id)) {
      throw new Error(`字段清单包含无效或重复 ID：${item.id}`);
    }
    ids.add(item.id);
  }
  if (options.all) return manifest.shortcuts;
  const shortcutId = options.shortcutId || manifest.defaultShortcutId;
  const definition = manifest.shortcuts.find((item) => item.id === shortcutId);
  if (!definition) throw new Error(`未知字段 ID：${shortcutId}。使用 --list 查看可用字段。`);
  return [definition];
}

function prepareWorkspace(workspaceDir, definition, config) {
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.cpSync(path.join(rootDir, 'src'), path.join(workspaceDir, 'src'), { recursive: true });
  fs.copyFileSync(path.join(rootDir, 'tsconfig.json'), path.join(workspaceDir, 'tsconfig.json'));
  fs.copyFileSync(path.join(rootDir, 'package.json'), path.join(workspaceDir, 'package.json'));
  writeJson(path.join(workspaceDir, 'src', 'generated', 'runtime-config.json'), {
    shortcutId: definition.id,
    ...config,
  });
  prepareJsonModules(path.join(workspaceDir, 'src'));
}

function prepareJsonModules(dir) {
  // SDK 0.3.4 的 Babel 不复制 JSON，Rollup 也未启用 JSON 插件。
  // 仅在隔离目录把 JSON 转成 TS 模块，确保最终 ZIP 无运行时 JSON 依赖。
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) prepareJsonModules(filePath);
    else if (entry.name.endsWith('.json')) {
      fs.writeFileSync(`${filePath}.ts`, `export default ${JSON.stringify(readJson(filePath))};\n`);
    } else if (/\.(?:ts|js)$/.test(entry.name) && !entry.name.endsWith('.json.ts')) {
      const source = fs.readFileSync(filePath, 'utf8');
      fs.writeFileSync(filePath, source
        .replace(/(['"])(\.{1,2}\/[^'"\r\n]+\.json)\1/g, '$1$2.js$1')
        .replace(/getEnv\(['"](?:FIELD_SHORTCUT_ID|ADP_DOMAIN|ADP_ATTACHMENT_DOMAINS)['"]\)/g, "''"));
    }
  }
}

function environment() {
  const result = { ...process.env };
  const pathKey = Object.keys(result).find((key) => key.toLowerCase() === 'path') || 'PATH';
  result[pathKey] = [path.join(rootDir, 'node_modules', '.bin'), result[pathKey]].filter(Boolean).join(path.delimiter);
  return result;
}

function sdkEntry() {
  const sdkPackagePath = require.resolve('dingtalk-docs-cool-app/package.json', { paths: [rootDir] });
  const sdkPackage = readJson(sdkPackagePath);
  const entry = typeof sdkPackage.bin === 'string' ? sdkPackage.bin : sdkPackage.bin['dingtalk-docs-cool-app'];
  if (!entry) throw new Error('已安装 SDK 未提供 dingtalk-docs-cool-app CLI。');
  return path.resolve(path.dirname(sdkPackagePath), entry);
}

function getConfig(options) {
  const defaults = readJson(path.join(rootDir, 'src', 'generated', 'runtime-config.json'));
  if (options.mode === 'start') loadLocalEnv();
  const adpDomain = validateDomain(
    options.mode === 'start'
      ? process.env.ADP_DOMAIN || productionAdpDomain
      : process.env.PACK_ADP_DOMAIN || productionAdpDomain
  );
  const extraDomains = options.mode === 'start' ? process.env.ADP_ATTACHMENT_DOMAINS : process.env.PACK_ATTACHMENT_DOMAINS;
  const attachmentDomains = [...new Set([
    ...(defaults.attachmentDomains || []),
    ...String(extraDomains || '').split(',').map((item) => item.trim()).filter(Boolean),
  ].map(validateDomain))];
  return { adpDomain, attachmentDomains };
}

function zipFiles(buffer) {
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new Error('SDK 输出不是完整的 ZIP 文件。');
  const files = new Map();
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 中央目录无效。');
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const dataOffset = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(dataOffset, dataOffset + size);
    if (method !== 0 && method !== 8) throw new Error(`不支持的 ZIP 压缩方法：${method}`);
    files.set(name, method === 8 ? zlib.inflateRawSync(data) : data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function validatePackage(zipPath, definition, config) {
  const files = zipFiles(fs.readFileSync(zipPath));
  for (const name of ['manifest.json', 'build/index.js']) {
    if (!files.get(name)?.length) throw new Error(`ZIP 缺少有效文件：${name}`);
  }
  if ([...files.keys()].some((name) => !['manifest.json', 'build/', 'build/index.js'].includes(name))) {
    throw new Error('ZIP 包含 SDK 预期结构以外的文件。');
  }
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
  const entryModule = { exports: {} };
  const sandbox = {
    module: entryModule,
    exports: entryModule.exports,
    console,
    Buffer,
    URL,
    require(name) {
      if (name !== 'dingtalk-docs-cool-app') throw new Error(`构建包存在未打包的依赖：${name}`);
      return require('dingtalk-docs-cool-app');
    },
  };
  // 发布环境没有构建目录、JSON 文件或本地环境变量；在相同约束下加载。
  vm.runInNewContext(files.get('build/index.js').toString('utf8'), sandbox, { timeout: 5000 });
  const kit = entryModule.exports.default || entryModule.exports;
  if (typeof kit.getDecorator !== 'function') throw new Error('构建包未导出有效的 fieldDecoratorKit。');
  const decorator = kit.getDecorator();
  const expectedName = `${definition.outputName}（ADP）`;
  if (decorator.name !== expectedName || manifest.name?.['zh-CN'] !== expectedName) {
    throw new Error(`构建包字段选择不正确：${definition.id}`);
  }
  const properties = decorator.resultType?.extra?.properties || [];
  const expectedKeys = ['id', ...definition.outputFields.map((field) => field.key)];
  if (JSON.stringify(properties.map((field) => field.key)) !== JSON.stringify(expectedKeys)) {
    throw new Error(`构建包输出字段不正确：${definition.id}`);
  }
  if (!kit.getDomainList().includes(config.adpDomain)) throw new Error('构建包缺少 ADP 域名白名单。');
  return { manifest, entries: [...files.keys()] };
}

async function build(definitions, config, runId) {
  const buildRoot = path.join(rootDir, '.field-shortcuts-build', runId);
  const outputRoot = path.join(rootDir, 'output', 'field-shortcuts', runId);
  const artifacts = [];
  const sdkRoot = path.dirname(require.resolve('dingtalk-docs-cool-app/package.json', { paths: [rootDir] }));
  const sdkRequire = createRequire(path.join(sdkRoot, 'package.json'));
  const { build: compile } = require(path.join(sdkRoot, 'dist-node', 'common', 'babel'));
  const { getManifestByFieldDecorator } = require(path.join(sdkRoot, 'dist-node', 'module', 'fields'));
  const { rollup } = sdkRequire('rollup');
  const commonjs = sdkRequire('@rollup/plugin-commonjs');
  const archiver = sdkRequire('archiver');
  for (const definition of definitions) {
    console.log(`构建 ${definition.id}（${definition.outputName}），ADP：${config.adpDomain}`);
    const workspaceDir = path.join(buildRoot, definition.id);
    prepareWorkspace(workspaceDir, definition, config);
    const compiledDir = path.join(workspaceDir, 'compiled');
    compile(path.join(workspaceDir, 'src'), compiledDir);
    const entryPath = path.join(compiledDir, 'index.js');
    const compiled = require(entryPath);
    const kit = compiled.default || compiled;
    const manifest = getManifestByFieldDecorator(kit);
    // SDK pack:field 在 Windows 未能正确识别 node_modules 外部依赖，
    // 且吞掉 Rollup 失败。使用相同编译器/清单生成器，并明确外置平台 SDK。
    const bundle = await rollup({
      input: entryPath,
      external: (id) => id === 'dingtalk-docs-cool-app',
      plugins: [commonjs()],
    });
    const bundledPath = path.join(workspaceDir, 'bundle.js');
    try { await bundle.write({ file: bundledPath, format: 'cjs', exports: 'auto' }); }
    finally { await bundle.close(); }
    const sourceZip = path.join(workspaceDir, 'output.zip');
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(sourceZip);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.pipe(output);
      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
      archive.file(bundledPath, { name: 'build/index.js' });
      archive.finalize();
    });
    const checked = validatePackage(sourceZip, definition, config);
    const artifactDir = path.join(outputRoot, definition.id);
    fs.mkdirSync(artifactDir, { recursive: true });
    const zipName = `${definition.id}.zip`;
    fs.copyFileSync(sourceZip, path.join(artifactDir, zipName));
    writeJson(path.join(artifactDir, 'manifest.json'), checked.manifest);
    const info = { id: definition.id, outputName: definition.outputName, zip: zipName, ...config, entries: checked.entries };
    writeJson(path.join(artifactDir, 'shortcut.json'), info);
    artifacts.push(info);
  }
  writeJson(path.join(outputRoot, 'build.json'), { builtAt: new Date().toISOString(), ...config, shortcuts: artifacts });
  console.log(`已生成并验证 ${artifacts.length} 个钉钉安装包：${outputRoot}`);
}

function start(definition, config, runId) {
  const configPath = path.join(rootDir, 'config.json');
  if (!fs.existsSync(configPath)) throw new Error('缺少 dingding/config.json。请复制 config.example.json 并填写 ADP API key。');
  const localConfig = readJson(configPath);
  const apiKey = localConfig.authorizations?.['X-API-KEY'];
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.includes('请替换')) {
    throw new Error('请在 dingding/config.json 的 authorizations.X-API-KEY 中填写有效 API key。');
  }
  const workspaceDir = path.join(rootDir, '.field-shortcuts-dev', runId, definition.id);
  console.log(`本地调试 ${definition.id}，ADP：${config.adpDomain}`);
  console.log(`隔离工作目录：${workspaceDir}`);
  console.log('调试地址：http://localhost:8088/open_field；修改 src 后会重新启动调试服务。');
  let child;
  let stopping = false;
  let restarting = false;
  let timer;
  function launch() {
    prepareWorkspace(workspaceDir, definition, config);
    fs.copyFileSync(configPath, path.join(workspaceDir, 'config.json'));
    const secrets = Object.values(readJson(configPath).authorizations || {}).filter((value) => typeof value === 'string' && value);
    child = childProcess.spawn(process.execPath, [sdkEntry(), 'start:field'], {
      cwd: workspaceDir, env: environment(), stdio: ['inherit', 'pipe', 'pipe'],
    });
    // 官方 CLI 会打印完整 authorizations；转发两路日志前逐行隐藏本地凭证。
    pipeRedacted(child.stdout, process.stdout, secrets);
    pipeRedacted(child.stderr, process.stderr, secrets);
    child.on('error', (error) => { console.error(error.message); stop(1); });
    child.on('exit', (code) => {
      if (restarting && !stopping) { restarting = false; launch(); }
      else if (!stopping) stop(code || 0);
    });
  }
  const watcher = fs.watch(path.join(rootDir, 'src'), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (stopping || restarting) return;
      restarting = true;
      console.log('源文件已更新，重新启动调试服务。');
      child.kill();
    }, 250);
  });
  function stop(exitCode) {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    watcher.close();
    if (child && !child.killed) child.kill();
    // 只删除本次运行复制的凭证文件，不清理其他工作目录或构建产物。
    fs.rmSync(path.join(workspaceDir, 'config.json'), { force: true });
    process.exitCode = exitCode;
  }
  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));
  launch();
}

function pipeRedacted(input, output, secrets) {
  const lines = readline.createInterface({ input });
  lines.on('line', (line) => {
    let redacted = line;
    for (const secret of secrets) redacted = redacted.split(secret).join('[REDACTED]');
    output.write(`${redacted}\n`);
  });
}

async function main(argv) {
  const options = parseArgs(argv);
  const manifest = readJson(path.join(rootDir, 'src', 'field-shortcuts.json'));
  if (options.list) {
    for (const definition of manifest.shortcuts) console.log(`${definition.id}\t${definition.outputName}`);
    return;
  }
  const definitions = getDefinitions(manifest, options);
  const config = getConfig(options);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  if (options.mode === 'start') start(definitions[0], config, runId);
  else await build(definitions, config, runId);
}

module.exports = { parseArgs, validateDomain, getDefinitions, prepareWorkspace, validatePackage, zipFiles, pipeRedacted };

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
