# RoadFlow WPS 无 Gateway 本地验收

## 启停模拟程序

在仓库根目录运行：

```bash
bash ./scripts/run-roadflow-simulator.sh
```

模拟 OA 地址：

```text
http://127.0.0.1:4317
```

停止时在运行终端按 `Ctrl+C`。模拟器只有 OA 一个端口，不需要 Gateway。

## 安装和配置 CRX

安装最新的 `roadflow-wps-editor-<version>.crx`，确认扩展 ID：

```text
bojjhibgkhknccepabkojdjodhhgdjfd
```

扩展设置中可以填写指定 OA：

```text
Trusted OA Origin: http://127.0.0.1:4317
```

也可以保持 `Trusted OA Origin` 为空并保存，此时扩展会请求全部 HTTP/HTTPS
站点权限，并拦截浏览器中所有路径以 `.doc` 或 `.docx` 结尾的 Word 链接。
客户环境建议填写实际 OA Origin，避免扩大拦截范围。

不再配置 Gateway template。

## 手动验收

1. 打开 `http://127.0.0.1:4317` 并点击“模拟登录”。
2. 点击“打开验收文档 Acceptance.doc”。链接应被拦截，而不是下载。
3. 确认 WPS 打开正文，页面显示“正文可编辑”。
4. 输入一段测试文字，确认 WPS 以修订形式显示新增内容。
5. 点击“保存”，确认状态变为“已保存”。
6. 返回 OA，再次打开正文，确认修改和修订记录仍然存在。

模拟器直接从 OA 的 `/UploadFiles/2026/Acceptance.doc` 下载正文，并使用客户
现有形式的 `/RoadFlow/uploadfiles/OfficeSave` 保存。验收不涉及 Gateway、
Native Messaging、本地 agent 或 DEB。
