# Local WPS Editing

This context describes a browser-initiated editing flow in which a DOCX is edited in locally installed WPS and the persisted result is returned to a server.

## Language

**Document**:
A server-managed DOCX resource identified by a stable Document ID.
_Avoid_: File, attachment

**Document Link**:
A page link for viewing or downloading a Document; it does not express an intent to edit.
_Avoid_: Edit link

**Edit Entry**:
An explicit page control through which a user requests local editing of a Document in WPS.
_Avoid_: Document Link, download link

**Editing Task**:
The tracked unit of work created when a user activates an Edit Entry, covering retrieval, local editing, and submission of one Document.
_Avoid_: Job, request

**Work Copy**:
The local DOCX associated with an Editing Task and opened in WPS for editing.
_Avoid_: Download, temporary file

**Persisted Version**:
A stable content state observed from the Work Copy after WPS has written changes to disk. Unsaved changes held only in WPS memory are not a Persisted Version.
_Avoid_: Save event, saved click

**Snapshot**:
An immutable local copy of a Persisted Version used as the exact upload payload.
_Avoid_: Backup, Work Copy

**Submission**:
An attempt to return a Snapshot to the server. A Submission is successful only when the server accepts the upload.
_Avoid_: Save, sync
