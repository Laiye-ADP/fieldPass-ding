const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');
const sdk = require('dingtalk-docs-cool-app');

const projectRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(projectRoot, 'src/index.ts');
const manifest = require('../src/field-shortcuts.json');
// Original Feishu manifest snapshot from 2026-10-16; tests stay self-contained.
const feishuManifest = require('./fixtures/feishu-field-shortcuts.json');
const runtimeConfig = require('../src/generated/runtime-config.json');
const { getManifestByFieldDecorator } = require(path.join(
  path.dirname(require.resolve('dingtalk-docs-cool-app')),
  'module/fields/kit.js'
));
const { FieldType, FormItemComponent, FieldExecuteCode, AuthorizationType } = sdk;
const transpiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  fileName: sourcePath,
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
    resolveJsonModule: true,
  },
}).outputText;

function loadShortcut(id) {
  const previousShortcut = process.env.FIELD_SHORTCUT_ID;
  const previousDomain = process.env.ADP_DOMAIN;
  try {
    process.env.FIELD_SHORTCUT_ID = id;
    delete process.env.ADP_DOMAIN;
    const instance = new Module(sourcePath, module);
    instance.filename = sourcePath;
    instance.paths = Module._nodeModulePaths(path.dirname(sourcePath));
    // Logs are intentionally silent; no debug config or real API key is loaded.
    instance._compile('const console = { log() {}, error() {} };\n' + transpiled, sourcePath);
    return {
      decorator: sdk.fieldDecoratorKit.getDecorator(),
      domains: [...sdk.fieldDecoratorKit.getDomainList()],
      sdkManifest: getManifestByFieldDecorator(sdk.fieldDecoratorKit),
    };
  } finally {
    if (previousShortcut === undefined) delete process.env.FIELD_SHORTCUT_ID;
    else process.env.FIELD_SHORTCUT_ID = previousShortcut;
    if (previousDomain === undefined) delete process.env.ADP_DOMAIN;
    else process.env.ADP_DOMAIN = previousDomain;
  }
}

const attachment = {
  name: '合同与发票.pdf',
  type: 'application/pdf',
  size: 16,
  tmp_url: 'https://dl.dingtalk.com/test/document.pdf?temporary=fixture',
};
const fileBytes = Buffer.from('%PDF-fixture\n文件', 'utf8');
const apiBase = 'https://adp.laiye.com/open/agentic_doc_processor/laiye/v1';

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Map([['content-type', 'application/json']]),
    text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload),
  };
}

function mockContext(payload, options = {}) {
  const calls = [];
  const context = {
    baseId: 'base-fixture',
    sheetId: 'sheet-fixture',
    extensionId: 'extension-fixture',
    tenantId: 'tenant-fixture',
    fetch: async (...args) => {
      calls.push(args);
      if (options.throwError) throw options.throwError;
      if (args[0] === attachment.tmp_url) {
        // DingTalk SDK safeFetch destructures options; omitting it breaks download.
        assert.deepEqual(args[1], {});
        assert.equal(args[2], undefined, 'ADP authorization must never reach an attachment URL');
        return {
          ok: options.downloadStatus === undefined || options.downloadStatus === 200,
          status: options.downloadStatus || 200,
          headers: new Map(),
          buffer: async () => options.emptyDownload ? Buffer.alloc(0) : fileBytes,
        };
      }
      assert.ok(args[0].startsWith(apiBase + '/'), 'tests must never call an external service');
      return response(payload, options.status);
    },
  };
  return { context, calls };
}

async function execute(id, data, formData = { attachments: [attachment] }, options = {}) {
  const loaded = loadShortcut(id);
  const mocked = mockContext({ code: 'success', data }, options);
  const result = await loaded.decorator.execute(mocked.context, formData);
  return { ...loaded, ...mocked, result };
}

function adpCall(calls) {
  return calls.find(([url]) => url.startsWith(apiBase));
}

function bodyOf(calls) {
  return JSON.parse(adpCall(calls)[1].body);
}

function assertAdpTransport(call, endpoint) {
  assert.equal(call[0], apiBase + endpoint);
  assert.equal(call[1].method, 'POST');
  assert.equal(call[1].headers['X-Api-Source'], 'DingTalkField');
  assert.equal(call[1].headers['Content-Type'], 'application/json');
  assert.equal(call[1].headers['accept-language'], 'zh');
  assert.equal(call[1].headers['X-API-KEY'], undefined, 'SDK injects the key through authId');
  assert.equal(call[2], 'adp_api_key');
}

test('all 27 ADP definitions keep the Feishu business contract and use DingTalk attribution', () => {
  assert.equal(manifest.shortcuts.length, 27);
  assert.deepEqual(manifest.shortcuts.map(item => item.id), feishuManifest.shortcuts.map(item => item.id));
  const typeMap = { 1: FieldType.Text, 2: FieldType.Number, 5: FieldType.Date, 17: FieldType.Attachment };
  for (const original of feishuManifest.shortcuts) {
    const expected = structuredClone(original);
    expected.utmSource = expected.utmSource.replace(/^feishuzdjj-/, 'dingdingzdjj-');
    for (const item of expected.formItems || []) {
      if (item.supportType) item.supportType = item.supportType.map(type => typeMap[type]);
    }
    assert.deepEqual(manifest.shortcuts.find(item => item.id === original.id), expected, original.id);
  }
});

test('every shortcut registers the real DingTalk Object schema, SDK authorization and form controls', async t => {
  for (const original of feishuManifest.shortcuts) {
    await t.test(original.id, () => {
      const { decorator, domains, sdkManifest } = loadShortcut(original.id);
      assert.equal(decorator.resultType.type, FieldType.Object);
      const properties = decorator.resultType.extra.properties;
      assert.deepEqual(properties.map(item => item.key), ['id', ...original.outputFields.map(item => item.key)]);
      assert.equal(properties[0].hidden, true);
      assert.equal(properties.filter(item => item.primary && !item.hidden).length, 1);
      for (const property of properties) {
        assert.equal(property.type, FieldType.Text);
        assert.ok(property.title);
        assert.equal(property.label, undefined, 'DingTalk object properties use title');
      }
      assert.deepEqual(properties.slice(1).map(item => item.title), original.outputFields.map(item => item.label));
      assert.equal(decorator.authorizations.id, 'adp_api_key');
      assert.equal(decorator.authorizations.type, AuthorizationType.MultiHeaderToken);
      assert.equal(Array.isArray(decorator.authorizations), false);
      assert.equal(decorator.authorizations.params[0].key, 'X-API-KEY');
      assert.ok(decorator.authorizations.instructionsUrl.includes('utm_source=dingdingzdjj-'));
      assert.deepEqual(domains, [runtimeConfig.adpDomain, ...runtimeConfig.attachmentDomains]);
      assert.equal(domains.includes('feishu.cn'), false);
      for (const locale of ['zh-CN', 'en-US', 'ja-JP']) assert.ok(decorator.i18nMap[locale].fieldName);
      assert.deepEqual(sdkManifest.fields[0].executeErrorMessages, decorator.errorMessages);
      for (const item of decorator.formItems) {
        if (item.component === FormItemComponent.FieldSelect) {
          assert.ok(Array.isArray(item.props.supportTypes));
          assert.equal(item.props.supportType, undefined);
        }
      }
      if (original.id === 'custom-document-extraction') {
        assert.equal(decorator.formItems.find(item => item.key === 'A').component, FormItemComponent.Textarea);
        assert.equal(decorator.formItems.find(item => item.key === 'A').validator.required, true);
        assert.equal(decorator.formItems.find(item => item.key === 'Z').validator.required, false);
      }
    });
  }
});

test('every shortcut executes context-first and returns exactly its declared output keys', async t => {
  for (const shortcut of feishuManifest.shortcuts) {
    await t.test(shortcut.id, async () => {
      let formData = { attachments: [attachment] };
      if (shortcut.id === 'invoice-verify') formData = { fpNumber: '12345678901234567890', fpDate: '20261016', fpAmount: '123.45' };
      if (shortcut.id === 'custom-document-extraction') formData.A = '合同编号';
      const { calls, result } = await execute(shortcut.id, { task_id: 'task-fixture', extraction_result: [] }, formData);
      assert.equal(result.code, FieldExecuteCode.Success);
      assert.deepEqual(Object.keys(result.data), ['id', ...shortcut.outputFields.map(item => item.key)]);
      assert.ok(Object.values(result.data).every(value => typeof value === 'string'));
      assert.equal(result.data.id, 'task-fixture');
      assertAdpTransport(adpCall(calls), shortcut.adp.endpoint);
    });
  }
});

test('Base64 flow downloads with empty options and preserves invoice field aliases and first row values', async () => {
  const { calls, result } = await execute('vat-invoice-full', {
    task_id: 'invoice-1',
    extraction_result: [
      { field_key: 'invoice_number', field_values: [{ value: '12345678901234567890' }] },
      { field_key: 'seller_name', value: '甲公司' },
      { field_key: 'buy_name', value: '乙公司' },
      { field_key: 'total_money', value: '113.00' },
      { field_key: 'line_item_name', field_values: [{ value: '螺丝' }, { value: '螺帽' }] },
      { field_key: 'line_item_quantity', value: ['2', '3'] },
    ],
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], attachment.tmp_url);
  assertAdpTransport(calls[1], '/app/doc/extract');
  assert.deepEqual(bodyOf(calls), {
    file_base64: fileBytes.toString('base64'),
    app_id: 'ootb_v9x2y5z8a1b4c7d0e3f6h9j1k4m7',
    with_rec_result: false,
  });
  assert.equal(result.data.vat_invoice_haoma_large_size, '12345678901234567890');
  assert.equal(result.data.vat_invoice_seller_name, '甲公司');
  assert.equal(result.data.vat_invoice_payer_name, '乙公司');
  assert.equal(result.data.vat_invoice_total_cover_tax_digits, '113.00');
  assert.equal(result.data.line_item_name, '螺丝');
  assert.equal(result.data.line_item_quantity, '2');
  assert.equal(result.data.line_item_summary, '螺丝///2//// | 螺帽///3////');
});

test('real DingTalk safeFetch allows the observed attachment CDN without exposing ADP credentials', async () => {
  const { decorator, domains, sdkManifest } = loadShortcut('vat-invoice-full');
  const attachmentUrl = 'https://alidocs2-zjk-cdn.dingtalk.com/fixture/invoice.png';
  const calls = [];
  const transport = async (url, options) => {
    calls.push([url, options]);
    if (url === attachmentUrl) {
      assert.deepEqual(options.headers, {}, 'attachments must not receive ADP authorization');
      return { ok: true, status: 200, buffer: async () => fileBytes };
    }
    assert.equal(url, apiBase + '/app/doc/extract', 'only fixture requests may reach the transport');
    assert.equal(options.headers['X-API-KEY'], 'fixture-adp-key');
    return response({ code: 'success', data: { task_id: 'safe-fetch-fixture', extraction_result: [] } });
  };

  // Keep the SDK whitelist and authorization logic real; replace only its network transport.
  const sdkRoot = path.dirname(require.resolve('dingtalk-docs-cool-app'));
  const safeFetchPath = require.resolve(path.join(sdkRoot, 'common/safeFetch.js'));
  const nodeFetchPath = require.resolve('node-fetch', { paths: [sdkRoot] });
  const previousSafeFetch = require.cache[safeFetchPath];
  const previousNodeFetch = require.cache[nodeFetchPath];
  const mockedNodeFetch = new Module(nodeFetchPath, module);
  mockedNodeFetch.exports = transport;
  mockedNodeFetch.loaded = true;
  let getSafeFetch;
  try {
    require.cache[nodeFetchPath] = mockedNodeFetch;
    delete require.cache[safeFetchPath];
    ({ getSafeFetch } = require(safeFetchPath));
  } finally {
    if (previousNodeFetch) require.cache[nodeFetchPath] = previousNodeFetch;
    else delete require.cache[nodeFetchPath];
    if (previousSafeFetch) require.cache[safeFetchPath] = previousSafeFetch;
    else delete require.cache[safeFetchPath];
  }

  const safeFetch = getSafeFetch(domains, sdkManifest, { 'X-API-KEY': 'fixture-adp-key' });
  const result = await decorator.execute({ fetch: safeFetch }, {
    attachments: [{ ...attachment, name: 'invoice.png', type: 'image', tmp_url: attachmentUrl }],
  });
  assert.equal(result.code, FieldExecuteCode.Success);
  assert.equal(result.data.id, 'safe-fetch-fixture');
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], attachmentUrl);
  assert.equal(JSON.parse(calls[1][1].body).file_base64, fileBytes.toString('base64'));
  assert.throws(
    () => safeFetch('https://alidocs2-zjk-cdn.dingtalk.com.untrusted.invalid/fixture.png', {}),
    /Blocked request to disallowed domain/
  );
  assert.equal(calls.length, 2, 'unlisted domains must be rejected before any network transport');
});

test('URL flow sends the temporary URL unchanged and preserves complete table rows', async () => {
  const row = (...values) => ['line_items_material_code', 'line_items_tax_rate', 'line_items_description',
    'line_items_quantity', 'line_items_unit_price_inc_tax', 'line_items_total_amount_inc_tax', 'line_items_delivery_date']
    .map((field_key, index) => ({ field_key, value: values[index] }));
  const { calls, result } = await execute('procurement-order', {
    task_id: 'po-1',
    output_result: [{ po_number: 'PO-001' }],
    extraction_result: [{ table_values: [
      row('M1', '13%', '螺丝', '2', '10', '20', '2026-10-17'),
      row('M2', '', '螺帽', '3', '5', '15', ''),
    ] }],
  });
  assert.equal(calls.length, 1, 'URL-mode must not download the attachment');
  assert.deepEqual(bodyOf(calls), {
    file_url: attachment.tmp_url,
    app_id: 'ootb_m9n2p5q8r1t4v7w0x3y6z9a2b5',
    with_rec_result: false,
  });
  assert.equal(result.data.po_number, 'PO-001');
  assert.equal(result.data.line_items_material_code, 'M1');
  assert.equal(result.data.line_items_summary, 'M1/13%/螺丝/2/10/20/2026-10-17|M2//螺帽/3/5/15/');
});

test('legacy VAT table aliases still produce the complete row summary', async () => {
  const { result } = await execute('vat-invoice-full', {
    extraction_result: [{ table_values: [[
      { field_key: 'vat_invoice_goods', value: '咨询服务' },
      { field_key: 'vat_invoice_electrans_quantity', value: '1' },
      { field_key: 'vat_invoice_price', value: '100' },
      { field_key: 'vat_invoice_tax_rate_list', value: '6%' },
      { field_key: 'vat_invoice_tax_list', value: '6' },
    ]] }],
  });
  assert.equal(result.data.line_item_name, '咨询服务');
  assert.equal(result.data.line_item_summary, '咨询服务///1//100/6%/6');
});

test('overseas invoices use the first nested ticket and avoid mixing later tickets', async () => {
  const { calls, result } = await execute('overseas-invoice-fast', {
    task_id: 'overseas-1',
    extraction_result: [{ field_name: 'Receipt', object_values: [
      { ticket_id: 't1', ticket_index: 0, extraction_result: [
        { field_key: 'country_code', value: 'US' },
        { field_key: 'invoice_number', value: 'FIRST-001' },
        { field_key: 'currency', value: 'USD' },
        { field_key: 'line_items_description', value: ['Coffee', 'Tea'] },
        { field_key: 'line_items_total_amount', value: ['4', '5'] },
      ] },
      { ticket_id: 't2', ticket_index: 1, extraction_result: [
        { field_key: 'invoice_number', value: 'SECOND-002' },
        { field_key: 'supplier_name', value: 'Must not leak' },
      ] },
    ] }],
  });
  assert.equal(bodyOf(calls).enable_multi_ticket, true);
  assert.equal(result.data.ticket_type, 'Receipt');
  assert.equal(result.data.invoice_number, 'FIRST-001');
  assert.equal(result.data.supplier_name, '');
  assert.equal(result.data.line_items_description, 'Coffee');
  assert.equal(result.data.line_items_summary, '/Coffee/////4 | /Tea/////5');
});

test('invoice verification normalizes compact, Date and timestamp dates without losing invoice digits', async t => {
  for (const date of ['20261016', '2026-10-16', new Date('2026-10-16T00:00:00Z'), Date.parse('2026-10-16T00:00:00Z')]) {
    await t.test(String(date), async () => {
      const { calls, result } = await execute('invoice-verify', {
        result: { fpVerification: '查验一致', fpVerificationMsg: '验证成功', fpIsVoided: '否' },
      }, { fpNumber: { text: ' 12345678901234567890 ' }, fpDate: date, fpAmount: 113.5 });
      assert.equal(calls.length, 1);
      assert.deepEqual(bodyOf(calls), { fpNumber: '12345678901234567890', fpDate: '2026-10-16', fpAmount: '113.5' });
      assert.equal(result.data.fpVerification, '查验一致');
      assert.ok(result.data.fpVerificationMsg.startsWith('验证成功。支持电子发票增值税专用发票'));
      assert.equal(result.data.fpIsVoided, '否');
    });
  }
});

test('missing invoice parameters and attachments return configuration errors before any API request', async () => {
  for (const [id, formData, message] of [
    ['invoice-verify', { fpNumber: '123', fpDate: '', fpAmount: '1' }, /开票日期不能为空/],
    ['vat-invoice-full', { attachments: [] }, /有效的附件字段/],
    ['procurement-order', { attachments: [{}] }, /有效的附件字段/],
    ['custom-document-extraction', { attachments: [attachment], A: ' ' }, /至少填写一个抽取字段/],
  ]) {
    const { result, calls } = await execute(id, {}, formData);
    assert.equal(result.code, FieldExecuteCode.ConfigError);
    assert.match(result.msg, message);
    assert.equal(calls.length, 0);
  }
});

test('custom extraction skips blank letters and maps returned values back to the selected letters', async () => {
  const { calls, result } = await execute('custom-document-extraction', {
    task_id: 'custom-1',
    extraction_result: [
      { field_name: '合同编号', field_values: [{ value: 'HT-001' }] },
      { field_name: '甲方', value: '甲公司' },
    ],
  }, { attachments: [attachment], A: ' 合同编号 ', B: ' ', Z: '甲方' });
  assert.equal(calls.length, 1);
  assertAdpTransport(calls[0], '/app/doc/extract/direct-fast');
  assert.deepEqual(bodyOf(calls), { file: { url: attachment.tmp_url }, fields: [{ name: '合同编号' }, { name: '甲方' }] });
  assert.equal(result.data.A, 'HT-001');
  assert.equal(result.data.B, '');
  assert.equal(result.data.Z, '甲公司');
});

test('custom extraction accepts 20 fields and rejects 21 before consuming ADP quota', async () => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const formData = { attachments: [attachment] };
  for (const letter of letters.slice(0, 20)) formData[letter] = `字段${letter}`;
  const twenty = await execute('custom-document-extraction', {}, formData);
  assert.equal(twenty.result.code, FieldExecuteCode.Success);
  assert.equal(bodyOf(twenty.calls).fields.length, 20);
  formData.U = '字段U';
  const twentyOne = await execute('custom-document-extraction', {}, formData);
  assert.equal(twentyOne.result.code, FieldExecuteCode.ConfigError);
  assert.match(twentyOne.result.msg, /最多支持 20 个非空字段/);
  assert.equal(twentyOne.calls.length, 0);
});

test('document reading keeps page order and falls back to recognized text details', async () => {
  const { calls, result } = await execute('smart-document-reading', {
    task_id: 'reading-1',
    doc_recognize_result: [
      { document_content: ' # 标题\n正文 ', document_details: [{ text: '不得重复' }] },
      { document_content: '', document_details: [{ text: '第二页' }, { text: ' 详情 ' }, { text: '' }] },
      { document_content: ' ' },
    ],
  });
  assert.equal(result.data.document_content, '# 标题\n正文\n\n第二页\n详情');
  assertAdpTransport(adpCall(calls), '/app/doc/recognize');
  assert.equal(bodyOf(calls).file_name, attachment.name);
  assert.equal(bodyOf(calls).model_params.recognize_config.enable_stamp_recognition, false);
});

test('stamp recognition flattens pages and keeps every stamp description', async () => {
  const { calls, result } = await execute('stamp-recognition', {
    doc_recognize_result: [
      { stamps: [{ color_description: '红色', shape_description: '圆形', texts: ['甲公司', '合同专用章'] }] },
      { stamps: [{ color_description: '蓝色', shape_description: '方形', texts: '财务章' }] },
      { stamps: [] },
    ],
  });
  assert.equal(result.data.stamp_count, '2');
  assert.equal(result.data.stamp_info, '印章 1\n颜色：红色\n形状：圆形\n文字：甲公司、合同专用章\n印章 2\n颜色：蓝色\n形状：方形\n文字：财务章');
  assert.equal(bodyOf(calls).model_params.recognize_config.enable_stamp_recognition, true);
});

test('ADP authorization, quota, rate-limit and nested failures remain failures in DingTalk', async t => {
  const cases = [
    { name: 'invalid key', payload: { code: 'error', message: 'accessor not found' }, code: FieldExecuteCode.AuthorizationError, message: /authorizations\["X-API-KEY"\]/ },
    { name: 'HTTP authorization', payload: { code: 'error', message: 'unauthorized API key' }, status: 401, code: FieldExecuteCode.AuthorizationError, message: /unauthorized API key/ },
    { name: 'quota', payload: { code: 'error', message: 'insufficient credits' }, code: FieldExecuteCode.Error, message: /配额积分不足.*https:\/\/adp.laiye.com/, errorMessage: 'adpQuotaExhausted' },
    { name: 'nested business failure', payload: { code: 'success', data: { status: '5', message: '文档处理失败' } }, code: FieldExecuteCode.Error, message: /文档处理失败/, errorMessage: 'adpRequestFailed' },
    { name: 'nested quota', payload: { code: 'success', data: { status: 5, tips: '积分不足' } }, code: FieldExecuteCode.Error, message: /配额积分不足/, errorMessage: 'adpQuotaExhausted' },
    { name: 'rate limit', payload: { code: 'error', message: 'rate limit exceeded' }, code: FieldExecuteCode.RateLimit, message: /rate limit/ },
    { name: 'non-JSON upstream', payload: 'upstream temporarily unavailable', status: 503, code: FieldExecuteCode.Error, message: /upstream temporarily unavailable/, errorMessage: 'adpRequestFailed' },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const { decorator } = loadShortcut('procurement-order');
      const { context } = mockContext(fixture.payload, { status: fixture.status });
      const result = await decorator.execute(context, { attachments: [attachment] });
      assert.equal(result.code, fixture.code);
      assert.match(result.msg, fixture.message);
      assert.equal(result.data, undefined);
      if (fixture.errorMessage) {
        assert.equal(result.errorMessage, fixture.errorMessage);
        const translation = decorator.errorMessages[result.errorMessage];
        assert.ok(translation, 'DingTalk must be able to resolve the custom error key');
        const localeKey = translation.slice(3, -2);
        assert.ok(decorator.i18nMap['zh-CN'][localeKey]);
      }
    });
  }
});

test('attachment download failures and thrown authorization errors stop execution', async () => {
  for (const options of [{ downloadStatus: 404 }, { emptyDownload: true }]) {
    const { result, calls } = await execute('vat-invoice-full', {}, undefined, options);
    assert.equal(result.code, FieldExecuteCode.Error);
    assert.equal(calls.length, 1);
    assert.equal(adpCall(calls), undefined);
    assert.match(result.msg, /附件.*失败|附件为空/);
  }
  const { result } = await execute('procurement-order', {}, undefined, { throwError: new Error('403 unauthorized') });
  assert.equal(result.code, FieldExecuteCode.AuthorizationError);
  assert.match(result.msg, /403 unauthorized/);
});
