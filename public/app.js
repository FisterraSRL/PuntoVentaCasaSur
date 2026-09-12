const $ = (id) => document.getElementById(id);

const dropzone = $('dropzone');
const fileInput = $('fileInput');
const dzFile = $('dzFile');
const btnParse = $('btnParse');
const btnSend = $('btnSend');
const spinner = $('spinner');
const sendProgress = $('sendProgress');

let archivo = null;
let pedidos = [];
const TAMANO_LOTE = 40;

// ---------- Selector de empresas ----------

async function cargarEmpresas() {
  const select = $('empresaId');
  try {
    const res = await fetch('/api/empresas');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Error HTTP ${res.status}`);
    select.innerHTML = '<option value="">Seleccioná una empresa…</option>';
    for (const e of data.empresas) {
      const opt = document.createElement('option');
      opt.value = e.codigo;
      opt.textContent = e.nombre;
      select.appendChild(opt);
    }
  } catch (err) {
    select.innerHTML = '<option value="">No se pudieron cargar las empresas — reintentá</option>';
    console.error('Error cargando empresas:', err);
  }
}
cargarEmpresas();

// ---------- Paso 1: selección de archivo ----------

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) setFile(fileInput.files[0]);
});

function setFile(file) {
  archivo = file;
  dzFile.textContent = `📄 ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
  btnParse.disabled = false;
  $('parseError').textContent = '';
}

// ---------- Paso 2: analizar ----------

btnParse.addEventListener('click', async () => {
  if (!archivo) return;
  btnParse.disabled = true;
  $('parseError').textContent = '';
  try {
    const form = new FormData();
    form.append('archivo', archivo);
    form.append('empresaId', $('empresaId').value.trim());
    form.append('subtipoId', $('subtipoId').value.trim());
    form.append('subtipoNotaCreditoId', $('subtipoNotaCreditoId').value.trim());
    const res = await fetch('/api/parse', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Error HTTP ${res.status}`);
    pedidos = data.pedidos;
    renderPreview(data);
  } catch (err) {
    $('parseError').textContent = err.message;
  } finally {
    btnParse.disabled = false;
  }
});

function renderPreview(data) {
  const totalItems = pedidos.reduce((s, p) => s + p.items, 0);
  $('previewSummary').innerHTML =
    `<strong>${data.archivo}</strong>: ${data.filas} filas → <strong>${pedidos.length} puntos de venta</strong> (${totalItems} ítems). ` +
    `Revisá los payloads antes de enviar.`;

  const tbody = document.querySelector('#previewTable tbody');
  tbody.innerHTML = '';
  pedidos.forEach((p, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" class="chk" data-i="${i}" checked /></td>
      <td>${escapeHtml(p.numero)}</td>
      <td>${escapeHtml(p.comprobante ?? '—')}</td>
      <td>${escapeHtml(p.cliente ?? '—')}</td>
      <td>${escapeHtml(p.fecha ?? '—')}</td>
      <td class="num">${p.items}</td>
      <td class="num">$ ${p.total.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
      <td><button class="btn-link" data-json="${i}">Ver JSON</button></td>
      <td><span class="badge badge-pending" id="estado-${i}">Pendiente</span></td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('[data-json]').forEach((btn) =>
    btn.addEventListener('click', () => showJson(Number(btn.dataset.json)))
  );

  $('card-preview').classList.remove('hidden');
  $('card-result').classList.add('hidden');
  $('sendError').textContent = '';
  sendProgress.textContent = '';
  sendProgress.classList.add('hidden');
  $('card-preview').scrollIntoView({ behavior: 'smooth' });
}

$('checkAll').addEventListener('change', (e) => {
  document.querySelectorAll('.chk').forEach((c) => (c.checked = e.target.checked));
});

// ---------- Modal JSON ----------

function showJson(i) {
  $('jsonTitle').textContent = `Payload — Punto de venta ${pedidos[i].numero} (${pedidos[i].comprobante ?? 'sin comprobante'})`;
  $('jsonBody').textContent = JSON.stringify(pedidos[i].payload, null, 2);
  $('jsonModal').classList.remove('hidden');
}
$('jsonClose').addEventListener('click', () => $('jsonModal').classList.add('hidden'));
$('jsonModal').addEventListener('click', (e) => {
  if (e.target === $('jsonModal')) $('jsonModal').classList.add('hidden');
});

// ---------- Paso 3: enviar ----------

btnSend.addEventListener('click', async () => {
  const seleccion = [...document.querySelectorAll('.chk')]
    .filter((c) => c.checked)
    .map((c) => Number(c.dataset.i));
  if (!seleccion.length) {
    $('sendError').textContent = 'Seleccioná al menos un punto de venta.';
    return;
  }
  if (!confirm(`Se van a enviar ${seleccion.length} punto(s) de venta a Finnegans. ¿Continuar?`)) return;

  btnSend.disabled = true;
  spinner.classList.remove('hidden');
  sendProgress.textContent = `0 de ${seleccion.length} ingresados OK`;
  sendProgress.classList.remove('hidden');
  $('sendError').textContent = '';
  seleccion.forEach((i) => setEstado(i, 'pending', 'Enviando…'));

  let ok = 0;
  let procesados = 0;
  const procesadosIndices = new Set();
  const resultados = [];

  try {
    for (let inicio = 0; inicio < seleccion.length; inicio += TAMANO_LOTE) {
      const lote = seleccion.slice(inicio, inicio + TAMANO_LOTE);
      const numeroLote = Math.floor(inicio / TAMANO_LOTE) + 1;
      const totalLotes = Math.ceil(seleccion.length / TAMANO_LOTE);

      const res = await fetch('/api/enviar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
        },
        body: JSON.stringify({ pedidos: lote.map((i) => pedidos[i]) }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(`Falló el lote ${numeroLote} de ${totalLotes}: ${data.error || `Error HTTP ${res.status}`}`);
      }

      if (!res.body) throw new Error('El navegador no pudo leer el progreso del envío.');

      let procesadosLote = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const procesarLinea = (linea) => {
        if (!linea.trim()) return;
        const evento = JSON.parse(linea);
        if (evento.tipo !== 'resultado') return;

        const r = evento.resultado;
        const i = lote[evento.indice];
        resultados.push(r);
        procesados++;
        procesadosLote++;
        procesadosIndices.add(i);
        if (r.ok) {
          ok++;
          setEstado(i, 'ok', `Enviado (${r.status})`);
        } else {
          setEstado(i, 'err', `Error (${r.status || 'red'})`, r.respuesta);
        }
        sendProgress.textContent = `${ok} de ${seleccion.length} ingresados OK`;
      };

      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lineas = buffer.split('\n');
        buffer = lineas.pop() || '';
        lineas.forEach(procesarLinea);
        if (done) break;
      }
      procesarLinea(buffer);

      if (procesadosLote !== lote.length) {
        throw new Error(
          `El lote ${numeroLote} de ${totalLotes} se interrumpió después de procesar ` +
          `${procesadosLote} de ${lote.length} registros. Avance total: ${procesados} de ${seleccion.length}.`
        );
      }
    }

    const fallidos = resultados.length - ok;
    $('resultSummary').innerHTML =
      `<strong>${ok}</strong> punto(s) de venta enviados correctamente` +
      (fallidos ? `, <strong>${fallidos}</strong> con error. Hacé clic en el estado rojo para ver el detalle.` : '.');
    $('card-result').classList.remove('hidden');
    $('card-result').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    $('sendError').textContent = err.message;
    seleccion
      .filter((i) => !procesadosIndices.has(i))
      .forEach((i) => setEstado(i, 'pending', 'Pendiente'));
  } finally {
    btnSend.disabled = false;
    spinner.classList.add('hidden');
  }
});

function setEstado(i, tipo, texto, detalle) {
  const badge = $(`estado-${i}`);
  badge.className = `badge badge-${tipo}`;
  badge.textContent = texto;
  badge.style.cursor = detalle ? 'pointer' : 'default';
  badge.onclick = detalle
    ? () => {
        $('jsonTitle').textContent = `Respuesta de Finnegans — Punto de venta ${pedidos[i].numero}`;
        $('jsonBody').textContent =
          typeof detalle === 'string' ? detalle : JSON.stringify(detalle, null, 2);
        $('jsonModal').classList.remove('hidden');
      }
    : null;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
