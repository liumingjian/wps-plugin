# Use a browser extension and local agent to edit with WPS

The product will use a Manifest V3 browser extension, Native Messaging, and a local agent to open a downloaded DOCX in the independently running WPS application and submit a persisted version to the server. A browser extension alone cannot reliably launch WPS, access the edited file, or register a Native Messaging Host; embedding WPS in the page and reusing the legacy Windows NPAPI binary were rejected because they do not fit modern Chromium or the target platforms.
