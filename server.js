const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const multer = require('multer');
const { parseRows, buildPedidos } = require('./mapping');

const PORT = process.env.PORT || 4600;
const CLIENT_ID = process.env.FINNEGANS_CLIENT_ID;
const CLIENT_SECRET = process.env.FINNEGANS_CLIENT_SECRET;

const TOKEN_URL = 'https://api.teamplace.finneg.com/api/oauth/token';
const PUNTO_VENTA_URL = 'https://api.finneg.com/api/puntoVenta';
const EMPRESAS_URL = 'https://api.finneg.com/api/empresaSucursal/list';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/** El token de Finnegans viene como texto plano en el body de la respuesta. */
async function getAccessToken() {
  const url = `${TOKEN_URL}?grant_type=client_credentials&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`;
  const res = await fetch(url);
  const text = (await res.text()).trim();
  if (!res.ok || !text) {
    throw new Error(`No se pudo obtener el token de Finnegans (HTTP ${res.status}): ${text || 'respuesta vacía'}`);
  }
  return text;
}

/** Lista de empresas del tenant para el selector de EmpresaCodigo. */
app.get('/api/empresas', async (_req, res) => {
  try {
    const token = await getAccessToken();
    const response = await fetch(`${EMPRESAS_URL}?ACCESS_TOKEN=${encodeURIComponent(token)}`);
    const text = await response.text();
    if (!response.ok) {
      return res.status(502).json({ error: `Finnegans respondió HTTP ${response.status}: ${text.slice(0, 200)}` });
    }
    let data = JSON.parse(text);
    // La respuesta puede venir como array o envuelta en data/rows/result
    if (!Array.isArray(data)) data = data.data ?? data.rows ?? data.result ?? [];
    const empresas = data
      .filter((e) => e && e.codigo && e.activo !== false)
      .map((e) => ({ codigo: String(e.codigo), nombre: String(e.nombre ?? e.codigo) }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    res.json({ empresas });
  } catch (err) {
    res.status(502).json({ error: `No se pudo obtener la lista de empresas: ${err.message}` });
  }
});

/** Sube el Excel, lo parsea y devuelve la vista previa de pedidos (no envía nada). */
app.post('/api/parse', upload.single('archivo'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo.' });
    const rows = parseRows(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: 'El archivo no tiene filas de datos.' });
    const defaults = {
      empresaId: req.body.empresaId || null,
      subtipoId: req.body.subtipoId || null,
      subtipoNotaCreditoId: req.body.subtipoNotaCreditoId || null,
    };
    const pedidos = buildPedidos(rows, defaults);
    res.json({ archivo: req.file.originalname, filas: rows.length, pedidos });
  } catch (err) {
    res.status(400).json({ error: `No se pudo leer el archivo: ${err.message}` });
  }
});

/** Envía los pedidos (payloads ya construidos) a Finnegans, uno por uno. */
app.post('/api/enviar', async (req, res) => {
  const { pedidos } = req.body || {};
  const transmitirProgreso = req.get('accept')?.includes('application/x-ndjson');
  if (!Array.isArray(pedidos) || !pedidos.length) {
    return res.status(400).json({ error: 'No hay pedidos para enviar.' });
  }

  let token;
  try {
    token = await getAccessToken();
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  if (transmitirProgreso) {
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
  }

  const resultados = [];
  for (const [indice, pedido] of pedidos.entries()) {
    const resultado = { numero: pedido.numero, comprobante: pedido.comprobante };
    try {
      const response = await fetch(`${PUNTO_VENTA_URL}?ACCESS_TOKEN=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pedido.payload),
      });
      const text = await response.text();
      let body = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* respuesta no-JSON: se devuelve el texto tal cual */
      }
      resultado.ok = response.ok;
      resultado.status = response.status;
      resultado.respuesta = body;
    } catch (err) {
      resultado.ok = false;
      resultado.status = 0;
      resultado.respuesta = `Error de red: ${err.message}`;
    }
    resultados.push(resultado);
    if (transmitirProgreso) {
      res.write(`${JSON.stringify({ tipo: 'resultado', indice, resultado })}\n`);
    }
  }

  if (transmitirProgreso) {
    res.end(`${JSON.stringify({ tipo: 'fin', total: resultados.length })}\n`);
  } else {
    res.json({ resultados });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn('ADVERTENCIA: faltan FINNEGANS_CLIENT_ID / FINNEGANS_CLIENT_SECRET en .env — el envío va a fallar.');
  }
  console.log(`Finnegans FileSender escuchando en http://localhost:${PORT}`);
});
