# RoadFlow WPS 编辑插件

RoadFlow WPS 编辑插件是一个运行在 Qaxbrowser 中的浏览器扩展，用于把
OA 系统中的 Word、WPS 和 Excel 文档链接交给客户电脑上已安装的 WPS
打开、编辑和保存。

插件以 OA 页面为文档来源，以本地 WPS Writer 或 WPS ET 为编辑器，并将
保存后的文档提交回 OA 的 `OfficeSave` 接口。当前 RoadFlow 的主要交付物
是固定扩展 ID 的签名 CRX。

本仓库还保留了 `extension/` 目录下较早的 Native Messaging、本地 Agent
和 ARM64 DEB 方案。该方案与当前 RoadFlow 直连 OA 的 CRX 方案是两条不同
的产品路径，不能混用安装脚本、扩展 ID 或 OA 接口契约。

## 项目解决的问题

客户 OA 通常把 Word 或 Excel 文件展示为普通下载链接。直接点击会下载一
份副本，无法复用本地 WPS 的编辑能力，也无法可靠地把修改后的内容保存
回 OA 原文档。部分 OA 表单还会通过一个或多个 `iframe` 嵌套加载，只有
顶层页面监听点击时，插件就会漏掉实际发生在表单内的文档点击。

RoadFlow WPS 编辑插件解决的是浏览器、OA 和本地 WPS 之间的集成边界：

- 拦截 OA 页面和同源 `iframe` 中的受支持文档链接；
- 在新的浏览器标签页打开编辑页，同时保留原 OA 标签页和 iframe 状态；
- 让本地 WPS 直接打开原始 HTTP/HTTPS 文档地址；
- 在允许编辑前校验文档字节和格式；
- 在 WPS Writer 中开启修订，在 WPS ET 中开启变更历史和屏幕高亮；
- 将编辑结果提交到 OA 已有的认证保存接口；
- 点击“返回”后回到发起编辑的 OA 标签页，iframe 场景也保持原页面状态。

插件不是纯 Web 文档编辑器：WPS 负责 Office 文档的渲染和编辑，插件负
责链接拦截、文档校验、WPS API 调用和返回导航，OA 负责用户认证、授权和
最终文件存储。

## 功能说明

### 支持的文档格式

- Word：`.doc`、`.docx`、`.wps`；
- Excel：`.xls`、`.xlsx`。

插件根据文件扩展名选择 WPS 编辑表面：Word 使用
`application/x-wps`，Excel 使用 `application/x-et`。`.docx` 或 `.xlsx`
在 WPS 保存后可能变成同一 Office 家族的传统 CFB 格式；同家族序列化可
被接受，损坏文件和跨家族格式会被拒绝。

### OA 链接和 iframe

- 支持普通 HTTP/HTTPS `<a href="...">` 文档链接；
- 内容脚本在所有 frame 中运行，支持嵌套的同源 OA iframe；
- 点击文档后在新标签页打开编辑器，不在原 OA 标签页直接下载；
- 编辑器按钮名称为“返回”，会关闭编辑标签页并回到原 OA 标签页；
- 如果链接来自 iframe，返回后原 OA 页面和 iframe 仍保持原来的页面状态；
- 非主键点击、带修饰键的点击、不支持的扩展名和不可信/跨域链接保留浏览器
  默认行为。

生产环境建议在设置中填写精确的 Trusted OA Origin。配置为空可以用于受
控测试，但会扩大扩展请求的 HTTP/HTTPS 站点权限。

### 修订和变更显示

对于 Writer 文档，插件在解锁编辑前开启跟踪修订，并显示插入、删除以及
批注相关的修订视图。

对于 Excel 文档，插件调用 WPS ET 工作簿接口。如果工作簿处于独占编辑模
式，会先通过 `SaveAs(..., accessMode=2)` 切换到共享修订模式，然后：

- 开启 `KeepChangeHistory`；
- 请求 `HighlightChangesOptions(3, "Everyone")`，显示所有人的变更；
- 开启 `HighlightChangesOnScreen`；
- 将 `ListChangesOnNewSheet` 设为 `false`，不额外创建变更清单页。

### 保存方式

Word 和 Excel 必须使用各自 WPS 应用提供的原生保存 API，不能把 Excel
保存简单替换成 Word 的调用方式：

| 格式 | 本地 WPS 操作 | OA 上传形式 |
| --- | --- | --- |
| `.doc`、`.docx`、`.wps` | `Document.saveURL_FormData(officeSaveURL, "formId:formeditor")` | `md5sum`、`filename=formId:formeditor` 和 `filedata` |
| `.xls`、`.xlsx` | 先调用 `Workbook.Save()`，再调用 `Application.SaveDocumentToServer(officeSaveURL)` | ET 将原始工作簿作为 multipart 字段 `file` 发送，通常文件名为空 |

Excel 不复用 Writer 的 `saveURL_FormData`。OA 的 `OfficeSave` 后端必须同
时兼容上述两种请求，校验请求对应的授权文档后再原子替换原文件。

## 架构和数据流

当前 RoadFlow 使用直连 OA 的浏览器托管 WPS 路径：

```text
OA 页面或 iframe
    -> RoadFlow 内容脚本
    -> 文档身份和格式校验
    -> 新的 OA Origin Blob 编辑页
    -> WPS Writer（application/x-wps）或 WPS ET（application/x-et）
    -> OA /RoadFlow/uploadfiles/OfficeSave
    -> 原 OA 标签页或 iframe
```

当前直连路径不需要 Gateway、Native Messaging Host、本地 Agent、DEB、常驻
服务或 OA 页面 SDK。但它要求：

1. OA 文档原始 URL 可以被 WPS 直接读取；
2. OA 保留现有的认证和授权逻辑；
3. OA 提供兼容 Word 和 Excel 请求形式的 `OfficeSave` 接口；
4. 浏览器、WPS 和 NPAPI 浏览器插件在客户机器上可用。

## 快速开始

### 环境要求

- Go `1.23.2`，用于 Go 构建和测试；
- Node.js 和 npm，用于浏览器测试；
- 已安装 WPS 浏览器插件的 Qaxbrowser；
- 能提供 `application/x-wps` 和 `application/x-et` 的 WPS 安装；
- 一个提供受支持文档链接的本地或客户 OA。

本地 Demo 和自动化测试只能验证实现契约，不能替代客户环境验收。正式验
收必须使用客户实际的 Qaxbrowser、WPS 版本、OA Origin、登录状态和可丢弃
的测试文档。

### 启动 Excel 保存 Demo

Excel Demo 可以接受真实 WPS ET 的 `SaveDocumentToServer` 请求，并记录请求
字段、提交字节数和 MD5。默认源文件为
`/tmp/file-editor/uploads/工作簿1.xls`；如果该文件不存在，请设置
`ROADFLOW_EXCEL_DEMO_FILE`。

```sh
ROADFLOW_EXCEL_DEMO_FILE=/path/to/test.xls \
ROADFLOW_EXCEL_DEMO_STATE=/tmp/roadflow-excel-save-demo \
node prototypes/roadflow-excel-save-demo/server.mjs
```

在 Qaxbrowser 打开 <http://127.0.0.1:4318/>。Demo 提供：

- `GET /healthz`：检查 Demo 是否运行；
- `GET /diagnostics`：查看当前 MD5、收到的 multipart 字段和成功保存记录；
- `POST /RoadFlow/uploadfiles/OfficeSave?fileurl=/UploadFiles/2026/Acceptance.xls`：
  编辑器使用的保存接口。

使用以下命令生成可加载的未打包 RoadFlow 扩展：

```sh
OUTPUT=/tmp/roadflow-extension-dev \
VERSION=1.0.21 \
bash ./scripts/stage-roadflow-extension.sh
```

在 Qaxbrowser 打开 `chrome://extensions`，启用“开发者模式”，选择“加载已
解压的扩展程序”，目录选择 `/tmp/roadflow-extension-dev`。在扩展设置中将
Trusted OA Origin 配置为：

```text
http://127.0.0.1:4318
```

点击“打开 Acceptance.xls”，在 WPS 中修改单元格，点击“保存”，检查
`/diagnostics`，最后点击“返回”。成功记录应包含：

```text
transport=wps-et-save-document-to-server
status=200
```

### 启动本地 Word 模拟器

Go 模拟器在 `4317` 端口提供直连 OA 的 Word 验收路径：

```sh
bash ./scripts/run-roadflow-simulator.sh
```

打开 <http://127.0.0.1:4317/>，模拟登录，打开验收文档，在 WPS 中编辑、保
存并返回。详细步骤见
[`docs/roadflow-local-manual-acceptance-zh.md`](docs/roadflow-local-manual-acceptance-zh.md)。

## 构建和测试

在仓库根目录运行完整 Go 测试和浏览器测试：

```sh
go test ./...
npm install
npm run test:browser
```

浏览器测试覆盖 Writer 和 ET 编辑表面、修订初始化、保存失败重试、返回行
为、iframe 相关 handoff 数据、编辑器响应式布局以及 Excel 原生保存契约。

### 构建未打包 RoadFlow 扩展

该命令复制 RoadFlow 扩展资源，并将指定版本写入 manifest，不需要发布密钥：

```sh
OUTPUT=/tmp/roadflow-extension \
VERSION=1.0.21 \
bash ./scripts/stage-roadflow-extension.sh
```

RoadFlow 固定扩展 ID 为：

```text
bojjhibgkhknccepabkojdjodhhgdjfd
```

### 构建签名 CRX

签名构建需要供应方持有的加密 RoadFlow 发布密钥和指定的 Qaxbrowser。脚本
默认拒绝覆盖已经存在的输出文件。

```sh
ROADFLOW_CRX_RELEASE_KEY=/secure/roadflow-crx-release.pem \
VERSION=1.0.21 \
bash ./scripts/package-roadflow-crx.sh
```

默认输出路径为：
`dist/release/roadflow-wps-editor-1.0.21.crx`。

如果发布密钥缺少口令，脚本会在 OpenSSL 口令提示处停止，不会生成可用的签
名包。CRX 生成后还应记录 SHA-256，并在客户机器确认固定扩展 ID。

### 构建历史 Native Messaging / Kylin 包

仓库仍保留早期 Local WPS Editing 路径。该路径使用 `extension/`、Native
Messaging、本地 Agent 和 ARM64 DEB，不是当前 RoadFlow 直连 OA 的 CRX：

```sh
OUTPUT=/tmp/local-wps-extension VERSION=1.0.1 \
bash ./scripts/stage-extension.sh
MAINTAINER='Supplier Support <support@example.com>' \
bash ./scripts/build-deb-arm64.sh
```

只有在维护历史路径时才阅读
[`docs/customer-installation.md`](docs/customer-installation.md)。当前 RoadFlow
CRX 的安装说明见
[`docs/roadflow-customer-installation.md`](docs/roadflow-customer-installation.md)。

## OA 集成契约

### 文档来源

文档链接必须是 HTTP/HTTPS 地址，并且路径以受支持的扩展名结尾。WPS 必须能
直接读取该地址。仅在浏览器中经过重定向、登录挑战页，或依赖 JavaScript
临时拼接出另一个下载请求的链接，不保证兼容。

插件在打开 WPS 前会读取并校验文档字节，当前限制为：

- 压缩输入最大 `25 MiB`；
- 压缩包成员最多 `2,048` 个；
- 解压后内容最大 `100 MiB`；
- 压缩包最大膨胀比 `100:1`。

### OfficeSave 接口

OA 必须在 `fileurl` 查询参数中保留精确的原始文档路径，并根据当前登录用
户和服务端管理的覆盖目标进行授权。接口应在完成校验和原子替换后，才返回
结构化的成功响应。

Writer 请求保持原有的严格 multipart 契约：

```text
md5sum=<filedata 的小写 MD5>
filename=formId:formeditor
filedata=<序列化后的 Word 文档>
```

Excel 请求使用 ET 原生形式：

```text
file=<序列化后的 XLS 或 XLSX 工作簿>
```

ET 请求不包含 Writer 的 `md5sum` 和 `filename=formId:formeditor` 字段，且
multipart 文件名通常为空。服务端应自行计算收到内容的 MD5，根据原始扩展
名校验文件格式，并只替换已经授权的目标。参考实现和契约测试位于：

- [`roadflowoa/office_save.go`](roadflowoa/office_save.go)；
- [`roadflowoa/office_save_test.go`](roadflowoa/office_save_test.go)。

### 认证和 Origin

插件可以配置精确的 Trusted OA Origin，也可以在受控测试中使用全 Origin
模式。生产环境应填写准确的协议、主机和可选端口，不要无必要地扩大站点权
限。OA 负责会话认证、授权和文件存储，插件不会接收或保存 OA 密码、Token。

## 约束和注意事项

- Qaxbrowser 必须启用 WPS NPAPI/浏览器插件；没有该插件的普通浏览器页面
  无法渲染 WPS 编辑表面。
- 当前假设一个文档同时只有一个编辑器，不提供多用户并发冲突解决能力。
- 从浏览器校验到 WPS 打开和保存期间，OA 原始 URL 应保持稳定。直连 OA 模式
  没有 Gateway Delivery Receipt。
- 插件不会拦截任意 JavaScript 下载、不支持的格式、受限模式下的跨域链接、
  修饰键点击或非主键点击。
- 保存失败时，WPS 编辑器会保留当前内容并允许显式重试；保存失败后点击返
  回，需要用户确认放弃内存中的修改。
- 不要使用历史 `extension/` 的打包脚本部署 RoadFlow CRX；两条路径的扩展
  ID、权限和安装契约不同。
- 问题报告和验收记录中不要包含客户 Cookie、文档内容、业务路径、Token 或
  未脱敏的 WPS 日志。
- 客户正式验收必须在指定机器执行；本地 Demo 和自动化测试只能证明实现契
  约，不能证明所有客户 Qaxbrowser/WPS 版本都兼容。

## 常见问题排查

### 提示“Document verification failed”

检查链接是否使用受支持的扩展名，响应内容是否是真实文档而不是 HTML 登录页
或挑战页，文档字节是否稳定，以及 Trusted OA Origin 是否同时匹配当前页面
和文档来源 Origin。

### 提示“WPS ActiveWorkbook 创建超时”或编辑器空白

检查 Qaxbrowser 是否加载 WPS 插件、WPS 是否已安装，并确认 Excel 使用
`application/x-et`、Word 使用 `application/x-wps`。在扩展之外直接用 WPS
打开原始文档 URL，确认 WPS 能读取该地址。

### Excel 可以打开但保存失败

同时检查浏览器控制台和 OA 服务端的 `OfficeSave` 请求。Excel 应发送名为
`file` 的 multipart 部件；Word 应发送 `filedata`、`md5sum` 和 `filename`
字段。重点核对：

1. `fileurl` 是否为原始文档路径；
2. 登录会话是否仍有效；
3. 覆盖目标是否授权给当前用户；
4. HTTP 状态码和 OA 返回体是否表示真正完成覆盖；
5. 收到的文档是否与 `.xls`/`.xlsx` 扩展名属于同一格式家族。

本地 Demo 可通过以下命令查看请求：

```sh
curl -sS http://127.0.0.1:4318/diagnostics | jq
```

只支持 Word multipart 契约的旧 OA 保存处理器会拒绝 ET 请求，即使 WPS 已经
成功完成本地工作簿保存。

## 仓库目录

| 路径 | 用途 |
| --- | --- |
| `roadflow-extension/` | 当前 RoadFlow 直连 OA CRX 源码和浏览器测试 |
| `roadflowoa/` | 认证 OA 覆盖保存契约和文档格式校验 |
| `roadflowgateway/` | 可选/参考 Gateway 和编辑 handoff 契约 |
| `roadflowsimulator/` | Word 直连 OA 本地 Go 模拟器 |
| `prototypes/roadflow-excel-save-demo/` | 真实 WPS ET Excel 保存 Demo |
| `scripts/stage-roadflow-extension.sh` | 构建未打包 RoadFlow 扩展资源 |
| `scripts/package-roadflow-crx.sh` | 构建签名 RoadFlow CRX |
| `extension/`、`cmd/native-host/` | 历史 Native Messaging/本地 Agent 路径 |
| `docs/` | 客户安装、验收、架构决策和研究资料 |

## 相关文档

- [`docs/roadflow-customer-installation.md`](docs/roadflow-customer-installation.md)：
  当前 RoadFlow CRX 的安装和配置；
- [`docs/roadflow-production-acceptance.md`](docs/roadflow-production-acceptance.md)：
  客户机器正式验收清单；
- [`docs/roadflow-local-manual-acceptance-zh.md`](docs/roadflow-local-manual-acceptance-zh.md)：
  中文本地手工验收流程；
- [`docs/roadflow-local-simulated-acceptance-result.md`](docs/roadflow-local-simulated-acceptance-result.md)：
  本地模拟器的范围和验证证据；
- [`docs/adr/0006-use-browser-hosted-wps-for-roadflow.md`](docs/adr/0006-use-browser-hosted-wps-for-roadflow.md)：
  浏览器托管 WPS 路径的架构决策；
- [`docs/customer-installation.md`](docs/customer-installation.md)：
  历史 Native Messaging/DEB 安装路径。
