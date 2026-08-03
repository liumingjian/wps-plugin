# RoadFlow WPS 编辑器使用说明

## 1. 客户拿到什么

供应商交付给客户两个文件：

1. 签名后的 `roadflow-wps-editor-<version>.crx`；
2. 本配置说明。

客户端不需要安装 DEB、本地 Agent、Native Messaging Host 或后台服务。

客户环境本身需要已经具备：

- 指定版本的银河麒麟、Qaxbrowser 和 WPS，并启用 WPS NPAPI 插件；
- RoadFlow OA 的文档读取和 `OfficeSave` 保存接口；
- 客户部署的只读 WPS Document Gateway。

本次本地验收制品：

```text
文件：dist/release/roadflow-wps-editor-1.0.2.crx
SHA-256：59f855722f3768c1e603ae942e4a83af5565ce215a86ad8930d34f4104f26893
扩展 ID：bojjhibgkhknccepabkojdjodhhgdjfd
```

## 2. 本地模拟程序

本地模拟程序同时提供：

- 带模拟登录态和普通 DOC Document Link 的 OA 页面；
- 与生产合同一致的 `OfficeSave` 原子覆盖接口；
- 只读、按字节交付文档的 WPS Document Gateway；
- 仅在完整交付后生成、只允许已配置 OA Origin 读取的 Editor Receipt。

安装后的生产 CRX 可以直接连接这两个模拟 Origin，完成打开、编辑、保存、返回
OA 和重新打开的完整流程。

### 启动

在仓库根目录运行：

```sh
bash ./scripts/run-roadflow-simulator.sh
```

看到以下内容表示启动成功：

```text
RoadFlow customer simulator started
OA page: http://127.0.0.1:4317
Trusted OA Origin: http://127.0.0.1:4317
Gateway template: http://127.0.0.1:4318/wps/document?fileurl={sourcePath}
State directory: /tmp/roadflow-customer-simulator
```

保持这个终端运行。先按第 3 至第 5 节安装并配置 CRX，然后用 Qaxbrowser 打开：

```sh
qaxbrowser-safe-stable 'http://127.0.0.1:4317/'
```

操作步骤：

1. 点击“模拟登录”；
2. 点击“打开验收文档 Acceptance.doc”；
3. CRX 应在同一标签页进入 `blob:http://127.0.0.1:4317/...` WPS 编辑器；
4. 修改正文并点击“保存”；
5. 显示“已保存”后点击“返回 OA”；
6. 再次点击同一个文档链接，应在 WPS 中看到刚才保存的内容。

模拟器每次请求都会输出到启动终端。当前文档状态也可在已模拟登录后访问：

```text
http://127.0.0.1:4317/simulator/status
```

模拟文档保存在 `/tmp/roadflow-customer-simulator`。再次启动时会继续使用上次
保存的文档。需要一套全新状态时，使用新的明确目录启动：

```sh
ROADFLOW_SIMULATOR_STATE_DIR=/tmp/roadflow-customer-simulator-run2 \
  bash ./scripts/run-roadflow-simulator.sh
```

### 停止

回到运行模拟程序的终端，按 `Ctrl+C`。

停止后 OA 和 Gateway 两个端口会一起关闭，状态目录不会删除。

### 模拟范围说明

模拟器使用生产 `roadflowoa` 和 `roadflowgateway` 合同实现，可以驱动正式 CRX，
但它仍然不是客户真实 OA：不包含客户账号、组织权限、真实业务页面、生产网络和
生产 Gateway 部署。因此它适合交付前演示与集成验证，不能替代客户现场验收。

## 3. 生成 CRX

### 生成客户交付 CRX

生成固定 ID 的签名 CRX 需要：

- 供应商保存的 RoadFlow CRX 私钥；
- 支持 `--pack-extension` 的指定 Qaxbrowser 可执行文件。

运行：

```sh
VERSION=1.0.2 \
ROADFLOW_CRX_RELEASE_KEY=/secure/roadflow-crx-release.pem \
QAXBROWSER=/opt/qianxin.com/qaxbrowser/qaxbrowser \
bash ./scripts/package-roadflow-crx.sh
```

默认输出：

```text
dist/release/roadflow-wps-editor-1.0.2.crx
```

脚本会校验私钥指纹和生成后的固定扩展 ID。正确的扩展 ID 必须是：

```text
bojjhibgkhknccepabkojdjodhhgdjfd
```

可记录交付文件校验值：

```sh
sha256sum dist/release/roadflow-wps-editor-1.0.2.crx
```

没有供应商私钥时，不能生成相同固定 ID 的客户交付 CRX。

### 只生成开发目录

仅开发调试、不交付客户时，可以生成未打包目录：

```sh
OUTPUT=/tmp/roadflow-extension VERSION=1.0.2 \
  bash ./scripts/stage-roadflow-extension.sh
```

该目录可通过 Qaxbrowser 扩展管理页的“加载已解压的扩展程序”加载，但它不能
替代供应商签名的正式 CRX。

## 4. 安装插件

1. 在指定 Qaxbrowser 中打开 `chrome://extensions`。
2. 安装供应商提供的 `roadflow-wps-editor-<version>.crx`。
3. 打开插件详情，确认扩展 ID 为
   `bojjhibgkhknccepabkojdjodhhgdjfd`。
4. 若 ID 不一致，停止使用，不要修改 Gateway 白名单迁就错误 ID。

## 5. 配置插件

在 `chrome://extensions` 中打开 **RoadFlow WPS Editor** 的详情页，然后打开
**Extension options**。

只需填写两个配置项。

### Trusted OA Origin

填写 RoadFlow OA 的 Origin，只能包含协议、主机和可选端口，不能带路径、查询
参数、账号或密码。

示例：

```text
https://oa.example.internal
```

### WPS Document Gateway template

填写客户 Gateway 的文档读取 URL，必须且只能包含一个 `{sourcePath}`。

示例：

```text
https://wps-gateway.example.internal/wps/document?fileurl={sourcePath}
```

点击 **Save configuration**。Qaxbrowser 请求 OA 和 Gateway 两个 Origin 的访问
权限时选择允许。

## 6. 检查配置

点击浏览器工具栏中的 **RoadFlow WPS Editor** 图标。

- 显示 **Environment ready**：配置和 WPS 插件已就绪；
- 显示 **Configuration required**：两个配置项缺失或格式错误；
- 显示 **WPS or browser plugin unavailable**：Qaxbrowser 没有检测到 WPS
  NPAPI 插件，需要检查 WPS 安装和浏览器插件设置后重启浏览器。

配置成功后，用户正常登录 OA，点击同站点的 DOC 或 DOCX 文档链接即可进入
WPS 编辑器。编辑完成后点击“保存”，再点击“返回 OA”。

## 7. 给客户的最简清单

```text
[ ] 已收到 roadflow-wps-editor-<version>.crx
[ ] CRX 扩展 ID 是 bojjhibgkhknccepabkojdjodhhgdjfd
[ ] 已填写 Trusted OA Origin
[ ] 已填写含一个 {sourcePath} 的 Gateway template
[ ] 插件状态显示 Environment ready
[ ] 登录 OA 后点击 DOC/DOCX 链接可以进入 WPS 编辑器
```
