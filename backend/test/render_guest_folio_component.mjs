import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const frontendDir = path.resolve(import.meta.dirname, '..', '..', 'frontend');
const req = createRequire(path.join(frontendDir, 'package.json'));
const React = req('react');
const ReactDOMServer = req('react-dom/server');

const viteUrl = pathToFileURL(path.join(frontendDir, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href;
const { createServer } = await import(viteUrl);

const server = await createServer({
  root: frontendDir,
  server: { middlewareMode: true },
});

const mod = await server.ssrLoadModule('/src/features/documents/GuestFolioPrint.tsx');
const GuestFolioPrint = mod.default;

const cssPath = path.join(frontendDir, 'src', 'features', 'documents', 'guestDocumentPrint.css');
const cssText = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';

export async function renderComponentToHtml(data, viewMode = 'EFFECTIVE') {
  const element = React.createElement(GuestFolioPrint, {
    data,
    viewMode,
  });
  const markup = ReactDOMServer.renderToStaticMarkup(element);
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${data.folio_number || 'Tagihan Tamu / Guest Folio'}</title>
  <style>
${cssText}
  </style>
</head>
<body style="margin:0;padding:0;background:#fff;">
  <div class="document-center">
    <div class="document-center-preview">
      ${markup}
    </div>
  </div>
</body>
</html>`;
}

// CLI execution if called directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const [,, jsonPath, outHtmlPath, viewModeArg] = process.argv;
  if (!jsonPath || !outHtmlPath) {
    console.error('Usage: node render_guest_folio_component.mjs <inputJson> <outputHtml> [viewMode]');
    process.exit(1);
  }
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const data = JSON.parse(raw);
  const html = await renderComponentToHtml(data, viewModeArg || 'EFFECTIVE');
  fs.writeFileSync(outHtmlPath, html, 'utf8');
  await server.close();
  process.exit(0);
}
