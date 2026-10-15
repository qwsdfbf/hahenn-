// Concatenates src/shell.html and src/js/*.js into a single self-contained index.html.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('.', import.meta.url).pathname;
const shell = readFileSync(join(root, 'src/shell.html'), 'utf8');
const dir = join(root, 'src/js');
const parts = readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
const body = parts.map((f) => `// ---- ${f}\n` + readFileSync(join(dir, f), 'utf8')).join('\n');
const script = `<script>\n'use strict';\n(async () => {\n${body}\n})();\n</script>`;
if (!shell.includes('<!--SCRIPT-->')) throw new Error('shell.html is missing the <!--SCRIPT--> marker');
const out = process.argv[2] || join(root, 'index.html');
writeFileSync(out, shell.replace('<!--SCRIPT-->', () => script));
console.log(`${out} written from ${parts.length} script parts`);
