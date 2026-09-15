/**
 * Mapeo de columnas del Excel al payload de POST /api/puntoVenta (Finnegans).
 *
 * El Excel tiene una fila por ítem. Las filas que comparten NUMERO forman
 * un mismo punto de venta: la cabecera se toma de la primera fila del grupo
 * y cada fila aporta un elemento de Productos.
 *
 * La estructura replica un JSON validado contra el tenant (2026-07):
 *   - fechas en aaaa-mm-dd (la doc decía dd/mm/aaaa, pero lo que funciona es ISO)
 *   - alias de campos (ClienteCodigo, Productos, Cantidad, ...)
 *   - subtipo del Excel o PTOVTA-FV cuando la columna no existe/esta vacia
 *   - todo pago TC/TD usa PuntoVentaItemsTarjeta y la cuenta depende de la tarjeta
 *   - TRANSFDEP usa PuntoVentaItemsBanco para transferencias de terceros
 *   - los demas pagos usan PuntoVentaItemsOtros contra la cuenta TCV
 *   - Conceptos se genera segun PORCENTAJE (21% o 10,5%); 0% es exento
 *   - totales como strings
 */

const XLSX = require('xlsx');

const CONFIG = {
  TRANSACCION_TIPO: 'OPER',
  // Empresa fija requerida para todos los puntos de venta generados.
  EMPRESA_CODIGO: 'ejemplo',
  // Subtipo del circuito de punto de venta (sobreescribible desde la UI)
  SUBTIPO_DEFAULT: 'PTOVTA-FV',
  SUBTIPO_NOTA_CREDITO_DEFAULT: 'PTOVTA-NC',
  // Tipo impositivo según la letra del comprobante (B-00003-... → B).
  // Letras sin entrada (ej: T) hacen que el campo se omita (es opcional).
  TIPO_IMPOSITIVO_POR_LETRA: { A: '001', B: '006' },
  // Cuenta puente para el cobro con tarjeta (PuntoVentaItemsOtros)
  CUENTA_PAGO_OTROS: 'TCV',
  // Regla de tarjeta informada por el circuito de punto de venta.
  TARJETA: {
    CONDICION_PAGO: 'TC/TD',
    CUENTA_DEFAULT: '13100',
    CUENTAS_POR_COMPROBANTE_ADICIONAL: {
      '9510 AMERICAN EXPRESS': '13103',
      '9520 VISA': '13100',
      '9530 MASTERCARD': '13102',
    },
  },
  EFECTIVO: {
    CONDICION_PAGO: 'CONTADO',
    CUENTAS_POR_MONEDA: {
      PES: '10000',
      DOL: '10010',
    },
  },
  BANCO: {
    CONDICION_PAGO: 'TRANSFDEP',
    OPERACION_BANCARIA: 'TRANSFERENCIATER',
    MONEDA_COBRO: 'PES',
    CUENTA: '11000',
  },
  CONDICION_CUENTA_CORRIENTE: 'CTACTE',
  CONCEPTOS_POR_TASA: {
    '10.5': { codigo: 'VENTA_IVA 10,5', tasa: 10.5 },
    '21': { codigo: 'VENTA_IVA 21', tasa: 21 },
  },
  CONCEPTO_IVA_21_DOCUMENTO_T: 'VENTA_IVA21_T',
  // Los códigos de vendedor del Excel (251, 263, ...) no existen en el
  // tenant, así que el vendedor se omite. Poné un código válido (ej:
  // 'GTC_02') para enviarlo fijo en todos los comprobantes.
  VENDEDOR_DEFAULT: null,
};

/** Convierte fecha (Date | serial Excel | string) a partes {y, m, d}. */
function toDateParts(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return { y: value.getFullYear(), m: value.getMonth() + 1, d: value.getDate() };
  }
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    return parsed ? { y: parsed.y, m: parsed.m, d: parsed.d } : null;
  }
  const str = String(value).trim();
  const iso = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return { y: +iso[1], m: +iso[2], d: +iso[3] };
  const dmy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) return { y: +dmy[3], m: +dmy[2], d: +dmy[1] };
  return null;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Formato aaaa-mm-dd (el que acepta el tenant en la práctica). */
function toIsoDate(value) {
  const p = toDateParts(value);
  return p ? `${p.y}-${pad2(p.m)}-${pad2(p.d)}` : null;
}

function toNumberOrNull(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function toStringOrNull(value) {
  if (value == null) return null;
  const str = String(value).trim();
  return str === '' ? null : str;
}

/** Compara codigos del Excel sin depender de mayusculas o espacios repetidos. */
function normalizeCode(value) {
  const str = toStringOrNull(value);
  return str == null ? null : str.replace(/\s+/g, ' ').toUpperCase();
}

function esPagoTarjeta(row) {
  return normalizeCode(row.CONDICIONPAGO) === CONFIG.TARJETA.CONDICION_PAGO;
}

function cuentaTarjeta(row) {
  const comprobanteAdicional = normalizeCode(row.COMPROBANTEADICIONAL);
  return (
    CONFIG.TARJETA.CUENTAS_POR_COMPROBANTE_ADICIONAL[comprobanteAdicional] ??
    CONFIG.TARJETA.CUENTA_DEFAULT
  );
}

function esPagoContado(row) {
  return normalizeCode(row.CONDICIONPAGO) === CONFIG.EFECTIVO.CONDICION_PAGO;
}

function esPagoBanco(row) {
  return normalizeCode(row.CONDICIONPAGO) === CONFIG.BANCO.CONDICION_PAGO;
}

function esCuentaCorriente(row) {
  return normalizeCode(row.CONDICIONPAGO) === CONFIG.CONDICION_CUENTA_CORRIENTE;
}

function tipoComprobanteCodigo(row) {
  return normalizeCode(row['TIPO COMPROBANTE'] ?? row['TIPO DE COMPROBANTE']);
}

/** Deja solo digitos y elimina ceros a la izquierda (conserva "0" si todos son cero). */
function toNumericCode(value) {
  const str = toStringOrNull(value);
  if (str == null) return null;
  const digits = str.replace(/\D/g, '');
  if (digits === '') return null;
  return digits.replace(/^0+(?=\d)/, '');
}

const round2 = (n) => {
  const signo = n < 0 ? -1 : 1;
  return signo * (Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100);
};

/** En notas de credito invierte el signo informado por el Excel. */
function ajustarImporteNotaCredito(valor, notaCredito) {
  if (valor == null || !notaCredito) return valor;
  return round2(valor * -1);
}

/** Convierte "21%" o "10,5%" a una tasa numerica. */
function toTaxRate(value) {
  const str = toStringOrNull(value);
  if (str == null) return null;
  const rate = Number(str.replace('%', '').replace(',', '.').trim());
  return Number.isFinite(rate) ? rate : null;
}

function conceptoConfigPorTasa(rate) {
  if (rate == null) return null;
  return CONFIG.CONCEPTOS_POR_TASA[String(rate)] ?? null;
}

function buildConceptos(filas, comprobante) {
  const acumulados = new Map();

  for (const { row, excelRow } of filas) {
    const tasa = toTaxRate(row.PORCENTAJE);
    if (tasa == null || tasa === 0) continue;

    const config = conceptoConfigPorTasa(tasa);
    if (!config) {
      throw new Error(`Porcentaje impositivo no soportado en la fila ${excelRow}: ${row.PORCENTAJE}`);
    }

    const cantidad = toNumberOrNull(row.CANTIDAD) ?? 0;
    const precio = toNumberOrNull(row.PRECIO) ?? 0;
    const importeIva = toNumberOrNull(row.IVA) ?? 0;
    const importeReintegro = toNumberOrNull(row.REINTEGRO) ?? 0;
    const actual = acumulados.get(String(config.tasa)) ?? {
      config,
      importe: 0,
      reintegro: 0,
      gravado: 0,
    };

    actual.importe += importeIva;
    actual.reintegro += importeReintegro;
    actual.gravado += cantidad * precio;
    acumulados.set(String(config.tasa), actual);
  }

  const conceptos = [];
  const comprobanteT = String(comprobante ?? '').trim().toUpperCase().startsWith('T');

  for (const config of Object.values(CONFIG.CONCEPTOS_POR_TASA)) {
    const acumulado = acumulados.get(String(config.tasa));
    if (!acumulado) continue;

    conceptos.push({
      ConceptoCodigo: config.codigo,
      ImporteEditable: false,
      ConceptoImporte: round2(acumulado.importe),
      ConceptoImporteGravado: round2(acumulado.gravado),
      TasaImpositiva: config.tasa,
    });

    if (config.tasa === 21 && comprobanteT) {
      // Finnegans resta este concepto internamente. Enviarlo con signo opuesto
      // provoca una doble negacion (IVA - (-reintegro)) y duplica el impuesto.
      const referenciaSigno = acumulado.importe || acumulado.gravado;
      const reintegroMismoSigno =
        (referenciaSigno < 0 ? -1 : 1) * Math.abs(acumulado.reintegro);
      conceptos.push({
        ConceptoCodigo: CONFIG.CONCEPTO_IVA_21_DOCUMENTO_T,
        ImporteEditable: false,
        ConceptoImporte: round2(reintegroMismoSigno),
        ConceptoImporteGravado: round2(acumulado.gravado),
        TasaImpositiva: config.tasa,
      });
    }
  }

  return conceptos;
}

/** Elimina claves null/undefined/'' y arrays vacíos (0 y false se conservan). */
function cleanObject(obj) {
  if (Array.isArray(obj)) {
    const arr = obj.map(cleanObject).filter((v) => v != null);
    return arr.length ? arr : null;
  }
  if (obj !== null && typeof obj === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
      const cleaned = cleanObject(value);
      if (cleaned !== null && cleaned !== undefined && cleaned !== '') out[key] = cleaned;
    }
    return Object.keys(out).length ? out : null;
  }
  return obj === '' ? null : obj;
}

/** Normaliza nombres de columna: mayúsculas, sin espacios extra. */
function normalizeHeader(header) {
  return String(header || '').trim().toUpperCase();
}

/**
 * Parsea el workbook y devuelve las filas como objetos {COLUMNA: valor}
 * usando la primera hoja (ignora hojas de metadata tipo XDO_METADATA).
 */
function parseRows(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames.find((n) => !n.toUpperCase().includes('METADATA'));
  if (!sheetName) throw new Error('El archivo no tiene hojas de datos.');
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null, raw: true });
  return rows.map((row) => {
    const normalized = {};
    for (const [key, value] of Object.entries(row)) normalized[normalizeHeader(key)] = value;
    return normalized;
  });
}

/** Tipo impositivo a partir de la letra del comprobante ("B-00003-..." → "006"). */
function tipoImpositivoDeComprobante(comprobante) {
  if (!comprobante) return null;
  const letra = String(comprobante).trim().charAt(0).toUpperCase();
  return CONFIG.TIPO_IMPOSITIVO_POR_LETRA[letra] ?? null;
}

/**
 * Agrupa las filas por NUMERO (fallback: COMPROBANTE) y construye un
 * payload de puntoVenta por grupo.
 *
 * @param rows filas normalizadas del Excel
 * @param defaults valores opcionales desde la UI (reservado por compatibilidad)
 */
function buildPedidos(rows, defaults = {}) {
  const grupos = new Map();
  rows.forEach((row, index) => {
    const key = toStringOrNull(row.NUMERO) ?? toStringOrNull(row.COMPROBANTE) ?? `fila-${index}`;
    if (!grupos.has(key)) grupos.set(key, []);
    grupos.get(key).push({ row, excelRow: index + 2 }); // +2: 1 de header, 1 porque es 1-indexado
  });

  const pedidos = [];
  for (const [numero, filas] of grupos) {
    const head = filas[0].row;
    const comprobante = toStringOrNull(head.COMPROBANTE);
    const moneda = toStringOrNull(head.MONEDA);
    const condicionPago = toStringOrNull(head.CONDICIONPAGO);
    const pagoTarjeta = esPagoTarjeta(head);
    const cuentaPagoTarjeta = cuentaTarjeta(head);
    const pagoContado = esPagoContado(head);
    const pagoBanco = esPagoBanco(head);
    const cuentaCorriente = esCuentaCorriente(head);
    const tipoComprobante = tipoComprobanteCodigo(head);
    const fechaPago = toIsoDate(head.FECHA);
    const cuentaEfectivo = CONFIG.EFECTIVO.CUENTAS_POR_MONEDA[normalizeCode(moneda)] ?? null;

    const notaCredito = tipoComprobante === 'NC';
    const totalBrutoConSigno = round2(
      filas.reduce((sum, { row }) => {
        const cant = toNumberOrNull(row.CANTIDAD) ?? 0;
        const precio = toNumberOrNull(row.PRECIO) ?? 0;
        return sum + cant * precio;
      }, 0)
    );
    const conceptosConSigno = buildConceptos(filas, comprobante);
    const totalConceptosConSigno = round2(
      conceptosConSigno.reduce(
        (sum, concepto) =>
          sum +
          (concepto.ConceptoCodigo === CONFIG.CONCEPTO_IVA_21_DOCUMENTO_T
            ? -concepto.ConceptoImporte
            : concepto.ConceptoImporte),
        0
      )
    );
    const totalConSigno = round2(totalBrutoConSigno + totalConceptosConSigno);
    const conceptos = notaCredito
      ? conceptosConSigno.map((concepto) => ({
          ...concepto,
          ConceptoImporte: ajustarImporteNotaCredito(concepto.ConceptoImporte, true),
          ConceptoImporteGravado: ajustarImporteNotaCredito(concepto.ConceptoImporteGravado, true),
        }))
      : conceptosConSigno;
    const totalBruto = ajustarImporteNotaCredito(totalBrutoConSigno, notaCredito);
    const totalConceptos = ajustarImporteNotaCredito(totalConceptosConSigno, notaCredito);
    const total = ajustarImporteNotaCredito(totalConSigno, notaCredito);

    const payload = cleanObject({
      IdentificacionExterna: comprobante ?? `PV-${numero}`,
      Fecha: toIsoDate(head.FECHA),
      FechaComprobante: toIsoDate(head.FECHACOMPROBANTE),
      FechaBaseVencimiento: toIsoDate(head.FECHABASEVENCIMIENTO),
      ClienteCodigo: toStringOrNull(head.CLIENTE),
      CondicionPagoCodigo: condicionPago,
      MonedaCodigo: moneda,
      ComprobanteTipoImpositivoID: tipoImpositivoDeComprobante(comprobante),
      TransaccionTipoCodigo: CONFIG.TRANSACCION_TIPO,
      WorkflowCodigo: toStringOrNull(head.WORKFLOW),
      TransaccionSubtipoCodigo:
        tipoComprobante === 'NC'
          ? toStringOrNull(defaults.subtipoNotaCreditoId) ?? CONFIG.SUBTIPO_NOTA_CREDITO_DEFAULT
          : tipoComprobante === 'FC'
            ? toStringOrNull(defaults.subtipoId) ?? CONFIG.SUBTIPO_DEFAULT
            : toStringOrNull(head.TRANSACCIONSUBTIPO) ??
              toStringOrNull(defaults.subtipoId) ??
              CONFIG.SUBTIPO_DEFAULT,
      Descripcion: toStringOrNull(head.DESCRIPCION),
      NumeroComprobante: comprobante,
      EmpresaCodigo:
        toStringOrNull(defaults.empresaId) ??
        toStringOrNull(head.SUCURSAL) ??
        CONFIG.EMPRESA_CODIGO,
      VendedorCodigo: CONFIG.VENDEDOR_DEFAULT,
      Productos: filas.map(({ row }) => {
        const cantidad = toNumberOrNull(row.CANTIDAD);
        const precioOriginal = toNumberOrNull(row.PRECIO);
        const precioRedondeado = precioOriginal != null ? round2(precioOriginal) : null;
        const precio = ajustarImporteNotaCredito(precioRedondeado, notaCredito);
        const tasa = toTaxRate(row.PORCENTAJE);
        const importeOriginal =
          precioOriginal != null && cantidad != null ? round2(precioOriginal * cantidad) : null;
        const importe = ajustarImporteNotaCredito(importeOriginal, notaCredito);
        return {
          ProductoCodigo: toStringOrNull(row.PRODUCTO),
          Precio: precio,
          Cantidad: cantidad,
          Descripcion: toStringOrNull(row.DESCRIPCIONITEM),
          PrecioTipo: 0,
          Descuento1: toNumberOrNull(row.DESCUENTO1) ?? 0,
          Descuento2: toNumberOrNull(row.DESCUENTO2) ?? 0,
          ImporteExento: tasa == null || tasa === 0 ? importe : 0,
        };
      }),
      Conceptos: conceptos,
      PuntoVentaItemsBanco: pagoBanco
        ? [
            {
              OperacionBancariaCodigo: CONFIG.BANCO.OPERACION_BANCARIA,
              ImporteACobrar: total.toFixed(2),
              MonedaCobroCodigo: CONFIG.BANCO.MONEDA_COBRO,
              NroCheque: toNumericCode(comprobante),
              FechaVencimientoCheque: fechaPago,
              FechaCheque: fechaPago,
              Cuenta: CONFIG.BANCO.CUENTA,
            },
          ]
        : null,
      PuntoVentaItemsTarjeta: pagoTarjeta
        ? [
            {
              OperacionBancariaCodigo: condicionPago,
              CuentaCodigo: cuentaPagoTarjeta,
              Descripcion: toStringOrNull(head.COMPROBANTEADICIONAL),
              FechaCupon: fechaPago,
              FechaVencimientoTarjeta: fechaPago,
              DocumentoTitular: toStringOrNull(head.CLIENTE),
              NroCupon: toNumericCode(comprobante),
              ImporteACobrar: total.toFixed(2),
              MonedaCobroCodigo: moneda,
            },
          ]
        : null,
      PuntoVentaItemsEfectivo: pagoContado
        ? [
            {
              ImporteACobrar: total.toFixed(2),
              MonedaCobroCodigo: moneda,
              CuentaCodigo: cuentaEfectivo,
            },
          ]
        : null,
      PuntoVentaItemsOtros: pagoTarjeta || pagoContado || pagoBanco || cuentaCorriente
        ? null
        : [
            {
              CuentaCodigo: CONFIG.CUENTA_PAGO_OTROS,
              DebeHaber: 1,
              ImporteACobrar: total.toFixed(2),
              MonedaCobroCodigo: moneda,
            },
          ],
      Cotizaciones:
        toStringOrNull(head.MONEDA_COTIZACION) != null
          ? [{ MonedaCodigo: toStringOrNull(head.MONEDA_COTIZACION), Cotizacion: toNumberOrNull(head.COTIZACION) }]
          : null,
      Vuelto: '0.00',
      TotalBruto: totalBruto.toFixed(2),
      TotalConceptos: totalConceptos.toFixed(2),
      Total: total.toFixed(2),
      TotalRetenciones: '0.00',
      TotalPagos: total.toFixed(2),
    });

    pedidos.push({
      numero,
      comprobante,
      cliente: toStringOrNull(head.CLIENTE),
      descripcion: toStringOrNull(head.DESCRIPCION),
      fecha: toIsoDate(head.FECHA),
      items: filas.length,
      filasExcel: filas.map((f) => f.excelRow),
      total,
      payload,
    });
  }
  return pedidos;
}

module.exports = { parseRows, buildPedidos, cleanObject, toIsoDate, CONFIG };
