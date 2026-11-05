import { expect, test, Page, BrowserContext } from '@playwright/test';

/**
 * Criterio 01 en navegador: un cliente de Aguaytía compra a una sucursal local y el pedido recorre
 * los cuatro módulos (cliente, comercio, repartidor, administración) con datos reales del API.
 */
const PASS = 'E2E-Demo-Pass-1';

async function login(page: Page, email: string) {
  await page.goto('/cuenta');
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Contraseña').fill(PASS);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: /Hola,/ })).toBeVisible();
}

async function newUser(ctx: BrowserContext, email: string) {
  const page = await ctx.newPage();
  await login(page, email);
  return page;
}

test('pedido completo en Aguaytía a través de los cuatro módulos', async ({ browser }) => {
  // ---------- Cliente ----------
  const cctx = await browser.newContext();
  const customer = await newUser(cctx, 'cliente.aguaytia@demo.aquisito.local');
  await customer.goto('/');
  await customer.getByRole('button', { name: 'Aguaytía' }).click();
  await customer.getByRole('link', { name: /Sazón Amazónico/ }).click();
  await expect(customer.getByRole('heading', { name: /Sazón Amazónico/ })).toBeVisible();
  await customer.getByRole('button', { name: 'Agregar Inchicapi' }).click();
  await customer.getByRole('button', { name: /^Agregar · S\/ 16\.00/ }).click();
  await expect(customer.getByText('Producto agregado al carrito')).toBeVisible();
  await customer.goto('/carrito');
  await expect(customer.getByRole('button', { name: /Confirmar pedido/ })).toBeVisible();
  // Sin propina preseleccionada; el total lo calcula el servidor.
  await expect(customer.getByText('Total')).toBeVisible();
  await customer.getByRole('button', { name: /Confirmar pedido/ }).click();
  await customer.waitForURL(/\/pedidos\//);
  await expect(customer.getByRole('heading', { name: 'Pago pendiente' })).toBeVisible();
  await expect(customer.getByText(/SIMULADOR DE PAGOS — SOLO DESARROLLO/)).toBeVisible();
  await customer.getByRole('button', { name: 'Simular pago aprobado' }).click();
  await expect(customer.locator('.badge', { hasText: 'Pagado' }).first()).toBeVisible();
  const orderUrl = customer.url();
  const orderNumber = (await customer.getByRole('heading', { name: /Pedido #/ }).innerText()).replace(/\D/g, '');

  // ---------- Comercio ----------
  const mctx = await browser.newContext();
  const merchant = await newUser(mctx, 'comercio1@demo.aquisito.local');
  await merchant.goto('/comercio');
  const card = merchant.locator('.card', { hasText: `#${orderNumber}` });
  await card.getByRole('button', { name: 'Aceptar' }).click();
  await card.getByRole('button', { name: 'Iniciar preparación' }).click();
  await card.getByRole('button', { name: 'Marcar listo' }).click();
  const pickupCode = (await card.getByText(/Código de recojo:/).innerText()).replace(/\D/g, '');
  expect(pickupCode).toHaveLength(6);

  // ---------- Repartidor (vista web, geolocalización emulada con permiso) ----------
  const rctx = await browser.newContext({ geolocation: { latitude: -9.037, longitude: -75.508 }, permissions: ['geolocation'] });
  const courier = await newUser(rctx, 'repartidor.aguaytia1@demo.aquisito.local');
  await courier.goto('/repartidor');
  await courier.getByRole('button', { name: 'Conectarme' }).click();
  await expect(courier.getByText('🟢 Disponible')).toBeVisible();
  await expect(courier.getByText(/ubicación \d/)).toBeVisible();
  // El job de asignación crea la oferta (cada 1 s en E2E).
  await expect(async () => {
    await courier.reload();
    await expect(courier.getByRole('button', { name: 'Aceptar' })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await expect(courier.getByText(/Aguaytía Centro/)).toBeVisible(); // zona, no dirección exacta
  await courier.getByRole('button', { name: 'Aceptar' }).click();
  await courier.getByRole('button', { name: 'Voy al comercio' }).click();
  await courier.getByPlaceholder(/Código de recojo/).fill(pickupCode);
  await courier.getByRole('button', { name: 'Confirmar recojo' }).click();
  await courier.getByRole('button', { name: 'En camino al cliente' }).click();

  // El cliente ve el seguimiento y su código de entrega.
  await customer.goto(orderUrl);
  await expect(customer.getByRole('heading', { name: 'Seguimiento' })).toBeVisible();
  await expect(customer.getByText(/Última ubicación:/)).toBeVisible();
  await customer.getByRole('button', { name: 'Ver código de entrega' }).click();
  const deliveryCode = (await customer.locator('.alert.ok strong').innerText()).trim();

  await courier.getByRole('button', { name: 'Llegué al destino' }).click();
  await courier.getByPlaceholder(/Código de entrega/).fill(deliveryCode);
  await courier.getByRole('button', { name: 'Confirmar entrega' }).click();
  await expect(courier.getByText('Sin ofertas por ahora.')).toBeVisible();

  await customer.reload();
  await expect(customer.locator('.badge', { hasText: 'Completado' })).toBeVisible();
  await expect(customer.locator('.badge', { hasText: 'Entregado' })).toBeVisible();

  // ---------- Administración (requiere TOTP: sesión elevada vía API con el secreto demo) ----------
  const actx = await browser.newContext();
  const admin = await actx.newPage();
  await login(admin, 'admin@demo.aquisito.local');
  const { totp } = await import('./totp');
  const fs = await import('fs');
  const cred = fs.readFileSync('../api/storage-e2e/demo-credentials.txt', 'utf8').split('\n').find((l) => l.includes('admin@demo'))!;
  const secret = cred.match(/TOTP:(\S+)/)![1];
  await admin.getByPlaceholder('Código de 6 dígitos').fill(totp(secret));
  await admin.getByRole('button', { name: 'Verificar' }).click();
  await expect(admin.getByText('Sesión verificada con TOTP.')).toBeVisible();
  await admin.goto('/admin');
  await admin.getByRole('button', { name: 'Pedidos y despacho' }).click();
  await admin.getByLabel('Solo activos').uncheck();
  const row = admin.locator('tr', { hasText: orderNumber });
  await row.getByRole('button', { name: 'Detalle' }).click();
  await expect(admin.getByText('merchant · merchant_sale')).toBeVisible();
  await expect(admin.getByText('courier · courier_delivery_pay')).toBeVisible();
  await admin.getByRole('button', { name: 'Indicadores' }).click();
  await expect(admin.getByText('Valor bruto vendido (productos)').first()).toBeVisible();
});

test('contenido para adultos oculto a cuentas no verificadas', async ({ page }) => {
  await login(page, 'cliente.noverificado@demo.aquisito.local');
  await page.goto('/');
  await page.getByRole('button', { name: 'Aguaytía' }).click();
  await page.getByRole('link', { name: /Minimarket Puente/ }).click();
  await expect(page.getByText(/productos solo para adultos verificados/)).toBeVisible();
  await expect(page.getByText('Cerveza lata 355 ml')).toHaveCount(0);
  await expect(page.getByText(/Combo piqueo/)).toHaveCount(0);
  await expect(page.getByText(/Combo refrescante/)).toBeVisible();
});

test('comercio cerrado y dirección fuera de cobertura', async ({ page }) => {
  await login(page, 'cliente.aguaytia@demo.aquisito.local');
  await page.goto('/');
  await page.getByRole('button', { name: 'Aguaytía' }).click();
  await expect(page.locator('.card', { hasText: 'Panadería Amanecer' }).getByText('Cerrado', { exact: true })).toBeVisible();
  await page.getByLabel('Dirección de entrega').selectOption({ label: /Chacra/ as any }).catch(async () => {
    const opts = await page.getByLabel('Dirección de entrega').locator('option').allTextContents();
    await page.getByLabel('Dirección de entrega').selectOption({ label: opts.find((o) => o.includes('Chacra'))! });
  });
  await expect(page.getByText(/fuera de la zona de reparto/)).toBeVisible();
});
