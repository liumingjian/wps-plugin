# Local WPS Editing customer installation

The customer delivery contains exactly two files:

- `local-wps-editing-1.0.0.crx`, signed with fixed extension ID `mjjoapeohdfkepmocpahbimmmenlfdcb`.
- `local-wps-editing_1.0.0-1_arm64.deb`, for the designated Kylin V10 ARM64 desktop.

The raw ARM64 Host is a supplier-support artifact, not a third customer deliverable.

## Install

1. Install the DEB with Kylin Software Center.
2. Open **Local WPS Editing Setup** / **本地 WPS 编辑设置** from the application menu and choose **Configure**.
3. Start Qaxbrowser once if Setup asks for its profile, then configure again.
4. Install the supplied CRX manually in Qaxbrowser and restart the browser.
5. Return to Setup and choose **Recheck**.

Normal editing starts from the OA page. No service or diagnostic command is required, and no process remains resident when Qaxbrowser has no Editing Task to recover.

## OA page interface

The extension exposes `window.WpsEdit` on ordinary HTTP and HTTPS pages. The user approves each OA Origin in the extension popup before the Origin may create an Editing Task.

```js
const readiness = await WpsEdit.getReadiness();
const task = await WpsEdit.open({
  documentId: 'document-123',
  editingTasksUrl: '/editing-tasks',
  contractVersion: 1
});

const unsubscribe = task.subscribe(event => renderEditingStatus(event));
const completion = await task.completion;
unsubscribe();
```

`open()` may instead receive `taskId` to reauthorize and resume an existing task. The OA server must return the normalized Editing Task descriptor and verified Acceptance and Completion Receipts defined by the product contract. Customer-specific response parsing belongs in an OA Adapter or server proxy.

## Recovery and diagnostics

The extension popup shows the single active Editing Task and its recovery action. An unresolved Snapshot is retained until the server accepts it or the user explicitly abandons the entire task. User Setup can export a content-free diagnostic ZIP even when the extension is unavailable.

Desktop notifications never contain the Document name. **Document version submitted** means a matching Acceptance Receipt was persisted; it does not mean only that WPS wrote the Work Copy.

## Upgrade and removal

Install a newer DEB and signed CRX manually. The stable Host path and CRX identity preserve registration, while user state is forward-only and retained.

Removing or purging the DEB deletes shared package files only. It does not scan home directories or delete Work Copies, Snapshots, task state, or logs. **Deactivate account** in User Setup removes the current user's registration and configuration but retains recovery state. CRX removal is manual in Qaxbrowser.

## Supported environment

The formal V1 claim is Kylin release `2503`, ARM64, Qaxbrowser `1.0.46371.2`, WPS `12.1.2.26885.AK.preread.sw`, and DOCX documents. Other Kylin V10 ARM64 versions may continue with an unverified warning. Other operating systems, simultaneous Editing Tasks, formats other than DOCX, automatic update infrastructure, and customer-specific legacy OA behavior are outside this delivery.
