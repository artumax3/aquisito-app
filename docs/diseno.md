# Identidad visual y accesibilidad

Identidad propia (no se usan logotipos, ilustraciones, textos ni interfaces de otras marcas).

- **Paleta**: verde selva `#0B3D2E` (fondo de cabecera), `#11613F` (acción primaria), `#E3F2EA` (superficies suaves); acentos cálidos mango `#F59E0B` (solo como acento/foco, nunca para texto sobre blanco) y achiote `#C2410C` (acciones de riesgo); fondo `#FAFAF7`.
- **Contraste** (WCAG 2.1, calculado con la fórmula de luminancia relativa): blanco sobre `#11613F` 7.49:1; blanco sobre `#0B3D2E` 12.2:1; `#0B3D2E` sobre `#E3F2EA` 10.55:1; `#4B5450` sobre `#FAFAF7` 7.48:1; blanco sobre `#C2410C` 5.18:1; `#8A4B06` sobre `#FFF4DC` 6.22:1; `#B91C1C` sobre `#FDECEC` 5.66:1; gris secundario `#646D69` 5.34:1 sobre blanco y 5.11:1 sobre `#FAFAF7` (se reemplazó `#7C8681`, que daba 3.76:1 y no cumplía AA). Todas ≥ 4.5:1 (AA texto normal). Pendiente: auditoría con lector de pantalla y usuarios locales.
- **Tipografía** del sistema (legible en Android de gama media, sin descarga de fuentes).
- Foco visible (contorno mango de 3 px), objetivos táctiles ≥ 42–48 px, roles ARIA en navegación, diálogos y alertas, `aria-live` en totales y resultados.
- Estados explícitos: carga (esqueletos), vacío, error con reintento, sin conexión (banner), comercio cerrado, agotado, fuera de cobertura, pago pendiente / en conciliación, simulador de desarrollo (banda rayada).
- Sin patrones engañosos: sin propina preseleccionada, sin contadores falsos, descuentos con precio de referencia comprobable, cancelación visible en el detalle del pedido.
- Imágenes: los datos demo no traen fotos; se muestran mosaicos de color marcados "Imagen demostrativa".
