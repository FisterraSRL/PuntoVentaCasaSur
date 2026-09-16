# Finnegans FileSender — Puntos de Venta

Portal web para subir un archivo Excel y enviar su contenido como puntos de venta a Finnegans (`POST /api/puntoVenta`).

## Cómo usarlo

```bash
npm install       # solo la primera vez
npm start         # levanta el portal en http://localhost:4600
```

Abrí `http://localhost:4600` en el navegador:

1. **Seleccionar archivo** — arrastrá o elegí el `.xlsx`. Opcionalmente seleccioná una empresa, que tendrá prioridad sobre la columna `SUCURSAL`, y un `TransaccionSubtipoID` por defecto.
2. **Vista previa** — el archivo se agrupa por `NUMERO`: cada grupo es un punto de venta y cada fila un ítem. Con "Ver JSON" podés inspeccionar el payload exacto antes de enviar. Destildá los que no quieras mandar.
3. **Enviar** — divide la selección en lotes de 40, envía cada punto de venta uno por uno y muestra en tiempo real cuántos ingresaron correctamente (por ejemplo, `2 de 627 ingresados OK`). Cada fila muestra su estado (verde = creado, rojo = error; clic en el estado rojo muestra la respuesta completa de Finnegans).

## Formato del Excel

Una fila por ítem. Filas con el mismo `NUMERO` forman un mismo punto de venta. Columnas usadas:

| Columna | Campo API (alias) |
|---|---|
| NUMERO | agrupador de comprobante |
| COMPROBANTE | `IdentificacionExterna` + `NumeroComprobante`; su letra inicial define `ComprobanteTipoImpositivoID` (A→001, B→006 — configurable) |
| FECHA / FECHACOMPROBANTE / FECHABASEVENCIMIENTO | `Fecha` / `FechaComprobante` / `FechaBaseVencimiento` (aaaa-mm-dd) |
| CLIENTE | `ClienteCodigo` |
| CONDICIONPAGO | `CondicionPagoCodigo` |
| MONEDA | `MonedaCodigo` |
| TIPO COMPROBANTE | Define `TransaccionSubtipoCodigo`: `FC` usa el valor por defecto (`PTOVTA-FV`) y `NC` usa el valor de nota de crédito (`PTOVTA-NC`) |
| TRANSACCIONSUBTIPO | Solo se usa como respaldo cuando `TIPO COMPROBANTE` no es `FC` ni `NC` |
| DESCRIPCION | `Descripcion` |
| SUCURSAL | Se usa como `EmpresaCodigo` si no se elige una empresa. La selección de la interfaz tiene prioridad y `ejemplo` queda como respaldo final. |
| MONEDA_COTIZACION + COTIZACION | `Cotizaciones` |
| PRODUCTO / DESCRIPCIONITEM / CANTIDAD / PRECIO | ítem en `Productos` (`ProductoCodigo`, `Descripcion`, `Cantidad`, `Precio`) |
| PORCENTAJE / IVA | `Conceptos`; 21% usa `VENTA_IVA 21`, 10,5% usa `VENTA_IVA 10,5` y 0% se registra como `ImporteExento` del producto |

Además el payload incluye automáticamente (según JSON validado contra el tenant):

- `TransaccionTipoCodigo: OPER` y `WorkflowCodigo` tomado de la columna `WORKFLOW` del Excel.
- `Conceptos` agrupa por alícuota los importes de `IVA` y las bases gravadas (`PRECIO` × `CANTIDAD`). Las filas con 0% no generan conceptos y se informan como importes exentos.
- Para alícuota 21%, todos los comprobantes generan `VENTA_IVA 21`. Si `COMPROBANTE` comienza con `T`, además se genera `VENTA_IVA21_T` usando el importe de `REINTEGRO` del Excel con el mismo signo que el IVA. Finnegans resta internamente este concepto, por lo que `TotalConceptos` se calcula como IVA menos reintegro.
- Cuando `TIPO COMPROBANTE` es `NC`, todos los importes se multiplican por `-1`: precios, bases gravadas, conceptos y totales invierten el signo informado por el Excel (`-100` se envía como `100`; `100` se envía como `-100`). Además, las NC no incluyen ningún arreglo de cobranza, independientemente de `CONDICIONPAGO`, siguiendo el mismo criterio que una factura en cuenta corriente.
- Cuando `CONDICIONPAGO` es `TC/TD`, el cobro se genera en `PuntoVentaItemsTarjeta` y la cuenta depende de `COMPROBANTEADICIONAL`: `9510 American Express` usa `13103`, `9520 Visa` usa `13100` y `9530 MasterCard` usa `13102`. Para otros valores se conserva `13100` como cuenta de respaldo. `OperacionBancariaCodigo` se toma de `CONDICIONPAGO`; `COMPROBANTEADICIONAL` se copia en `Descripcion`, `CLIENTE` se usa como documento del titular y `COMPROBANTE`, conservando solo sus digitos y sin ceros iniciales, como numero de cupon.
- Cuando `CONDICIONPAGO` es `TRANSFDEP`, se genera unicamente `PuntoVentaItemsBanco` con `OperacionBancariaCodigo: TRANSFERENCIATER`, moneda `PES`, `Cuenta: 11000`, el importe total del comprobante y `NroCheque` normalizado de la misma manera que el cupon de tarjeta. `FechaVencimientoCheque` y `FechaCheque` toman `FECHA` del Excel.
- Cuando `CONDICIONPAGO` es `CONTADO`, se genera unicamente `PuntoVentaItemsEfectivo`: para moneda `PES` usa la cuenta `10000` y para `DOL` la cuenta `10010`.
- Cuando `CONDICIONPAGO` es `CTACTE`, no se incluye ningun arreglo de cobro.
- Los demas cobros se generan como `PuntoVentaItemsOtros` contra la cuenta puente `TCV` por el total del comprobante.
- Todos los importes monetarios se redondean a dos decimales: precios, exentos, conceptos, bases gravadas, cobros y totales. Los totales se envían como strings: `Total`, `TotalBruto`, `TotalPagos`, `TotalConceptos`, `TotalRetenciones`, `Vuelto`.
- `VendedorCodigo` se omite (los códigos del Excel no existen en el tenant).

Estas constantes (subtipo, cuenta de cobro, tipos impositivos por letra, vendedor) se ajustan en el bloque `CONFIG` de [mapping.js](mapping.js). Columnas vacías se omiten del payload.

## Configuración

`EmpresaCodigo` usa primero la empresa seleccionada, luego la columna `SUCURSAL` y finalmente `ejemplo` como respaldo.

Credenciales en `.env` (no se exponen al navegador; el envío pasa por el servidor local):

```
FINNEGANS_CLIENT_ID=...
FINNEGANS_CLIENT_SECRET=...
PORT=4600
```

## Estructura

- `server.js` — Express: sirve el portal, `POST /api/parse` (parsea y arma la vista previa) y `POST /api/enviar` (obtiene el token OAuth de Teamplace y postea cada punto de venta a Finnegans).
- `mapping.js` — parseo del Excel y armado del payload (editable).
- `public/` — frontend (HTML/CSS/JS sin frameworks).
- `ejemplo-pedido-venta.xlsx` — archivo de ejemplo usado para desarrollar el mapeo.
