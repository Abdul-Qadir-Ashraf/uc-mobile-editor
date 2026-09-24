# UC Mobile Editor

A private mobile-first web version of the UC report editor. All HTML and CSV processing happens inside the browser; report contents are never uploaded to the hosting service.

## Workflow

1. Select matching HTML and CSV files.
2. Choose the total conversion percentage and New Enrolment share.
3. Generate modified reports and password-protected station ZIPs.
4. Download the complete output package or individual files.

The individual ZIP password is `123`, matching the desktop editor.

## Implementation

- Static HTML, CSS, and JavaScript
- Client-side HTML and CSV processing
- Bundled zip.js 2.18.2 for ZipCrypto-compatible archives
- Strict Content Security Policy with network connections disabled after page load
