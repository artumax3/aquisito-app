import { writeFileSync } from 'fs';
import { join } from 'path';
import { buildOpenApi } from './openapi';

const out = join(__dirname, '..', '..', '..', 'docs', 'openapi.json');
const doc = buildOpenApi();
writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
console.log(`OpenAPI escrito en ${out} (${Object.keys(doc.paths).length} rutas)`);
