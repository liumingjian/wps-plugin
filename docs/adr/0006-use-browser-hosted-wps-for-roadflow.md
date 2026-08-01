# Use browser-hosted WPS for the fixed RoadFlow environment

ADR 0001 rejected NPAPI for modern Chromium and general target platforms, while ADR 0005 established the historical Native Messaging and DEB delivery. The designated Kylin V10, Qaxbrowser, and WPS environment has since demonstrated the required NPAPI automation, so RoadFlow will use a browser-hosted WPS surface in a CRX-only route with a separate extension identity; ADR 0001 and ADR 0005 remain unchanged for the historical route.
