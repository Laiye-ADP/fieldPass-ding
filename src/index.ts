import {
  AuthorizationType,
  FieldExecuteCode as FieldCode,
  FormItemComponent,
  FieldType,
  fieldDecoratorKit,
} from 'dingtalk-docs-cool-app';
import shortcutManifestJson from './field-shortcuts.json';
import runtimeConfig from './generated/runtime-config.json';

// ADP 请求与字段映射沿用飞书版的独立副本，运行和构建只依赖 dingding 目录。
type Decorator = Parameters<typeof fieldDecoratorKit.setDecorator>[0];
type FieldContext = Parameters<Decorator['execute']>[0];
type FailureCode = Exclude<FieldCode, FieldCode.Success>;

const { t } = fieldDecoratorKit;

const ADP_AUTH_ID = 'adp_api_key';
const API_KEY_AUTH_PLATFORM = 'ADP';
const ADP_DOMAIN = getEnv('ADP_DOMAIN') || runtimeConfig.adpDomain || 'adp.laiye.com';
const ATTACHMENT_DOMAINS = runtimeConfig.attachmentDomains;
const ADP_BASE_URL = `https://${ADP_DOMAIN}/open/agentic_doc_processor/laiye/v1`;
const ADP_API_KEY_HELP_BASE_URL = 'https://adp.laiye.com';
const ADP_RECHARGE_GUIDE_URL = 'https://adp.laiye.com';
const ADP_ICON_URL = 'https://laiye.com/favicon.ico';
const API_SOURCE = 'DingTalkField';
const DEFAULT_DEBUG_PREFIX = '[ADP field shortcut]';

type Locale = 'zh-CN' | 'en-US' | 'ja-JP';

type LocalizedMessages = Partial<Record<Locale, Record<string, string>>>;

type ShortcutAttachment = {
  name?: string;
  size?: number;
  type?: string;
  tmp_url?: string;
};

type AdpResponse<T = Record<string, unknown>> = {
  code?: string | number;
  message?: string;
  tips?: string | null;
  data?: T;
};

type ExtractData = {
  task_id?: string;
  status?: number;
  file_url?: string;
  result?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  extraction_result?: unknown[];
  classify_result?: unknown;
  output_result?: unknown[];
  tickets?: unknown;
  ticket_count?: number | null;
  doc_recognize_result?: unknown[];
};

type CustomFieldMapping = {
  key: string;
  name: string;
};

type OutputFieldDefinition = {
  key: string;
  label: string;
  primary?: boolean;
  hidden?: boolean;
  valueKeys?: string[];
  takeFirstArrayValue?: boolean;
  summaryFromKeys?: string[];
  summaryFromKeySets?: string[][];
  summaryRowDelimiter?: string;
};

type AdpRequestDefinition = {
  endpoint: string;
  source?: 'fileBase64' | 'fileUrl' | 'formParams';
  appId?: string;
  method?: 'POST';
  acceptLanguage?: string;
  fileBase64Key?: string;
  fileUrlKey?: string;
  fileNameKey?: string;
  withRecResult?: boolean;
  paramKeys?: string[];
  body?: Record<string, unknown>;
  responseMode?: 'stampRecognition' | 'documentReading' | 'customFieldExtraction';
};

type ShortcutFormItemDefinition = {
  key: string;
  label: string;
  placeholder: string;
  component?: 'fieldSelect' | 'input';
  literalLabel?: boolean;
  supportType?: FieldType[];
  required?: boolean;
  maxItems?: number;
};

type FieldShortcutDefinition = {
  id: string;
  outputName: string;
  utmSource?: string;
  debugPrefix?: string;
  i18n?: LocalizedMessages;
  idPrefix?: string;
  adp: AdpRequestDefinition;
  formItems?: ShortcutFormItemDefinition[];
  outputFields: OutputFieldDefinition[];
};

type ShortcutManifest = {
  defaultShortcutId: string;
  shortcuts: FieldShortcutDefinition[];
};

type FieldOutput = Record<string, string>;

const shortcutManifest = shortcutManifestJson as ShortcutManifest;
const selectedShortcut = selectShortcut(shortcutManifest);
const DEBUG_PREFIX = selectedShortcut.debugPrefix || DEFAULT_DEBUG_PREFIX;

fieldDecoratorKit.setDomainList([ADP_DOMAIN, ...ATTACHMENT_DOMAINS]);

fieldDecoratorKit.setDecorator({
  name: `${selectedShortcut.outputName}（ADP）`,
  options: {
    disableAutoUpdate: false,
  },
  i18nMap: buildI18nMessages(selectedShortcut),
  errorMessages: {
    adpRequestFailed: t('adpRequestFailed'),
    adpQuotaExhausted: t('adpQuotaExhausted'),
  },
  authorizations: {
    id: ADP_AUTH_ID,
    platform: API_KEY_AUTH_PLATFORM,
    type: AuthorizationType.MultiHeaderToken,
    required: true,
    params: [{ key: 'X-API-KEY', placeholder: t('apiKeyPlaceholder') }],
    instructionsUrl: getAdpApiKeyHelpUrl(selectedShortcut),
    label: t('authLabel'),
    tooltips: t('apiKeyPlaceholder'),
    icon: {
      light: ADP_ICON_URL,
      dark: ADP_ICON_URL,
    },
  },
  formItems: buildFormItems(selectedShortcut),
  execute: async (
    context: FieldContext,
    formItemParams: Record<string, unknown> & { attachments?: ShortcutAttachment[] }
  ) => {
    const runId = createRunId();
    try {
      debug(runId, 'execute:start', {
        shortcutId: selectedShortcut.id,
        formKeys: Object.keys(formItemParams || {}),
        attachmentCount: formItemParams.attachments?.length ?? 0,
        context: summarizeContext(context),
      });

      const requestUrl = getAdpUrl(selectedShortcut.adp.endpoint);
      debug(runId, 'adp:start', {
        url: requestUrl,
        appId: selectedShortcut.adp.appId,
        authId: ADP_AUTH_ID,
      });
      const result =
        selectedShortcut.adp.responseMode === 'customFieldExtraction'
          ? await callCustomFieldExtraction(selectedShortcut, formItemParams, context, runId)
          : await callAdpExtract(selectedShortcut, formItemParams, context, runId);
      debug(runId, 'adp:parsed_response', summarizeAdpResponse(result));

      if (isAdpFailure(result)) {
        console.error(`${DEBUG_PREFIX} ${runId} adp:non_success`, {
          code: result.code,
          message: result.message,
          tips: result.tips,
          businessStatus: getAdpBusinessStatus(result),
          businessMessage: getAdpBusinessMessage(result),
          hint: getAdpErrorHint(result),
        });
        return fail(mapAdpErrorCode(result), getAdpErrorMessage(result));
      }

      const output = toFieldOutput(
        selectedShortcut,
        result.data,
        formItemParams.attachments?.[0],
        formItemParams
      );
      debug(runId, 'output:ready', summarizeOutput(output));
      return {
        code: FieldCode.Success,
        data: output,
      };
    } catch (error) {
      console.error(`${DEBUG_PREFIX} ${runId} execute:failed`, serializeError(error));
      return fail(
        error instanceof ConfigError
          ? FieldCode.ConfigError
          : isAuthorizationLikeError(error)
            ? FieldCode.AuthorizationError
            : FieldCode.Error,
        error instanceof Error ? error.message : String(error)
      );
    }
  },
  resultType: {
    type: FieldType.Object,
    extra: {
      icon: {
        light: ADP_ICON_URL,
        dark: ADP_ICON_URL,
      },
      properties: [
        { key: 'id', type: FieldType.Text, title: t('id'), hidden: true },
        ...selectedShortcut.outputFields.map((item) =>
          item.primary
            ? {
                key: item.key,
                type: FieldType.Text as const,
                title: item.label,
                primary: true,
              }
            : {
                key: item.key,
                type: FieldType.Text as const,
                title: item.label,
                hidden: item.hidden,
              }
        ),
      ],
    },
  },
});

function selectShortcut(manifest: ShortcutManifest): FieldShortcutDefinition {
  const selectedId =
    getEnv('FIELD_SHORTCUT_ID') || runtimeConfig.shortcutId || manifest.defaultShortcutId;
  const definition = manifest.shortcuts.find((item) => item.id === selectedId);

  if (!definition) {
    const available = manifest.shortcuts.map((item) => item.id).join(', ');
    throw new Error(`未知字段捷径：${selectedId}。可用字段捷径：${available}`);
  }

  return definition;
}

function getEnv(key: string): string {
  const maybeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return maybeProcess?.env?.[key] || '';
}

function getAdpApiKeyHelpUrl(shortcut: FieldShortcutDefinition): string {
  const utmSource = shortcut.utmSource || `dingdingzdjj-${shortcut.id}`;
  return `${ADP_API_KEY_HELP_BASE_URL}?utm_source=${encodeURIComponent(utmSource)}&from=getkey`;
}

function buildI18nMessages(shortcut: FieldShortcutDefinition): Record<Locale, Record<string, string>> {
  return {
    'zh-CN': {
      fieldName: `${shortcut.outputName}（ADP）`,
      fileLabel: '文件',
      filePlaceholder: '请选择文件所在字段（支持 JPG/JPEG/PNG/PDF/OFD 等附件）',
      authLabel: 'ADP',
      apiKeyPlaceholder: '请填写 API key',
      id: 'ID',
      adpRequestFailed: 'ADP 请求失败，请检查配置，或复制错误详情联系开发者。',
      adpQuotaExhausted: `配额积分不足，如需继续使用请前往官网充值。${ADP_RECHARGE_GUIDE_URL}`,
      ...(shortcut.i18n?.['zh-CN'] || {}),
    },
    'en-US': {
      fieldName: `${shortcut.outputName} (ADP)`,
      fileLabel: 'File',
      filePlaceholder: 'Select an attachment field',
      authLabel: 'ADP',
      apiKeyPlaceholder: 'Enter API key',
      id: 'ID',
      adpRequestFailed: 'ADP request failed. Check the configuration or copy error details for support.',
      adpQuotaExhausted: `Insufficient ADP credits. Recharge at ${ADP_RECHARGE_GUIDE_URL}`,
      ...(shortcut.i18n?.['en-US'] || {}),
    },
    'ja-JP': {
      fieldName: `${shortcut.outputName}（ADP）`,
      fileLabel: 'ファイル',
      filePlaceholder: '添付フィールドを選択',
      authLabel: 'ADP',
      apiKeyPlaceholder: 'API key を入力',
      id: 'ID',
      adpRequestFailed: 'ADP リクエストに失敗しました。設定を確認するか、エラー詳細を開発者に送信してください。',
      adpQuotaExhausted: `ADP の残高が不足しています。${ADP_RECHARGE_GUIDE_URL} でチャージしてください。`,
      ...(shortcut.i18n?.['ja-JP'] || {}),
    },
  };
}

function buildFormItems(shortcut: FieldShortcutDefinition): Decorator['formItems'] {
  if (shortcut.formItems?.length) {
    return shortcut.formItems.map((item): Decorator['formItems'][number] => {
      const common = {
        key: item.key,
        label: item.literalLabel ? item.label : t(item.label),
        validator: { required: item.required !== false },
      };
      if (item.component === 'input') {
        return {
          ...common,
          component: FormItemComponent.Textarea,
          props: { placeholder: t(item.placeholder), enableFieldReference: false },
        };
      }
      return {
        ...common,
        component: FormItemComponent.FieldSelect,
        props: { mode: 'single', supportTypes: item.supportType || [] },
      };
    });
  }
  return [{
    key: 'attachments',
    label: t('fileLabel'),
    component: FormItemComponent.FieldSelect,
    props: { mode: 'single', supportTypes: [FieldType.Attachment] },
    validator: { required: true },
  }];
}

async function downloadAttachmentAsBase64(
  attachment: ShortcutAttachment,
  context: FieldContext
): Promise<string> {
  const response = await context.fetch(attachment.tmp_url as string, {});
  debug('download', 'response', {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: summarizeHeaders(response.headers),
  });

  if (!response.ok) {
    throw new Error(`下载钉钉附件失败：HTTP ${response.status}`);
  }

  const buffer = await response.buffer();
  debug('download', 'buffer', {
    byteLength: buffer.length,
    fileName: attachment.name,
    fileType: attachment.type,
    declaredSize: attachment.size,
  });

  if (!buffer.length) {
    throw new Error('下载到的附件为空。');
  }

  return buffer.toString('base64');
}

async function callAdpExtract(
  shortcut: FieldShortcutDefinition,
  formItemParams: Record<string, unknown> & { attachments?: ShortcutAttachment[] },
  context: FieldContext,
  runId: string
): Promise<AdpResponse<ExtractData>> {
  const requestBody = await buildAdpRequestBody(shortcut, formItemParams, context, runId);
  const response = await context.fetch(
    getAdpUrl(shortcut.adp.endpoint),
    {
      method: shortcut.adp.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Source': API_SOURCE,
        'accept-language': shortcut.adp.acceptLanguage || 'zh',
      },
      body: JSON.stringify(requestBody),
    },
    ADP_AUTH_ID
  );

  debug('adp', 'response', {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: summarizeHeaders(response.headers),
  });

  const payload = (await readJson(response, runId)) as AdpResponse<ExtractData>;
  debug('adp', 'payload', summarizeAdpResponse(payload));

  if (!response.ok) {
    return {
      code: response.status,
      message: payload.message || `ADP 接口请求失败：HTTP ${response.status}`,
      data: payload.data,
    };
  }

  return payload;
}

async function callCustomFieldExtraction(
  shortcut: FieldShortcutDefinition,
  formItemParams: Record<string, unknown> & { attachments?: ShortcutAttachment[] },
  context: FieldContext,
  runId: string
): Promise<AdpResponse<ExtractData>> {
  const fieldMappings = getCustomFieldMappings(shortcut, formItemParams);
  if (!fieldMappings.length) throw new ConfigError('请至少填写一个抽取字段，A 为必填项。');
  if (fieldMappings.length > 20) {
    throw new ConfigError('文档自定义字段抽取最多支持 20 个非空字段。');
  }

  const attachment = formItemParams.attachments?.[0];
  if (!attachment?.tmp_url) throw new ConfigError('请选择一个有效的附件字段。');

  debug(runId, 'direct_extract:request', {
    attachment: summarizeAttachment(attachment),
    fieldKeys: fieldMappings.map((item) => item.key),
    fieldNames: fieldMappings.map((item) => item.name),
  });

  return callAdpJson<ExtractData>(
    shortcut.adp.endpoint,
    {
      file: { url: attachment.tmp_url },
      fields: fieldMappings.map((item) => ({ name: item.name })),
    },
    shortcut,
    context,
    runId,
    'direct_extract'
  );
}

async function callAdpJson<T>(
  endpoint: string,
  body: Record<string, unknown>,
  shortcut: FieldShortcutDefinition,
  context: FieldContext,
  runId: string,
  stage: string
): Promise<AdpResponse<T>> {
  const response = await context.fetch(
    getAdpUrl(endpoint),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Source': API_SOURCE,
        'accept-language': shortcut.adp.acceptLanguage || 'zh',
      },
      body: JSON.stringify(body),
    },
    ADP_AUTH_ID
  );
  const payload = (await readJson(response, `${runId}:${stage}`)) as AdpResponse<T>;
  debug(runId, `${stage}:response`, {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    code: payload.code,
    message: payload.message,
  });

  if (!response.ok) {
    return {
      ...payload,
      code: response.status,
      message: payload.message || `ADP 接口请求失败：HTTP ${response.status}`,
    };
  }

  return payload;
}

function getCustomFieldMappings(
  shortcut: FieldShortcutDefinition,
  formItemParams: Record<string, unknown>
): CustomFieldMapping[] {
  return shortcut.outputFields
    .map((item) => ({ key: item.key, name: normalizeRequestValue(formItemParams[item.key]) }))
    .filter((item) => Boolean(item.name));
}

async function buildAdpRequestBody(
  shortcut: FieldShortcutDefinition,
  formItemParams: Record<string, unknown> & { attachments?: ShortcutAttachment[] },
  context: FieldContext,
  runId: string
): Promise<Record<string, unknown>> {
  const adp = shortcut.adp;
  const body: Record<string, unknown> = {
    ...(adp.body || {}),
  };

  if ((adp.source || 'fileBase64') === 'formParams') {
    for (const key of adp.paramKeys || []) {
      const value = normalizeAdpParamValue(shortcut, key, formItemParams[key]);
      const formItem = shortcut.formItems?.find((item) => item.key === key);
      if (value === '') {
        if (formItem?.required !== false) {
          throw new ConfigError(`${getFormItemLabel(shortcut, formItem)}不能为空，请检查当前记录中该字段是否有值。`);
        }
        continue;
      }

      body[key] = value;
    }
  } else if ((adp.source || 'fileBase64') === 'fileUrl') {
    const attachment = formItemParams.attachments?.[0];
    debug(runId, 'attachment:selected', summarizeAttachment(attachment));

    if (!attachment?.tmp_url) {
      debug(runId, 'attachment:missing_tmp_url', summarizeAttachment(attachment));
      throw new ConfigError('请选择一个有效的附件字段。');
    }

    body[adp.fileUrlKey || 'file_url'] = attachment.tmp_url;
  } else {
    const attachment = formItemParams.attachments?.[0];
    debug(runId, 'attachment:selected', summarizeAttachment(attachment));

    if (!attachment?.tmp_url) {
      debug(runId, 'attachment:missing_tmp_url', summarizeAttachment(attachment));
      throw new ConfigError('请选择一个有效的附件字段。');
    }

    debug(runId, 'download:start');
    const fileBase64 = await downloadAttachmentAsBase64(attachment, context);
    debug(runId, 'download:success', {
      base64Length: fileBase64.length,
      estimatedBytes: Math.floor((fileBase64.length * 3) / 4),
    });

    body[adp.fileBase64Key || 'file_base64'] = fileBase64;

    if (adp.fileNameKey && attachment.name) {
      body[adp.fileNameKey] = attachment.name;
    }
  }

  if (adp.appId) {
    body.app_id = adp.appId;
  }

  if (adp.withRecResult !== undefined) {
    body.with_rec_result = adp.withRecResult;
  }

  return body;
}

class ConfigError extends Error {}

function normalizeAdpParamValue(
  shortcut: FieldShortcutDefinition,
  key: string,
  value: unknown
): string {
  const normalized = normalizeRequestValue(value);
  if (shortcut.id === 'invoice-verify' && key === 'fpDate') {
    return normalizeInvoiceVerifyDate(normalized);
  }

  return normalized;
}

function normalizeInvoiceVerifyDate(value: string): string {
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }

  return value;
}

function getFormItemLabel(shortcut: FieldShortcutDefinition, formItem: ShortcutFormItemDefinition): string {
  return buildI18nMessages(shortcut)['zh-CN']?.[formItem.label] || formItem.label || formItem.key;
}

function normalizeRequestValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map(normalizeRequestValue).filter(Boolean).join(',');
  }
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 100000000000) {
      return new Date(value).toISOString().slice(0, 10);
    }
    return String(value);
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  const object = getObject(value);
  if (object) {
    const direct = firstString(object, ['value', 'text', 'content', 'field_value']);
    if (direct) return direct;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function readJson(response: { text: () => Promise<string> }, runId: string) {
  const text = await response.text();
  debug(runId, 'adp:raw_response', {
    length: text.length,
    text,
  });

  try {
    return JSON.parse(text);
  } catch {
    return { code: 'error', message: text };
  }
}

function toFieldOutput(
  shortcut: FieldShortcutDefinition,
  data: ExtractData | undefined,
  attachment: ShortcutAttachment,
  formItemParams: Record<string, unknown> = {}
): FieldOutput {
  if (shortcut.adp.responseMode === 'stampRecognition') {
    return toStampRecognitionOutput(shortcut, data, attachment);
  }
  if (shortcut.adp.responseMode === 'documentReading') {
    return toDocumentReadingOutput(shortcut, data, attachment);
  }
  if (shortcut.adp.responseMode === 'customFieldExtraction') {
    return toCustomFieldExtractionOutput(shortcut, data, attachment, formItemParams);
  }
  if (shortcut.id === 'overseas-invoice-fast') {
    return toOverseasTicketOutput(shortcut, data, attachment);
  }

  const extraction = collectExtractionFields(data);
  debug('mapping', 'fields', {
    count: extraction.length,
    sample: extraction.slice(0, 12).map((item) => ({
      key: firstString(item, ['field_key', 'key']),
      name: firstString(item, ['field_name', 'name']),
      value: getItemValue(item),
    })),
  });

  const output = Object.fromEntries(
    shortcut.outputFields.map((item) => [
      item.key,
      item.summaryFromKeySets?.length || item.summaryFromKeys?.length
        ? getRowSummary(
            extraction,
            item.summaryFromKeySets || [item.summaryFromKeys || []],
            item.summaryRowDelimiter || ' | '
          )
        : getOutputFieldValue(
            extraction,
            item.valueKeys || [item.key],
            item.takeFirstArrayValue === true
          ),
    ])
  ) as FieldOutput;
  normalizeFieldOutput(shortcut, output);

  return {
    id: data?.task_id || `${shortcut.idPrefix || shortcut.id}-${attachment?.name ?? Date.now()}`,
    ...output,
  };
}

function toOverseasTicketOutput(
  shortcut: FieldShortcutDefinition,
  data: ExtractData | undefined,
  attachment: ShortcutAttachment
): FieldOutput {
  const topLevelFields = Array.isArray(data?.extraction_result) ? data.extraction_result : [];
  const ticketContainer = topLevelFields.map(getObject).find(isTicketContainer);
  const objectValues = Array.isArray(ticketContainer?.object_values)
    ? ticketContainer.object_values
    : [];
  const firstTicket = getObject(objectValues[0]);
  const ticketType = firstString(ticketContainer, ['field_name', 'name']);

  const extraction = firstTicket
    ? collectExtractionFields({
        extraction_result: Array.isArray(firstTicket.extraction_result)
          ? firstTicket.extraction_result
          : [],
        output_result: Array.isArray(firstTicket.output_result) ? firstTicket.output_result : [],
        tickets: firstTicket.tickets,
        result: getObject(firstTicket.result),
        metadata: getObject(firstTicket.metadata),
      })
    : collectExtractionFields(data);

  debug('mapping', 'overseas_ticket', {
    ticketType,
    ticketCount: objectValues.length,
    innerFieldCount: extraction.length,
    innerFieldKeys: extraction.slice(0, 12).map((item) =>
      firstString(item, ['field_key', 'key'])
    ),
  });

  const output = Object.fromEntries(
    shortcut.outputFields.map((item) => [
      item.key,
      item.key === 'ticket_type'
        ? ticketType
        : item.summaryFromKeySets?.length || item.summaryFromKeys?.length
          ? getRowSummary(
              extraction,
              item.summaryFromKeySets || [item.summaryFromKeys || []],
              item.summaryRowDelimiter || ' | '
            )
          : getOutputFieldValue(
              extraction,
              item.valueKeys || [item.key],
              item.takeFirstArrayValue === true
            ),
    ])
  ) as FieldOutput;

  return {
    id: data?.task_id || `${shortcut.idPrefix || shortcut.id}-${attachment?.name ?? Date.now()}`,
    ...output,
  };
}

function isTicketContainer(value: Record<string, unknown> | null): boolean {
  if (!value || !Array.isArray(value.object_values)) return false;

  return value.object_values.some((item) => {
    const ticket = getObject(item);
    if (!ticket) return false;

    const hasNestedExtraction =
      Array.isArray(ticket.extraction_result) || Array.isArray(ticket.output_result);
    const hasTicketMetadata = ['ticket_id', 'ticket_index', 'doc_type', 'pages'].some((key) =>
      Object.prototype.hasOwnProperty.call(ticket, key)
    );

    return hasNestedExtraction && hasTicketMetadata;
  });
}

function toCustomFieldExtractionOutput(
  shortcut: FieldShortcutDefinition,
  data: ExtractData | undefined,
  attachment: ShortcutAttachment,
  formItemParams: Record<string, unknown>
): FieldOutput {
  const fieldMappings = getCustomFieldMappings(shortcut, formItemParams);
  const extraction = Array.isArray(data?.extraction_result) ? data.extraction_result : [];
  const valuesByKey = Object.fromEntries(
    fieldMappings.map((mapping, index) => [mapping.key, getItemValue(extraction[index])])
  );
  const output = Object.fromEntries(
    shortcut.outputFields.map((item) => [item.key, valuesByKey[item.key] || ''])
  ) as FieldOutput;

  debug('mapping', 'custom_field_extraction', {
    requestedFieldCount: fieldMappings.length,
    resultFieldCount: extraction.length,
    configuredKeys: fieldMappings.map((item) => item.key),
    outputKeys: Object.keys(output),
  });

  return {
    id: data?.task_id || `${shortcut.idPrefix || shortcut.id}-${attachment?.name ?? Date.now()}`,
    ...output,
  };
}

function toStampRecognitionOutput(
  shortcut: FieldShortcutDefinition,
  data: ExtractData | undefined,
  attachment: ShortcutAttachment
): FieldOutput {
  const stamps = collectStamps(data?.doc_recognize_result);
  const output = Object.fromEntries(
    shortcut.outputFields.map((item) => [
      item.key,
      item.key === 'stamp_count'
        ? String(stamps.length)
        : item.key === 'stamp_info'
          ? stamps.map(formatStampInfo).join('\n')
          : '',
    ])
  ) as FieldOutput;

  debug('mapping', 'stamps', {
    pageCount: data?.doc_recognize_result?.length ?? 0,
    stampCount: stamps.length,
    outputKeys: Object.keys(output),
  });

  return {
    id: data?.task_id || `${shortcut.idPrefix || shortcut.id}-${attachment?.name ?? Date.now()}`,
    ...output,
  };
}

function toDocumentReadingOutput(
  shortcut: FieldShortcutDefinition,
  data: ExtractData | undefined,
  attachment: ShortcutAttachment
): FieldOutput {
  const pages = Array.isArray(data?.doc_recognize_result) ? data.doc_recognize_result : [];
  const documentContent = pages
    .map((page) => {
      const pageObject = getObject(page);
      if (!pageObject) return '';

      const content = valueToString(pageObject.document_content, true).trim();
      if (content) return content;

      const details = Array.isArray(pageObject.document_details) ? pageObject.document_details : [];
      return details
        .map((detail) => valueToString(getObject(detail)?.text, true).trim())
        .filter(Boolean)
        .join('\n');
    })
    .filter(Boolean)
    .join('\n\n');

  const output = Object.fromEntries(
    shortcut.outputFields.map((item) => [
      item.key,
      item.key === 'document_content' ? documentContent : '',
    ])
  ) as FieldOutput;

  debug('mapping', 'document_reading', {
    pageCount: pages.length,
    contentLength: documentContent.length,
    outputKeys: Object.keys(output),
  });

  return {
    id: data?.task_id || `${shortcut.idPrefix || shortcut.id}-${attachment?.name ?? Date.now()}`,
    ...output,
  };
}

function collectStamps(pages: unknown[] | undefined): Record<string, unknown>[] {
  if (!Array.isArray(pages)) return [];

  return pages.flatMap((page) => {
    const stamps = getObject(page)?.stamps;
    if (!Array.isArray(stamps)) return [];
    return stamps.map(getObject).filter((stamp): stamp is Record<string, unknown> => Boolean(stamp));
  });
}

function formatStampInfo(stamp: Record<string, unknown>, index: number): string {
  const texts = Array.isArray(stamp.texts)
    ? stamp.texts.map((item) => valueToString(item, true)).filter(Boolean).join('、')
    : valueToString(stamp.texts, true);

  return [
    `印章 ${index + 1}`,
    `颜色：${valueToString(stamp.color_description, true)}`,
    `形状：${valueToString(stamp.shape_description, true)}`,
    `文字：${texts}`,
  ].join('\n');
}

function normalizeFieldOutput(shortcut: FieldShortcutDefinition, output: FieldOutput): void {
  if (shortcut.id !== 'invoice-verify') return;
  if (!output.fpVerificationMsg) return;
  if (output.fpVerificationMsg.includes('支持电子发票增值税专用发票')) return;

  output.fpVerificationMsg = `${output.fpVerificationMsg}。支持电子发票增值税专用发票、电子发票普通发票、电子发票航空运输电子客票行程单、电子发票铁路电子客票`;
}

function collectExtractionFields(data: ExtractData | undefined): unknown[] {
  const result: unknown[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const object = getObject(value);
    if (!object) return;

    result.push(object);

    visit(object.object_values);
    visit(object.table_values);
    visit(object.extraction_result);
    visit(object.output_result);
    visit(object.tickets);
  };

  visit(data?.extraction_result);
  visit(data?.output_result);
  visit(data?.tickets);
  visit(data?.result);
  visit(data?.metadata);

  return result;
}

function getOutputFieldValue(
  fields: unknown[],
  targetKeys: string[],
  takeFirstArrayValue = false
): string {
  for (const key of targetKeys) {
    const value = getFieldValueByExactKey(fields, key, takeFirstArrayValue);
    if (value) return value;
  }

  return '';
}

function getFieldValueByExactKey(
  fields: unknown[],
  targetKey: string,
  takeFirstArrayValue = false
): string {
  for (const fieldItem of fields) {
    const object = getObject(fieldItem);
    if (object && Object.prototype.hasOwnProperty.call(object, targetKey)) {
      return valueToString(object[targetKey], takeFirstArrayValue);
    }

    const key = firstString(fieldItem, ['field_key', 'key']);
    if (key === targetKey) {
      return getItemValue(fieldItem, takeFirstArrayValue);
    }
  }

  return '';
}

function getRowSummary(
  fields: unknown[],
  fieldKeySets: string[][],
  rowDelimiter = ' | '
): string {
  for (const fieldKeys of fieldKeySets) {
    const tableSummary = getTableRowSummary(fields, fieldKeys, rowDelimiter);
    if (tableSummary) return tableSummary;
  }

  for (const fieldKeys of fieldKeySets) {
    const columns = fieldKeys.map((key) => getFieldValueListByExactKey(fields, key));
    const rowCount = Math.max(0, ...columns.map((values) => values.length));
    const summary = Array.from({ length: rowCount }, (_, index) =>
      columns.map((values) => values[index] || '').join('/')
    )
      .filter((row) => row.replace(/\//g, '').trim())
      .join(rowDelimiter);
    if (summary) return summary;
  }

  return '';
}

function getTableRowSummary(
  fields: unknown[],
  fieldKeys: string[],
  rowDelimiter = ' | '
): string {
  const rows: string[] = [];

  for (const fieldItem of fields) {
    const tableValues = getObject(fieldItem)?.table_values;
    if (!Array.isArray(tableValues)) continue;

    for (const tableRow of tableValues) {
      if (!Array.isArray(tableRow)) continue;

      const row = fieldKeys
        .map((key) => getTableRowFieldValue(tableRow, key))
        .join('/');
      if (row.replace(/\//g, '').trim()) rows.push(row);
    }
  }

  return rows.join(rowDelimiter);
}

function getTableRowFieldValue(tableRow: unknown[], targetKey: string): string {
  for (const fieldItem of tableRow) {
    const key = firstString(fieldItem, ['field_key', 'key']);
    if (key === targetKey) return getItemValue(fieldItem, true);
  }

  return '';
}

function getFieldValueListByExactKey(fields: unknown[], targetKey: string): string[] {
  for (const fieldItem of fields) {
    const object = getObject(fieldItem);
    if (object && Object.prototype.hasOwnProperty.call(object, targetKey)) {
      return toValueList(object[targetKey]);
    }

    const key = firstString(fieldItem, ['field_key', 'key']);
    if (key !== targetKey) continue;

    for (const valueKey of ['value', 'text', 'content', 'field_value', 'normalized_value']) {
      if (object && Object.prototype.hasOwnProperty.call(object, valueKey)) {
        return toValueList(object[valueKey]);
      }
    }

    if (Array.isArray(object?.field_values)) {
      return toValueList(object.field_values);
    }
  }

  return [];
}

function toValueList(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(toValueList);

  const object = getObject(value);
  if (object) {
    for (const valueKey of ['value', 'text', 'content', 'field_value', 'normalized_value']) {
      if (Object.prototype.hasOwnProperty.call(object, valueKey)) {
        return toValueList(object[valueKey]);
      }
    }

    if (Array.isArray(object.field_values)) {
      return object.field_values.flatMap(toValueList);
    }
  }

  const normalized = valueToString(value, true);
  return normalized ? [normalized] : [];
}

function valueToString(value: unknown, takeFirstArrayValue = false): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (!takeFirstArrayValue || !value.length) return takeFirstArrayValue ? '' : stringifyCompact(value);
    return getItemValue(value[0], true) || valueToString(value[0], true);
  }

  if (takeFirstArrayValue) {
    const object = getObject(value);
    if (object) {
      for (const key of ['value', 'text', 'content', 'field_value', 'normalized_value']) {
        if (Object.prototype.hasOwnProperty.call(object, key)) {
          return valueToString(object[key], true);
        }
      }

      if (Array.isArray(object.field_values)) {
        return object.field_values.length ? valueToString(object.field_values[0], true) : '';
      }
    }
  }

  return stringifyCompact(value);
}

function getItemValue(fieldItem: unknown, takeFirstArrayValue = false): string {
  const direct = firstString(fieldItem, ['value', 'text', 'content', 'field_value', 'normalized_value']);
  if (direct) return direct;

  if (takeFirstArrayValue) {
    const object = getObject(fieldItem);
    for (const key of ['value', 'text', 'content', 'field_value', 'normalized_value']) {
      const value = valueToString(object?.[key], true);
      if (value) return value;
    }
  }

  const values = getObject(fieldItem)?.field_values;
  if (takeFirstArrayValue && Array.isArray(values) && values.length) {
    return getItemValue(values[0], true) || valueToString(values[0], true);
  }
  const nested = Array.isArray(values)
    ? values
        .map((item) =>
          firstString(item, ['field_value', 'value', 'text', 'content', 'normalized_value'])
        )
        .find(Boolean)
    : '';
  if (nested) return nested;

  return '';
}

function firstString(value: unknown, keys: string[]): string {
  const object = getObject(value);
  if (!object) return typeof value === 'string' ? value : '';

  for (const key of keys) {
    const current = object[key];
    if (typeof current === 'string' && current.trim()) return current.trim();
    if (typeof current === 'number' && Number.isFinite(current)) return String(current);
  }

  return '';
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringifyCompact(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function getAdpUrl(endpoint: string): string {
  return `${ADP_BASE_URL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
}

function isSuccessCode(code: string | number | undefined): boolean {
  return code === 'success' || code === 200 || code === 0 || code === undefined;
}

function isAdpFailure(result: AdpResponse): boolean {
  return !isSuccessCode(result.code) || getAdpBusinessStatus(result) === 5;
}

function getAdpBusinessStatus(result: AdpResponse): number | undefined {
  const status = getObject(result.data)?.status;
  if (typeof status === 'number') return status;
  if (typeof status === 'string' && /^\d+$/.test(status)) return Number(status);
  return undefined;
}

function getAdpBusinessMessage(result: AdpResponse): string {
  const data = getObject(result.data);
  return firstString(data, ['message', 'tips']);
}

function getAdpErrorText(result: AdpResponse): string {
  return [result.message, result.tips, getAdpBusinessMessage(result)]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .join(' ');
}

function mapAdpErrorCode(result: AdpResponse): FailureCode {
  const message = getAdpErrorText(result).toLowerCase();
  if (
    message.includes('unauthorized') ||
    message.includes('api key') ||
    message.includes('apikey') ||
    message.includes('accessor not found')
  ) {
    return FieldCode.AuthorizationError;
  }
  if (isAdpQuotaExhaustedMessage(message)) {
    // Use an ADP-specific error message instead of the platform quota message.
    return FieldCode.Error;
  }
  if (message.includes('rate limit') || message.includes('限流')) {
    return FieldCode.RateLimit;
  }
  return FieldCode.Error;
}

function getAdpErrorMessage(result: AdpResponse): string {
  const hint = getAdpErrorHint(result);
  if (hint) return hint;

  return getAdpErrorText(result) || 'ADP 接口返回失败。';
}

function getAdpErrorHint(result: AdpResponse): string {
  const message = getAdpErrorText(result).toLowerCase();
  if (message.includes('accessor not found')) {
    return 'ADP API key 无效，或本地调试 config.json 仍未填入真实 API key。请在 dingding/config.json 的 authorizations["X-API-KEY"] 填写真实 ADP API key 后重启 npm start。';
  }
  if (isAdpQuotaExhaustedMessage(message)) {
    return `配额积分不足，如需继续使用请前往官网充值。${ADP_RECHARGE_GUIDE_URL}`;
  }

  return '';
}

function isAdpQuotaExhaustedMessage(message: string): boolean {
  return (
    message.includes('quota') ||
    message.includes('credit') ||
    message.includes('point') ||
    message.includes('balance') ||
    message.includes('余额') ||
    message.includes('积分') ||
    message.includes('额度')
  );
}

function isAuthorizationLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /authorization|unauthorized|api key|apikey|accessor not found|401|403/i.test(message);
}

function fail(code: FailureCode, msg: string) {
  console.error(`${DEBUG_PREFIX} return:fail`, { code, msg: truncate(msg, 1000) });
  return {
    code,
    msg,
    ...(code === FieldCode.Error
      ? { errorMessage: isAdpQuotaExhaustedMessage(msg.toLowerCase()) ? 'adpQuotaExhausted' : 'adpRequestFailed' }
      : {}),
    extra: { adpMessage: truncate(msg, 1000) },
  };
}

function createRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function debug(runId: string, stage: string, data?: unknown): void {
  if (data === undefined) {
    console.log(`${DEBUG_PREFIX} ${runId} ${stage}`);
    return;
  }

  console.log(`${DEBUG_PREFIX} ${runId} ${stage}`, data);
}

function summarizeContext(context: FieldContext) {
  return {
    baseId: context.baseId,
    sheetId: context.sheetId,
    extensionId: context.extensionId,
    tenantId: context.tenantId,
    hasFetch: typeof context.fetch === 'function',
  };
}

function summarizeAttachment(attachment: ShortcutAttachment | undefined) {
  if (!attachment) return { exists: false };

  return {
    exists: true,
    name: attachment.name,
    size: attachment.size,
    type: attachment.type,
    hasTmpUrl: Boolean(attachment.tmp_url),
    tmpUrlHost: getUrlHost(attachment.tmp_url),
    tmpUrlLength: attachment.tmp_url?.length ?? 0,
  };
}

function summarizeAdpResponse(result: AdpResponse<ExtractData>) {
  const data = result.data;
  return {
    code: result.code,
    message: result.message,
    tips: result.tips,
    hasData: Boolean(data),
    taskId: data?.task_id,
    status: data?.status,
    extractionCount: data?.extraction_result?.length ?? 0,
    outputCount: data?.output_result?.length ?? 0,
    resultKeys: data?.result ? Object.keys(data.result) : [],
    metadataKeys: data?.metadata ? Object.keys(data.metadata) : [],
    classifyKeys: data?.classify_result ? Object.keys(data.classify_result as Record<string, unknown>) : [],
    dataKeys: data ? Object.keys(data) : [],
  };
}

function summarizeOutput(output: FieldOutput) {
  return Object.fromEntries(
    Object.entries(output).map(([key, value]) => [
      key,
      {
        type: value === null ? 'null' : typeof value,
        length: typeof value === 'string' ? value.length : undefined,
        preview: typeof value === 'string' ? truncate(value, 120) : value,
      },
    ])
  );
}

function summarizeHeaders(headers: { forEach?: (callback: (value: string, key: string) => void) => void }) {
  const result: Record<string, string> = {};
  headers?.forEach?.((value, key) => {
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes('authorization') || lowerKey.includes('api-key')) {
      result[key] = '[redacted]';
      return;
    }

    result[key] = truncate(value, 160);
  });
  return result;
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: truncate(error.stack ?? '', 3000),
    };
  }

  return { value: truncate(String(error), 3000) };
}

function getUrlHost(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...<truncated>` : value;
}

export default fieldDecoratorKit;
