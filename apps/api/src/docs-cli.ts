import { writeFileSync } from 'fs';
import { join } from 'path';
import { COMMERCIAL_TRANSITIONS, DELIVERY_TRANSITIONS, PAYMENT_TRANSITIONS, Transition } from '@aquisito/contracts';

/** Genera docs/estados.md desde las tablas que el servidor aplica (fuente única). */
const table = (title: string, rows: Transition<string>[]) =>
  [`## ${title}`, '', '| De | A | Actor autorizado | Precondiciones | Inventario | Efecto económico | Notifica |', '|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.from} | ${r.to} | ${r.actors.join(', ')} | ${r.pre} | ${r.inventory} | ${r.economic} | ${r.notify} |`), ''].join('\n');
const md = [
  '# Estados y transiciones del pedido',
  '',
  '> Generado por `pnpm --filter @aquisito/api docs` desde `packages/contracts/src/state-machines.ts`. El servidor rechaza (409 `INVALID_TRANSITION`) cualquier par o actor no listado, aunque la interfaz sea manipulada. Cada transición incrementa `orders.version`, se registra en `order_status_history` y emite un evento durable (outbox) en la misma transacción.',
  '',
  'Los tres ciclos son independientes: entregado ≠ pagado; cancelado ≠ reembolsado.',
  '',
  table('Ciclo comercial', COMMERCIAL_TRANSITIONS),
  table('Ciclo de reparto', DELIVERY_TRANSITIONS),
  table('Ciclo de pago', PAYMENT_TRANSITIONS),
].join('\n');
writeFileSync(join(__dirname, '..', '..', '..', 'docs', 'estados.md'), md + '\n');
console.log('docs/estados.md generado');
