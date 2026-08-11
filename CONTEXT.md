# Local WPS Editing

This context describes a browser-initiated editing flow in which a DOCX is edited in locally installed WPS and the persisted result is returned to a server.

## Language

**Document**:
A server-managed Word resource identified by a stable Document ID. A product route may constrain its accepted formats, such as DOCX only or DOC and DOCX.
_Avoid_: File, attachment

**Format-Compatible Document Version**:
A submitted Document version whose serialization is valid for the logical format
declared by the original Document path. For example, WPS may save a `.docx` or
`.xlsx` link as a legacy CFB Word or Excel container; those same-family
serializations remain compatible, while a different office family or malformed
serialization is not an acceptable overwrite.
_Avoid_: Successful upload, filename check

**Overwrite Receipt**:
The OA's structured acknowledgement that it atomically replaced the exact original Document path with a Format-Compatible Document Version. It is issued only after the replacement is committed.
_Avoid_: HTTP 2xx, upload response

**Overwrite Target**:
The exact original Document path preserved by an Editor Handoff and authorized for replacement by the OA. Upload metadata never selects or changes it.
_Avoid_: Filename, upload path

**Recoverable Overwrite Failure**:
A rejected overwrite attempt after which the packaged editor and its current Document remain available for an explicit retry. It does not complete the editing flow or change the Overwrite Target.
_Avoid_: Completion, automatic retry

**Discarded Edit**:
The editor-local changes a user deliberately leaves behind by returning to the OA after an overwrite failure. They never become a new version of the server-managed Document.
_Avoid_: Saved changes, successful return

**Single-Editor Assumption**:
The V1 operating assumption that user practice leaves only one editor acting on a Document at a time. It is not a concurrency guarantee enforced by the extension or OA.
_Avoid_: Edit lock, exclusive ownership

**Document Link**:
A page link for viewing or downloading a Document; it does not express an intent to edit.
_Avoid_: Edit link

**Editor Handoff**:
The one-time, extension-owned context that carries an intercepted Document Link into an OA-Origin Blob editor assembled from packaged assets. The visible Blob URL exposes only an opaque UUID; source and return URLs are embedded in the in-memory editor document and are not placed in its URL.
_Avoid_: Editing Task, query parameters

**WPS Document Gateway**:
A read-only OA service represented in extension configuration by a permanent URL template. The template maps one original Document path to a WPS-readable address within the customer's trusted network without per-user OA authentication.
_Avoid_: Document Link, temporary capability URL, product middleware

**Gateway Delivery Receipt**:
The WPS Document Gateway's short-lived evidence that it completely delivered one identified Document version for one Editor Handoff. It does not authorize an overwrite or retain a Document snapshot.
_Avoid_: Gateway response, download log, Overwrite Receipt

**Document Identity Gate**:
The fail-closed boundary that permits editing and overwrite only after the OA-authoritative original and the Gateway-delivered Document are proven identical for the same Editor Handoff. It is not an edit lock or a concurrent-version check.
_Avoid_: Open success, format check, edit lock

**Edit Entry**:
An eligible Document Link activation that the extension intercepts and routes into the same-tab OA-Origin Blob editor.
_Avoid_: Download link, confirmation prompt

**Editing Task**:
The server-created tracked unit of work requested when a user activates an Edit Entry, covering retrieval, local editing, and submission of one Document. It normally remains active while its Work Copy is open for editing and completes only after the Work Copy is closed and its final Persisted Version has been submitted or classified as unchanged. It may instead end in failure when the editing or submission route cannot continue; any Snapshot created before that failure is retained for recovery.
_Avoid_: Job, request

**Abandonment**:
The user's explicit decision to stop recovering an entire incomplete Editing Task and its unaccepted Snapshots. It never skips one Snapshot within a continuing task and is not successful completion.
_Avoid_: Cancel submission, skip version, complete task

**Work Copy**:
The local DOCX associated with an Editing Task and opened in WPS for editing.
_Avoid_: Download, temporary file

**Persisted Version**:
A newly observed stable content state of the Work Copy after WPS writes to disk. Repeated observation of unchanged content is the same Persisted Version, while returning to earlier content after an intervening change is a new one; unsaved changes held only in WPS memory are not a Persisted Version.
_Avoid_: Save event, saved click

**Snapshot**:
An immutable local copy of one Persisted Version used as the exact upload payload. Snapshots retain their observation order and are not superseded by later Persisted Versions.
_Avoid_: Backup, Work Copy

**Submission**:
An attempt to return a Snapshot to the server. A Submission is successful only when the server accepts the upload.
_Avoid_: Save, sync

**Acceptance Receipt**:
The server's structured, verifiable acknowledgement that it accepted one exact Snapshot as a new Document version.
_Avoid_: Success response, HTTP 2xx

**Completion Receipt**:
The server's structured acknowledgement that an Editing Task ended after all Snapshots were accepted or after WPS closed without producing a Persisted Version.
_Avoid_: Final save, close event

**Submission Profile**:
A named, declarative mapping from a Snapshot and Editing Task metadata to an allowed server request shape. It does not grant arbitrary network access.
_Avoid_: Upload mode, custom request

**OA Adapter**:
A page-side translation from a particular OA system's edit workflow into the standard Editing Task contract and Submission Profiles.
_Avoid_: Core protocol, customer plugin

**Editing Capability**:
A short-lived, least-privilege authorization issued for one Editing Task's Document retrieval or Snapshot Submission. It is not the user's OA session or a reusable general API credential.
_Avoid_: Cookie, password, access token

**Trusted OA Origin**:
An HTTP or HTTPS Origin that a user has explicitly allowed to start Editing Tasks through the browser extension. The Origin is derived from the active page rather than accepted from page-supplied data.
_Avoid_: Allowed website, host permission

**User Setup**:
The user-initiated preparation of Local WPS Editing for one desktop account after the system package is installed and before its first Editing Task. It is also the user-facing place for readiness checks and repair.
_Avoid_: Package installation, login startup, root setup
