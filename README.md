# ADP 钉钉 AI 表格字段捷径

基于钉钉官方 `field-decorator-demo` 和 `dingtalk-docs-cool-app@0.3.4`，提供与飞书版相同的 27 个 ADP 捷径。复用 ADP 请求、识别结果映射、数组取值、明细汇总和错误处理逻辑；钉钉版独立维护在本目录，运行和构建不会修改上级飞书项目。

## 安装与本地调试

以下命令均在 `dingding` 目录执行，需要 Node.js 18 或以上和 npm。

```powershell
npm ci
# config.json 或 .env 已配置时，无需重复复制。
if (!(Test-Path config.json)) { Copy-Item config.example.json config.json }
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

在 `config.json` 填写 ADP API key：

```json
{
  "authorizations": {
    "X-API-KEY": "你的 ADP API key"
  }
}
```

`config.json`、`.env` 和调试工作目录已加入忽略列表。正式使用时由钉钉保存授权，并通过 `context.fetch` 的第三个参数注入 `X-API-KEY`。

`.env` 中的 `ADP_DOMAIN` 仅影响本地调试，默认 `adp.laiye.com`，测试环境可改为 `test-adp.laiye.com`。

```powershell
npm start                              # 默认：vat-invoice-full
npm start -- customs-declaration       # 指定字段 ID
npm start -- --shortcut invoice-verify # 等价写法
npm run build -- --list                # 列出全部字段 ID
```

服务启动后可通过 `http://localhost:8088/open_field` 检查模板清单，再按[钉钉开发指南](https://alidocs.dingtalk.com/i/nodes/1R7q3QmWeljPoM5BSGPbvaNO8xkXOEP2)在 AI 表格中连接本地调试服务。一次调试一个模板，钉钉本地调试只执行当前视图第一行，不支持自动更新。修改 `src` 会重启服务；修改 `.env` 或 `config.json` 后请重新运行命令。

调试脚本会隐藏 SDK 输出中的本地 API key，终端保留其他调试信息。

## 构建安装包

```powershell
npm run typecheck
npm test
npm run build                         # 默认字段
npm run build -- customs-declaration  # 指定字段
npm run build:all                     # 全部 27 个字段
```

`npm run pack` 与 `npm run build` 等价；`npm run pack:all` 构建全部字段。构建产物保存在 `output/field-shortcuts/<本次运行时间与进程号>/<字段 ID>/`，包含：

- `<字段 ID>.zip`：钉钉安装包，内部为 `manifest.json` 和 `build/index.js`。
- `manifest.json`：便于检查的模板清单。
- `shortcut.json`：字段 ID、ADP 域名、附件白名单及安装包信息。

构建始终默认正式 ADP 环境，不读取 `.env`，也不会将 API key 打入包中。仅需明确构建其他环境时，设置 `PACK_ADP_DOMAIN`。字段选择、ADP 域名和附件域名都会固化在对应安装包中。每次构建使用新的隔离目录，保留已有产物；命令只生成安装包，不上传、不发布。

SDK 0.3.4 的编译器不复制 JSON，且 Windows 打包器存在依赖处理问题。本项目在隔离目录转换 JSON 模块，复用 SDK 编译器和清单生成器，明确将平台 SDK 作为外部依赖，生成同结构 ZIP。每个 ZIP 都检查文件结构，并在仅提供平台 SDK 的隔离环境中验证可加载、模板选择、输出字段和域名配置。

## 附件域名与业务配置

钉钉 SDK 0.3.4 本地请求白名单按完整主机名匹配。默认配置已包含实际调试日志确认的附件域名 `alidocs2-zjk-cdn.dingtalk.com`，并保留 `dl.dingtalk.com`、`static.dingtalk.com`、`alidocs.dingtalk.com`。如果其他附件使用不同主机名，请按实际 `tmp_url` 追加白名单，修改后重启 `npm start`：

```powershell
# 本地调试：写入 dingding/.env，或在启动前设置
$env:ADP_ATTACHMENT_DOMAINS = '实际附件域名1,实际附件域名2'
npm start

# 构建：显式追加目标环境使用的附件域名
$env:PACK_ATTACHMENT_DOMAINS = '实际附件域名1,实际附件域名2'
npm run build:all
```

字段配置集中在 `src/field-shortcuts.json`，英文 ID 和 ADP 输出字段保留飞书版约定。平台请求来源为 `DingTalkField`，UTM 前缀为 `dingdingzdjj-`。如后续调整飞书版配置，需单独同步本目录。

本项目已提供本地检查和构建能力。正式安装、授权、附件临时链接及真实 ADP 执行仍需在目标钉钉表格中联调。
