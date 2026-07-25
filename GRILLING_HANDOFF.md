# WPS 浏览器插件 PoC：Grilling 交接文档

更新日期：2026-07-25

## 1. 项目目标

开发一个供客户内网使用的浏览器扩展，使用户点击业务系统中的 WPS 文档链接后，能够调用终端已安装的 WPS 打开 DOCX。用户在 WPS 中执行保存后，本地组件自动把新文件回传服务端。

第一阶段只开发通用 Demo，不适配客户现有业务系统；后续通过接口或链接适配接入客户环境。

## 2. 已确认的产品与技术决策

### 2.1 产品形态

- 不再追求把 WPS 原生窗口内嵌到浏览器页面。
- 采用独立 WPS 窗口。
- 客户允许安装本地辅助程序，也允许管理员配置奇安信浏览器扩展策略。
- 完整交付不能只有 CRX；浏览器扩展之外必须有本地程序。
- 目标架构：

```text
文档链接
  -> 奇安信可信浏览器 Manifest V3 扩展
  -> Native Messaging Host
  -> 本地编辑代理
  -> WPS 文字独立窗口
  -> 用户执行保存
  -> 代理检测稳定的新文件
  -> 回传服务端
```

### 2.2 保存语义

- 用户可以自由编辑。
- 只有用户在 WPS 中执行保存后，才允许回传。
- 未保存的内存修改不能回传。
- 第一阶段不依赖未证实的 WPS Linux 保存事件或 SDK。
- 建议通过监控受控工作目录，兼容“临时文件写入后 rename 覆盖”等保存方式。
- 检测到文件内容形成稳定新版本后，先复制不可变快照，再上传。
- 内容哈希相同的重复保存不重复提交。
- 上传失败必须保留快照并允许重试。
- “本地已保存”和“服务器已提交”是不同状态；只有服务器确认后才能显示回传成功。

### 2.3 并发模型

采用单人排他编辑：

- 第一位用户获得编辑租约；
- 其他用户只能只读或等待；
- 锁应有续租和超时回收；
- 上传仍需基于服务器版本或 ETag 做条件提交；
- 冲突时保留本地文件，禁止静默覆盖。

此能力在通用 Demo 服务中实现；后续适配客户系统时，若客户后端没有锁和版本接口，需要协商增加接口或降低保证等级。

### 2.4 第一版格式范围

- 只支持 DOCX。
- 只调用 WPS 文字。
- XLSX、PPTX、旧格式和 PDF 均不在第一版范围内。

### 2.6 V1 本地程序技术选型

- V1 本地程序采用 Go；
- 选型优先级是 AI Coding Agent 开发成功率、跨平台构建便利性、生态成熟度，以及足够的性能和稳定性；
- 优先使用 Go 标准库，避免为 V1 引入不必要的框架和抽象；
- V1 只构建和验证 macOS arm64，不提前实现 Linux 或 Windows；
- 源码保留小型平台适配边界，路线验证成功后再增加其他平台的构建、安装和真机验证；
- Rust 仅在未来出现明确的系统级、资源控制或安全审计要求时重新评估。

### 2.7 V1 Demo 服务边界

- V1 使用真实但最小的 HTTP Demo 服务，完整验证浏览器触发后的 DOCX 下载与上传回传；
- 不使用“本地源目录复制到结果目录”替代网络传输；
- V1 服务只需要 Demo 页面、原始 DOCX 下载、修改后 DOCX 上传，以及结果文件下载或查看；
- V1 不需要数据库、登录态、编辑锁、ETag、版本控制或复杂重试。

### 2.8 V1 WPS 启动方式

- 本地代理以 macOS Launch Services 启动 WPS：`open -a wpsoffice <工作副本绝对路径>`；
- 不依赖 WPS 内部二进制路径、命令行参数或进程退出；
- 启动命令成功返回后，本地代理立即监控该工作副本；
- 若实测发现 WPS 未正确打开指定 DOCX，再以实测结果调整适配；不在 V1 阶段预先猜测内部启动参数。

### 2.9 V1 保存检测与回传规则

- 本地代理每 500ms 轮询工作副本的存在、大小和修改时间；
- 检测到变化后，连续 2 秒大小和修改时间不变，才视为稳定的新工作副本版本；
- 对稳定版本计算 SHA-256；哈希不同于最近一次成功上传的版本时，复制为不可变快照后上传；
- 连续保存可以合并，上传最终稳定版本；
- 上传期间再次保存不取消当前上传；后续稳定的新版本另行上传；
- 对内容未变化的重复保存不重复上传；
- 系统只声称“检测到稳定的新工作副本版本”，不声称捕获到了 WPS 的保存按钮事件。

### 2.10 客户系统适配边界

- 第一阶段不修改也不依赖客户内网业务系统。
- 使用通用 Demo 页面和文件服务验证闭环。
- 后续可以通过扩展识别普通 DOCX 链接、约定 URL、HTML data 属性或客户提供的专用入口。
- 如果客户系统没有可写回通道，插件不能凭空完成保存；届时需要客户增加上传/保存接口。
- 当前拿不到客户 HAR、页面源码或接口资料，不把这部分作为第一阶段阻塞项。

## 3. 通用 Demo 建议协议

建议最小接口：

```http
POST /documents/{id}/lock
POST /documents/{id}/lock/heartbeat
DELETE /documents/{id}/lock
GET /documents/{id}/content
PUT /documents/{id}/content
If-Match: "<base-etag>"
```

建议返回和记录：

- document ID；
- filename；
- base version / ETag；
- lock lease ID 和到期时间；
- 上传后的新版本、新 ETag 和内容哈希；
- 打开、保存、上传、冲突、释放锁的审计事件。

扩展与 Native Host 只传控制消息和任务 ID；DOCX 文件本体走本地代理与 Demo 服务之间的 HTTP(S)，不通过 Native Messaging Base64 搬运。

## 4. 两阶段验证环境

### V1：MJ 本机 macOS 可行性验证

已从本机应用元数据确认：

- 浏览器：`/Applications/Qaxbrowser.app`，奇安信浏览器 `1.2.46005.7`，Universal Binary（x86_64 + arm64）；
- 编辑器：`/Applications/wpsoffice.app`，WPS for macOS `12.1.26035`，arm64；
- 目标：只验证扩展触发、Native Messaging、下载、打开 WPS、保存检测和上传构成的最短闭环；
- V1 不承担麒麟 ARM64、客户奇安信浏览器版本或客户业务系统兼容性；
- 编辑锁、ETag 冲突控制、管理员站点配置、复杂鉴权、正式安装包和完整异常交互均不阻塞 V1。

### 后续阶段：客户目标环境兼容性验证

已从客户截图确认：

- OS：银河麒麟桌面操作系统 V10（SP1）2403；
- kernel：5.10.97-19-pangux；
- desktop：UKUI；
- CPU：HUAWEI Kirin 9000C，目标按 ARM64/AArch64 验证；
- browser：奇安信可信浏览器基础版 V1.0.46334.2；
- WPS：WPS 文字 12.8.2.1119（2025），已授权。

阶段二需要验证：

- 奇安信浏览器是否兼容标准 Chrome Native Messaging；
- 其 Native Messaging Host manifest 搜索目录；
- 企业扩展策略和自托管 CRX 安装/更新方式；
- Manifest V3 支持情况；
- ARM64 本地代理构建和动态依赖；
- WPS Linux 的实际启动命令、进程复用、文件锁和保存行为；
- DEB 一键安装和卸载。

## 5. 旧 CRX 静态分析结果

原文件：`/Users/lmj/Downloads/ntkoplugins.crx`

- 文件类型：CRX2；
- SHA-256：`5a44bd8522880a3fa430b6bbbe128fb5cd5160ae83a488735cb4108bfa1f64c5`；
- 扩展名称：软航跨浏览器插件；
- 扩展版本：2.0；
- Manifest：Manifest V2；
- 声明 `plugins`，加载 `npffax.dll`；
- 更新地址：`http://www.ntko.com/UpdateCrossBrowserPlugin.xml`；
- 包内只有 `manifest.json` 与 `npffax.dll`。

DLL：

- 格式：PE32 DLL；
- 平台：Microsoft Windows；
- CPU：Intel 80386 / 32-bit x86；
- SHA-256：`37a212e56a264a0c6d4aa7c81dc7f6ce5a75ea85971a6bb68b572ac74ae22f06`。

结论：

- 这是旧式 Windows NPAPI 插件，不是现代 JavaScript Chrome Extension；
- 它无法运行在麒麟 Linux ARM64；
- 现代 Chromium/奇安信浏览器不应预期继续支持其 `plugins`/NPAPI 模式；
- 没有源码，不能移植该 DLL；
- 新项目只能复刻用户能力和业务流程，不能复用旧二进制架构；
- 包中没有可复用的业务上传逻辑，旧系统的保存接口很可能位于业务页面、配套 NTKO 组件或后端。

安全提示：旧扩展更新地址使用 HTTP，不应沿用。

静态提取目录：`ntkoplugins-analysis/`。

## 6. 调研结论摘要

- 现代 Chromium 淘汰的是 ActiveX、NPAPI、PPAPI 和网页直接加载高权限本机二进制的旧模式，并未淘汰浏览器页面内在线 Office。
- 用户最终选择本机 WPS 路线，原因是客户已预装 WPS，且担心 ONLYOFFICE 等在线编辑器的格式保真问题。
- 单个 CRX 不能启动本地 WPS、任意访问编辑后的文件、注册 Native Host 或可靠回传。
- 生产主入口建议使用 Manifest V3 Native Messaging；自定义 URL scheme 只作可能的兜底；不优先使用 localhost WebSocket。
- 交付可做成“一键安装”，但一键对象应是 macOS 安装包和麒麟 ARM64 DEB，而不是只发 CRX。
- 扩展必须固定签名密钥和扩展 ID；Native Host 的 `allowed_origins` 精确绑定该 ID。
- 麒麟/奇安信的策略目录和 Native Messaging 路径不能根据 Chrome 上游路径直接承诺，必须真机验证。

## 7. `/grill-with-docs` 下一轮建议继续追问

每次只问一个决策，并给推荐答案。建议顺序：

1. Demo 文档链接的具体契约：普通 `.docx` URL、专用 scheme，还是 `data-*` 标记？
2. 扩展是只在配置的内网站点工作，还是拦截所有 DOCX 链接？
3. macOS 奇安信浏览器的准确版本、Chromium 内核、扩展管理入口和 Native Messaging 兼容性如何采集？
4. macOS 本地代理用什么语言实现？建议优先 Go，以便编译 macOS arm64/x64 和 Linux arm64 单文件程序；但需结合团队技术栈决定。
5. Demo 服务与页面用什么技术栈？应以最小实现为原则。
6. 保存检测的稳定窗口、上传防抖、连续多次保存和上传中的再次保存如何排队？
7. 用户关闭 WPS 前最后一次修改未保存时，页面和代理如何提示？
8. WPS 已打开同一工作副本时再次点击链接如何处理？
9. 本地工作副本保存位置、保留期限、权限和清理策略是什么？
10. Demo 阶段的认证是否仅用一次性任务 token，还是需要模拟登录态？
11. 扩展、Native Host、本地代理之间的消息 schema 和协议版本如何定义？
12. 失败场景的页面交互：Host 未安装、WPS 未安装、下载失败、锁冲突、上传失败、版本冲突。
13. macOS 第一阶段交付形式：开发者模式加载解压扩展 + 手工安装 Native Host，还是直接做签名安装包？建议 PoC 先用解压扩展和安装脚本。
14. 第一阶段的可验收成功标准和测试清单。

## 8. 当前尚未开始的工作

- 尚未创建扩展代码；
- 尚未创建 Native Messaging Host 或编辑代理；
- 尚未创建 Demo 页面和文件服务；
- 尚未修改客户系统；
- 尚未在 MJ 的奇安信浏览器或 WPS for macOS 上做运行验证；
- 尚未承诺麒麟/ARM64/奇安信兼容。

本轮处于需求澄清与可行性调研阶段，已按用户要求暂停 grilling，等待 `/grill-with-docs` 继续。
