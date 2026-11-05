# Política y procedimiento de venta de bebidas alcohólicas (BORRADOR)

> Borrador de producto para revisión legal. Marco: Ley N.° 28681 y su reglamento (D.S. N.° 012-2009-SA), ordenanzas municipales aplicables (antecedentes: Padre Abad 027-2015-MPPA-A; Leoncio Prado 001-2009, **vigencia por verificar**). Algunos controles son medidas de diseño adicionales y no deben presentarse como texto literal de la ley.

## 1. Clasificación
- Cada SKU tiene `contains_alcohol` y `minimum_age` (≥ 18). Un producto, adicional o combo que contenga un componente con alcohol queda restringido (vista `v_product_restriction`), sin importar su nombre o categoría.

## 2. Estados de edad
`none` → `declared` (fecha escrita, **no habilita**) → `pending` (solicitud) → `verified` | `rejected`; `verified` → `revoked`. Solo el personal autorizado cambia el estado; el cliente no puede hacerlo por API. Cambiar nombre o fecha de nacimiento revoca la verificación.

## 3. Verificación previa a la primera compra (revisión humana)
1. El cliente envía tipo de documento (DNI, carné de extranjería o pasaporte), últimos 4 caracteres, nombre según documento, fecha de nacimiento y consentimiento.
2. Un revisor (rol admin, distinto del solicitante) realiza una **videollamada** o revisión presencial, contrasta documento y persona **sin guardar fotos**, y registra decisión, método y motivo.
3. Se rechaza automáticamente si la edad, calculada por fecha completa en hora de Lima, es menor de 18.
4. No se infiere edad por número de DNI, tarjeta bancaria, OTP o apariencia. No hay conexión con RENIEC.
5. Se conserva: resultado, fecha, método, versión de política (`politica-edad-0.1`), revisor. Plazo de retención: **por definir** con asesoría.

## 4. Reglas de venta (servidor, en cada etapa)
Se revalida al cotizar, confirmar, recibir el pago, aceptar, preparar, recoger y entregar:
comprador verificado · ciudad con alcohol habilitado · comercio con habilitación aprobada y vigente · ventana horaria permitida para la jurisdicción del comercio **y** la del destino que cubra el instante y la hora estimada de entrega · ninguna prohibición temporal activa. En ensayo/producción solo cuentan reglas `validated = true`; sin reglas validadas la venta queda cerrada. El interruptor del administrador **no** anula una prohibición. Cada regla guarda fuente, fecha de revisión y responsable.

## 5. Entrega presencial
- Antes del pago se informa que se exigirá documento y que, si la verificación falla, el pedido completo no se entrega y retorna para revisión.
- El repartidor (con capacitación registrada) comprueba documento, coincidencia con el comprador y 18 años cumplidos. Registra resultado, tipo de documento y motivo de rechazo. **No fotografía el documento.**
- El servidor bloquea "entregado" sin comprobación aprobada para esa entrega. El código de entrega no la reemplaza. Prohibido dejar en la puerta, entregar a terceros o a menores.
- Rechazos: sin documento, identidad no coincide, menor de edad, no es el comprador, intoxicación manifiesta, riesgo de seguridad (sin exigir diagnóstico médico). Generan incidencia, retorno al comercio e inspección.
- Sin conexión: no se entrega; se espera señal o se contacta a soporte.

## 6. Comunicación
Mensajes visibles: "Prohibida la venta de bebidas alcohólicas a menores de 18 años" y "Tomar bebidas alcohólicas en exceso es dañino". Contenido de alcohol oculto en catálogo, búsqueda, enlaces directos y favoritos para cuentas no verificadas. Notificaciones en pantalla bloqueada sin detalles. Marketing de alcohol solo a verificados con consentimiento `marketing_alcohol`. No se dirigen campañas a menores ni se incentiva el consumo excesivo o conducir tras beber.
