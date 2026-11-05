# Manuales breves

## Administración (`/admin`)
1. **Ingreso seguro**: inicia sesión y verifica el código TOTP en *Cuenta* (obligatorio para admin y finanzas; la sesión dura 12 h).
2. **Pedidos y despacho**: filtra por ciudad, estado, pago, repartidor o incidencias. Si un pedido no consigue repartidor, asígnalo manualmente (queda en auditoría con motivo). Reasignar solo antes del recojo. Cancelar exige motivo; libera stock y solicita el reembolso de lo cobrado.
3. **Repartidores**: aprueba tras revisión manual (18+, vehículo, documentos). Registra la capacitación (documentos, rechazo, privacidad, soporte, venta responsable); sin ella no recibirán pedidos con alcohol.
4. **Comercios**: aprueba la solicitud para publicarlo. La habilitación para alcohol es una revisión aparte.
5. **Verificación de edad**: atiende la cola siguiendo `docs/politica-edad.md`. Nunca apruebes por la sola fecha declarada.
6. **Ciudades y zonas**: pausa una ciudad o suspende una zona (lluvia, bloqueo, capacidad) con vigencia. Las reglas de alcohol requieren fuente, fecha de revisión y responsable; en producción solo cuentan las validadas.
7. **Finanzas**: genera liquidaciones por período (son reproducibles y no duplican movimientos); concilia pagos inciertos; confirma transferencias solo con el abono real a la vista. Una captura no es confirmación.
8. **Incidencias y reclamaciones**: resuelve indicando importes por concepto (productos, reparto, propina, servicio). Responde reclamaciones antes del vencimiento (alerta a 3 días).
9. **Datos personales**: atiende solicitudes ARCO; la eliminación anonimiza y conserva pedidos y movimientos.
10. **Configuración de ciudad**: edita el polígono de una zona marcando vértices en el mapa (se guarda como nueva versión), registra tarifas por ciudad o zona, ventanas de venta de alcohol (con fuente, fecha de revisión y responsable) y prohibiciones temporales.
11. **Documentos**: revisa documentos de comercios y repartidores; fija el vencimiento al aprobar. La habilitación de alcohol requiere una autorización aprobada y vigente.
12. **Liquidaciones**: generadas por una persona y aprobadas por otra; luego registra la referencia de la transferencia hecha fuera de la plataforma. Anula solo si no se ejecutó.
13. **Efectivo**: registra la rendición total del efectivo cobrado por cada repartidor con la referencia del depósito o recibo.
14. **Roles**: busca la cuenta por correo, otorga o revoca roles con motivo.

## Comercio (`/comercio`)
1. Cada operador entra con **su propia cuenta** (el propietario los agrega por correo). No compartas contraseñas.
2. **Pedidos**: acepta o rechaza con motivo antes del plazo (si no respondes, el pedido se rechaza y se reembolsa al cliente). Inicia preparación (ahí el stock sale definitivamente), ajusta la estimación si hace falta y marca **Listo**. Entrega al repartidor solo con el **código de recojo** que muestra la tarjeta.
3. **Faltantes**: usa "proponer retiro"; el cliente debe aceptar. Nunca cambies productos o importes por tu cuenta. No se puede sustituir por alcohol.
4. **Pedidos con alcohol**: el sistema revalida horario y habilitación al aceptar y al preparar; si no se cumple, recházalo con motivo.
5. **Catálogo y stock**: diferencia platos preparados (sin inventario) de artículos con stock físico (unidad explícita). Ajusta stock con motivo.
6. **Combos**: define componentes y cantidades; consumen stock real. Muestra contenido exacto; el ahorro se calcula contra precios vigentes, no infles el precio de referencia.
7. **Devoluciones**: al recibir un retorno, inspecciona y decide si vuelve a stock vendible.
8. **Ventas**: reporte por período, exportación CSV y liquidaciones.
9. **Documentos**: sube licencias y la autorización para alcohol (PDF o imagen, máx. 5 MB) con su fecha de vencimiento. Si vence, la venta de alcohol se suspende automáticamente.
10. **Precios**: edita el precio en el catálogo; aplica a nuevas compras, no a pedidos ya confirmados.

## Repartidor (app `courier-mobile`; vista web `/repartidor` de apoyo)
1. Conéctate solo cuando puedas atender pedidos; la ubicación se comparte mientras estás disponible o con una entrega activa. Desconéctate al terminar.
2. Las ofertas muestran comercio, zona de destino, distancia y pago estimados y si llevan alcohol o efectivo. Aceptar es inmediato; si otra persona la tomó, verás "ya no disponible".
3. **Opera con el vehículo detenido.**
4. En el comercio: ingresa el código de recojo y confirma la cantidad de paquetes.
5. En destino: pide el **código de entrega** (4 dígitos) solo al recibir el cliente. Si es efectivo, registra lo cobrado.
6. **Alcohol — venta responsable**: pide DNI, carné de extranjería o pasaporte; verifica que la persona sea el comprador y tenga 18 años cumplidos. No fotografíes el documento. Si no hay documento, no coincide, es menor, hay intoxicación manifiesta o riesgo, **rechaza la entrega completa** y regresa al comercio. Nunca dejes el pedido en la puerta ni lo entregues a otra persona. Sin conexión, no entregues: espera señal o llama a soporte.
7. Cliente ausente, dirección incorrecta, accidente o avería: repórtalo en la app; el pedido vuelve al comercio.
8. Tus ingresos, propinas y efectivo por rendir son registros de operación; la plataforma no custodia fondos.
