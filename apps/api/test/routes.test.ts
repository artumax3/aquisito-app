import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endpoints } from '@aquisito/contracts';
import { createApp } from '../src/app';

describe('registro de endpoints ↔ rutas Nest', () => {
  let app: any;
  beforeAll(async () => {
    app = await createApp();
  });
  afterAll(async () => app.close());
  it('cada entrada del registro existe como ruta y viceversa', () => {
    const express = app.getHttpAdapter().getInstance();
    const stack = (express.router ?? express._router).stack;
    const routes = new Set<string>();
    for (const l of stack) {
      if (!l.route) continue;
      for (const m of Object.keys(l.route.methods)) routes.add(`${m.toUpperCase()} ${l.route.path}`);
    }
    const declared = new Set(Object.values(endpoints).map((e) => `${e.method} ${e.path}`));
    const missing = [...declared].filter((d) => !routes.has(d));
    const undeclared = [...routes].filter((r) => !declared.has(r));
    expect({ missing, undeclared }).toEqual({ missing: [], undeclared: [] });
  });
});
