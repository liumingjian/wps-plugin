# macOS 手动端到端验收手册

本文用于在指定 macOS arm64 机器上手动验证连续文档编辑流程：

```text
查看服务器当前文档 → 点击唯一编辑按钮 → WPS 编辑并保存
→ 页面显示新版本 → 再次点击 → WPS 打开上次保存的版本
```

## 1. 通过标准

只有以下条件全部满足，才能判定通过：

- Qaxbrowser 加载的扩展 ID 是 `mbkblmlopgjhdlandbjhpemifinfllim`。
- 页面显示当前文档版本、文本预览和唯一的 **Edit locally in WPS** 按钮。
- 第一次点击后，WPS 打开一个任务专属的 `doc-001.docx` Work Copy。
- 在 WPS 中保存第一处唯一编辑后，页面自动从 Version 1 更新到 Version 2，预览中出现该编辑。
- 第二次点击后，WPS 打开另一个任务专属路径，文档初始内容已经包含第一次编辑。
- 保存第二处唯一编辑后，页面自动更新到 Version 3，预览中同时出现两处编辑。

只有自动化测试通过、WPS 启动或页面显示正在编辑，都不能单独视为通过。

## 2. 记录环境

进入仓库根目录：

```bash
cd /Users/lmj/projects/ai-project/devs/wps-plugin
```

记录系统和应用版本：

```bash
uname -m
```

```bash
defaults read /Applications/Qaxbrowser.app/Contents/Info CFBundleShortVersionString
```

```bash
defaults read /Applications/wpsoffice.app/Contents/Info CFBundleShortVersionString
```

```bash
go version
```

```bash
git rev-parse HEAD
```

要求架构为 `arm64`，Go 为 `go1.23.2`。

检查 Go 工具链是否一致：

```bash
printf 'GOROOT=%s\n' "${GOROOT-unset}"; go env GOROOT; "$(go env GOTOOLDIR)/compile" -V=full
```

`go version` 和 `compile version` 必须都是 Go 1.23.2。不要把 `GOROOT` 手工指向另一套 Go 安装。

## 3. 确认 Qaxbrowser 产品目录

1. 打开 Qaxbrowser 的 `chrome://version`。
2. 找到 **Profile Path**。
3. 确认它位于 `~/Library/Application Support/Qaxbrowser` 下。
4. 如果实际目录不同，后续 `QAX_SUPPORT_DIR` 使用 Profile Path 的上一级产品目录。

## 4. 运行测试并安装

运行完整测试：

```bash
go test ./...
```

安装扩展副本和 Native Messaging Host：

```bash
QAX_SUPPORT_DIR="$HOME/Library/Application Support/Qaxbrowser" ./scripts/setup-macos-arm64.sh
```

setup 会校验 Go 1.23.2，并使用独立临时构建缓存。如果当前 PATH 中的 Go 不正确，可明确指定：

```bash
GO_BINARY=/opt/homebrew/opt/go/bin/go QAX_SUPPORT_DIR="$HOME/Library/Application Support/Qaxbrowser" ./scripts/setup-macos-arm64.sh
```

确认 Host 是 arm64：

```bash
file "$HOME/Library/Application Support/WPSEditDemo/native-host/native-host"
```

预期包含：

```text
Mach-O 64-bit executable arm64
```

## 5. 加载扩展

1. 打开 Qaxbrowser 的 `chrome://extensions`。
2. 开启开发者模式。
3. 点击 **Load unpacked / 加载已解压的扩展程序**。
4. 选择 `~/Library/Application Support/WPSEditDemo/extension`。
5. 确认名称为 **Local WPS Editing Demo**。
6. 确认 ID 完全等于：

```text
mbkblmlopgjhdlandbjhpemifinfllim
```

7. 完全退出并重启 Qaxbrowser。

ID 不一致时停止验收，不要修改 Host manifest 迁就错误 ID。

## 6. 启动 Demo

在仓库根目录运行：

```bash
go run ./cmd/demo
```

保持终端运行，在 Qaxbrowser 打开：

```text
http://127.0.0.1:4317/
```

初始页面应显示：

- `Demo Document`；
- `Version 1`；
- 文本预览 `WPS local editing fixture`；
- 唯一的 **Edit locally in WPS** 按钮；
- `Ready to edit the current document.`。

页面不应再出现独立的 Document Link 或 Latest submitted result。

## 7. 未保存关闭验证

1. 点击 **Edit locally in WPS**。
2. 等待 WPS 打开本次任务专属 `doc-001.docx`。
3. 不修改内容，直接关闭该 WPS 文档窗口。
4. 页面应在数秒内恢复编辑按钮，并显示“未保存，当前 Version 1 不变”。
5. 页面预览内容和版本都不能变化。
6. 再次点击编辑，确认新 Work Copy 的内容仍是关闭前的服务器版本。

每次点击都会生成唯一 Editing Task ID，因此不能假定固定任务目录。可用下面的命令确认 WPS 持有的准确路径：

```bash
lsof -p "$(pgrep -x wpsoffice | head -n 1)" | grep '/wps-edit-agent/.*/doc-001.docx'
```

未保存关闭不是失败，也不应产生 Submission 或新版本。

## 8. 第一轮保存编辑

准备第一处唯一文本，例如：

```text
WPS-MANUAL-FIRST-20260726-001
```

1. 点击 **Edit locally in WPS** 一次。
2. 按钮应暂时禁用，页面提示正在打开当前版本。
3. 等待 WPS 自动打开 `doc-001.docx`。
4. 在文档末尾输入第一处唯一文本。
5. 按 `Command-S` 保存。
6. 等待至少 5 秒，不要立即关闭 WPS。
7. 回到 Qaxbrowser。

预期页面自动变为：

- `Version 2`；
- 文本预览包含第一处唯一文本；
- 状态提示 Version 2 已是当前版本；
- 编辑按钮重新可用。

如果页面没有更新，可直接查看服务器当前读模型：

```bash
curl -s http://127.0.0.1:4317/documents/doc-001 | python3 -m json.tool
```

其中 `version` 应为 `2`，`previewText` 应包含第一处文本。

## 8. 确认第一轮 Work Copy

每次点击都会生成唯一 Editing Task ID，因此不能再假定固定的 `task-doc-001` 路径。

列出最近的 Work Copy：

```bash
find "${TMPDIR%/}/wps-edit-agent" -mindepth 2 -maxdepth 2 -name 'doc-001.docx' -print
```

确认 WPS 正持有其中一个任务专属路径：

```bash
lsof -p "$(pgrep -x wpsoffice | head -n 1)" | grep '/wps-edit-agent/.*/doc-001.docx'
```

记录该路径，记为第一轮 Work Copy。

## 9. 第二轮编辑

准备第二处不同文本，例如：

```text
WPS-MANUAL-SECOND-20260726-001
```

1. 再次点击同一个 **Edit locally in WPS** 按钮。
2. 等待 WPS 打开新的 `doc-001.docx`。
3. 首先确认文档中已经存在第一处唯一文本。
4. 确认本轮 Work Copy 绝对路径与第一轮不同。
5. 在文档末尾输入第二处唯一文本。
6. 按 `Command-S` 保存并等待至少 5 秒。
7. 回到 Qaxbrowser。

预期页面自动变为：

- `Version 3`；
- 文本预览同时包含第一处和第二处文本；
- 状态提示 Version 3 已是当前版本；
- 编辑按钮重新可用。

这一步是本次验收的核心：它证明第二次编辑确实以上一次保存结果为基线。

## 10. 可选的文件证据

服务器当前 DOCX 可直接下载：

```bash
curl -sS http://127.0.0.1:4317/documents/doc-001/content -o "$HOME/Downloads/wps-current-version-3.docx"
```

计算下载结果哈希：

```bash
shasum -a 256 "$HOME/Downloads/wps-current-version-3.docx"
```

打开下载结果，肉眼确认两处文本都存在。也可以解包检查：

```bash
FIRST='WPS-MANUAL-FIRST-20260726-001' SECOND='WPS-MANUAL-SECOND-20260726-001' DOCX="$HOME/Downloads/wps-current-version-3.docx" python3 - <<'PY'
import os
from zipfile import ZipFile

with ZipFile(os.environ["DOCX"]) as archive:
    xml = archive.read("word/document.xml").decode("utf-8")
for name in ("FIRST", "SECOND"):
    marker = os.environ[name]
    print(f"{name.lower()}_present={str(marker in xml).lower()}")
    if marker not in xml:
        raise SystemExit(f"{name} marker is missing")
PY
```

预期两个结果都为 `true`。

## 11. 验收记录模板

```text
Date:
macOS version:
Qaxbrowser version:
WPS version:
Agent commit:
Extension ID:
Initial page version: 1
First unique edit:
First Work Copy path:
Page version after first save: 2
First edit visible in preview: yes/no
Second unique edit:
Second Work Copy path:
Second Work Copy differs from first: yes/no
First edit present before second save: yes/no
Page version after second save: 3
Both edits visible in preview: yes/no
Downloaded current DOCX path:
Downloaded DOCX SHA-256:
Final verdict: PASS/FAIL
Notes:
```

## 12. 常见失败

### Local agent unavailable 或 message port closed

检查固定扩展 ID、`nativeMessaging` 权限、Qaxbrowser 的 Native Messaging manifest，并在修改后完全重启 Qaxbrowser。

### WPS 没有打开

确认 `/Applications/wpsoffice.app` 存在，并保存页面错误。不要通过 Finder 打开另一份同名文件代替自动链路。

### 保存后页面没有升级版本

- 确认 WPS 保存的是任务专属 Work Copy；
- 再按一次 `Command-S` 并等待 5 秒；
- 查看 `/documents/doc-001` 的 `version` 和 `previewText`；
- 保存 Demo 终端输出和 Work Copy，不要先重启服务，因为内存中的当前版本会在重启后恢复 Version 1。

### 第二轮没有第一轮内容

直接判定失败。记录两个 Work Copy 路径、页面版本、服务器 `/documents/doc-001` 响应和 Demo 输出。

## 13. 清理

1. 在 Demo 终端按 `Control-C`。
2. 在 `chrome://extensions` 中移除或禁用扩展。
3. 执行：

```bash
QAX_SUPPORT_DIR="$HOME/Library/Application Support/Qaxbrowser" ./scripts/uninstall-macos.sh
```

4. 确认 manifest 和安装目录已删除：

```bash
test ! -e "$HOME/Library/Application Support/Qaxbrowser/NativeMessagingHosts/com.liumingjian.wps_edit_agent.json" && echo manifest-removed
```

```bash
test ! -e "$HOME/Library/Application Support/WPSEditDemo" && echo install-root-removed
```

卸载不会删除用户 Documents 或 `$TMPDIR/wps-edit-agent` 下的验收 Work Copy。
