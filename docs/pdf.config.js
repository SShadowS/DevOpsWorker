export default {
  stylesheet: [],
  css: `
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 13px; color: #24292e; line-height: 1.5; }
    h1 { border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
    h2 { border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; margin-top: 1.5em; page-break-after: avoid; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; page-break-inside: auto; }
    tr { page-break-inside: avoid; break-inside: avoid; }
    thead { display: table-header-group; }
    th, td { border: 1px solid #dfe2e5; padding: 6px 12px; text-align: left; }
    th { background: #f6f8fa; font-weight: 600; }
    tr:nth-child(even) { background: #f6f8fa; }
    code { background: #f6f8fa; padding: 0.2em 0.4em; border-radius: 3px; font-size: 85%; }
    pre { background: #f6f8fa; padding: 16px; border-radius: 6px; overflow-x: auto; }
    img { max-width: 100%; max-height: 680px; width: auto; height: auto; display: block; margin: 1em auto; }
  `,
  pdf_options: {
    format: 'A4',
    margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
    printBackground: true,
  },
  md_file_encoding: 'utf-8',
};
