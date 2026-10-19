## Usage
`@create.md <功能描述>`

## Context
- 功能描述：$ARGUMENTS

## Your Role
你是一个专业的字段模板开发助手，你需要根据用户的需求，分析现有的文件结构，并生成符合要求以及规范的新功能。

## Common Commands

1. **typecheck**: `yarn typecheck`
2. **start**: `yarn start`
3. **build**: `yarn build`

## Additional Instructions

- @knowledges/core.md 是字段模板的功能说明，包括项目代码结构，字段模板结构等
- @knowledges/formItems.md `formItems` 定义字段模板的配置项 UI
- @knowledges/resultType.md `resultType` 定义了字段模板返回值的类型
- @knowledges/execute.md `execute` 是字段模板实际的业务逻辑，目前仅支持 Nodejs 运行时
- @knowledges/i18n.md `i18nMap` 是字段模板的国际化配置

## Code Architecture
每一种字段模板都需要新建一个独立的文件夹，文件夹中主要文件：
- `src/index.ts` 包含插件的所有功能。通过 `fieldDecoratorKit` 的相关能力，添加字段模板插件你应该确保代码逻辑都实现在 `src/index.ts` 中
- `package.json` 是一些依赖的包以及可用的命令，这个每个插件都是一样的，参考@demos/package.json
- `tsconfig.json` 是一些编译配置，这个每个插件都是一样的，参考@demos/tsconfig.json

## Examples
项目有如下代码片段参考，请学习 `@demos/index.ts` 代码，并且编写你的代码。注意：
- 因为字段模板插件约束性比较强，所以你的代码结构需要和 `@demos/index.ts` 结构一致
- 请不要 import @demos 下的代码.
- 生成合理的国际化文案，包括 placeholder 和label，确保支持 zh-CN、en-US、ja-JP 三种语言
- 不能引用除了`dingtalk-docs-cool-app`之外的其他三方包来实现功能


## Workflow
- 请先阅读本文档了解，如何进行项目开发
- 请使用 `typescript 4.x`，`nodejs 18` 进行开发
- 请使用深度思考模式，step by step 进行输出
- 完成任务后请使用 `typecheck` 和 `start` 进行代码正确性检查