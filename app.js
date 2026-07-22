(function() {
  "use strict";

  // ================================================================
  // 1. UTILIDADES BÁSICAS (sin cambios)
  // ================================================================

  function normalizeHeader(h) {
    return String(h || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ');
  }

  function parseCSV(text) {
    text = text.replace(/^\uFEFF/, '');
    const rows = [];
    let row = [],
      field = '',
      inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"';
            i++; } else inQuotes = false;
        } else field += c;
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field);
          field = ''; } else if (c === '\r') { /* ignore */ } else if (c === '\n') { row.push(field);
          rows.push(row);
          row = [];
          field = ''; } else field += c;
      }
    }
    if (field.length > 0 || row.length > 0) { row.push(field);
      rows.push(row); }
    while (rows.length && rows[rows.length - 1].every(f => f === '')) rows.pop();
    return rows;
  }

  function rowsToObjects(rows) {
    if (!rows.length) return { headers: [], data: [] };
    const headers = rows[0].map(h => String(h || '').trim());
    const data = rows.slice(1).map(r => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (r[i] !== undefined ? r[i] : ''); });
      return obj;
    });
    return { headers, data };
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
      reader.readAsText(file, 'UTF-8');
    });
  }

  function parseMoneyCL(raw) {
    if (raw === null || raw === undefined) return 0;
    let s = String(raw).trim();
    if (s === '') return 0;
    s = s.replace(/[^0-9,.\-]/g, '');
    if (s === '') return 0;
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > -1 && lastDot > -1) {
      if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (lastComma > -1) {
      const decimals = s.length - lastComma - 1;
      s = (decimals === 2) ? s.replace(',', '.') : s.replace(/,/g, '');
    } else if (lastDot > -1) {
      const decimals = s.length - lastDot - 1;
      if (decimals === 2) {
        const parts = s.split('.');
        const dec = parts.pop();
        s = parts.join('') + '.' + dec;
      } else {
        s = s.replace(/\./g, '');
      }
    }
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  function toInt(raw) {
    const n = parseInt(String(raw || '').replace(/[^0-9\-]/g, ''), 10);
    return isNaN(n) ? 0 : n;
  }

  function fmtCLP(n) { return '$' + Math.round(n || 0).toLocaleString('es-CL'); }

  function fmtInt(n) { return Math.round(n || 0).toLocaleString('es-CL'); }

  function escHtml(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function findColumn(headers, regexes) {
    for (const re of regexes) {
      const match = headers.find(h => re.test(normalizeHeader(h)));
      if (match) return match;
    }
    return null;
  }

  function bestFillColumn(headers, rows, regex) {
    const candidates = headers.filter(h => regex.test(normalizeHeader(h)));
    if (!candidates.length) return null;
    let best = null,
      bestScore = -1;
    for (const c of candidates) {
      const filled = rows.filter(r => String(r[c] || '').trim() !== '').length;
      const score = rows.length ? filled / rows.length : 0;
      if (score > bestScore) { bestScore = score;
        best = c; }
    }
    return { col: best, fillRate: bestScore };
  }

  // ================================================================
  // 2. DETECCIÓN DE ESQUEMAS
  // ================================================================

  function classifyFile(headers) {
    const norm = headers.map(normalizeHeader);
    const flotaHints = [/propietari/, /chassis/, /motor/, /permiso/, /revision tecnica/, /poliza/, /patente/, /tipo bus/];
    const recHints = [/fecha.*viaje/, /origen/, /destino/, /recaudacion/, /servicio/, /bus/];
    let flotaScore = 0,
      recScore = 0;
    norm.forEach(h => {
      flotaHints.forEach(re => { if (re.test(h)) flotaScore++; });
      recHints.forEach(re => { if (re.test(h)) recScore++; });
    });
    return { tipo: recScore > flotaScore ? 'recaudacion' : 'flota', flotaScore, recScore };
  }

  function detectFlotaSchema(headers, rows) {
    const patenteCand = bestFillColumn(headers, rows, /patente|placa/);
    const busnumCand = bestFillColumn(headers, rows, /^bus$|n.*de.*bus|nro.*bus/);
    let keyCol, keyType, keyFillRate = 0;
    if (patenteCand && patenteCand.fillRate >= 0.4) {
      keyCol = patenteCand.col;
      keyType = 'patente';
      keyFillRate = patenteCand.fillRate;
    } else if (busnumCand) {
      keyCol = busnumCand.col;
      keyType = 'busnum';
      keyFillRate = busnumCand.fillRate;
    } else {
      keyCol = headers[0];
      keyType = 'generic';
      keyFillRate = 1;
    }
    const ownerCand = bestFillColumn(headers, rows, /propietari|owner|empresarioste|dueno/);
    const ownerCol = ownerCand ? ownerCand.col : null;
    const nombrePropietario = findColumn(headers, [/^nombre propietario$/, /^propietario$/]);
    const empresarioste = findColumn(headers, [/empresarioste/]);
    const finalOwnerCol = nombrePropietario || empresarioste || ownerCol;
    return {
      keyCol,
      keyType,
      keyFillRate,
      ownerCol: finalOwnerCol,
      ownerFillRate: ownerCand ? ownerCand.fillRate : 0
    };
  }

  // ================================================================
  // DETECCIÓN DE RECAUDACIÓN - CORREGIDO: GETNET
  // ================================================================

  function detectRecaudacionSchema(headers) {
    const columnas = {};
    const normalizedHeaders = headers.map(h => normalizeHeader(h));

    function buscarColumna(patronesExactos, patronesParciales, regexes) {
      for (const patron of patronesExactos) {
        const idx = normalizedHeaders.findIndex(nh => nh === patron);
        if (idx !== -1) return headers[idx];
      }
      for (const patron of patronesParciales) {
        const idx = normalizedHeaders.findIndex(nh => nh.includes(patron));
        if (idx !== -1) return headers[idx];
      }
      for (const re of regexes) {
        const idx = normalizedHeaders.findIndex(nh => re.test(nh));
        if (idx !== -1) return headers[idx];
      }
      return null;
    }

    columnas.efectivoCamino = buscarColumna(
      ['efectivo del oficial de campo'],
      ['efectivo oficial campo'],
      [/efectivo.*oficial.*campo/]
    );

    columnas.getnetCamino = buscarColumna(
      ['getnet del oficial de campo'],
      ['getnet oficial campo', 'getnet'],
      [/getnet.*oficial.*campo/, /getnet/]
    );

    columnas.recCamino = buscarColumna(
      ['recaudacion en camino'],
      ['recaudacion camino'],
      [/recaudacion.*camino/]
    );

    columnas.asientosCamino = buscarColumna(
      ['asientos recaudacion en camino'],
      ['asientos recaudacion camino', 'asientos camino'],
      [/asientos.*camino/]
    );

    columnas.recSucursal = buscarColumna(
      ['recaudacion en sucursal'],
      ['recaudacion sucursal'],
      [/recaudacion.*sucursal/]
    );

    columnas.asientosSucursal = buscarColumna(
      ['asientos recaudacion en sucursal'],
      ['asientos recaudacion sucursal', 'asientos sucursal'],
      [/asientos.*sucursal/]
    );

    columnas.bus = buscarColumna(
      ['bus'],
      ['n° de bus', 'nro bus', 'numero bus'],
      [/^bus$/, /n.*de.*bus/, /nro.*bus/]
    );

    columnas.patente = buscarColumna(
      ['patente'],
      ['patente', 'placa'],
      [/patente/, /placa/]
    );

    columnas.servicio = buscarColumna(
      ['servicio'],
      ['servicio'],
      [/servicio/]
    );

    columnas.fecha = buscarColumna(
      ['fecha de viaje'],
      ['fecha viaje', 'fecha'],
      [/fecha.*viaje/]
    );

    columnas.origen = buscarColumna(
      ['origen'],
      ['origen'],
      [/origen/]
    );

    columnas.destino = buscarColumna(
      ['destino'],
      ['destino'],
      [/destino/]
    );

    return columnas;
  }

  function detectVentasSchema(headers) {
    return {
      servicioCol: findColumn(headers, [/servicio/]),
      fechaCol: findColumn(headers, [/fecha.*viaje/]),
      origenCol: findColumn(headers, [/origen/]),
      destinoCol: findColumn(headers, [/destino/]),
      descripcionCol: findColumn(headers, [/descripcion/]),
      tarifaCol: findColumn(headers, [/tarifa/]),
      montoNetoCol: findColumn(headers, [/monto neto/]),
      tipoCol: findColumn(headers, [/tipo/]),
      nombreSucursalCol: findColumn(headers, [/nombre de sucursal/])
    };
  }

  function normalizeKeyValue(raw, type) {
    let s = String(raw || '').trim();
    if (s === '') return null;
    if (type === 'patente') return s.toUpperCase().replace(/\s+/g, '');
    if (type === 'busnum') {
      if (!/^\d+$/.test(s)) return null;
      return String(parseInt(s, 10));
    }
    return s.toUpperCase();
  }

  function ticketKey(servicio, fecha) {
    const s = String(servicio || '').trim().toLowerCase();
    const f = String(fecha || '').trim().toLowerCase();
    if (!s || !f) return null;
    const datePart = f.split(' ')[0] || f;
    return s + '||' + datePart;
  }

  // ================================================================
  // 3. ESTADO GLOBAL
  // ================================================================

  const loaded = { A: null, B: null, C: null };
  let consolidated = [];
  let ownerSummary = [];
  let lastRunMeta = {};
  let ticketsByKey = null;
  let ventasSchema = null;
  let flotaSchema = null;
  let recaudacionSchema = null;

  const DETAIL_COLUMNS = [
    ['fecha', 'Fecha'],
    ['servicio', 'Servicio'],
    ['origen', 'Origen'],
    ['destino', 'Destino'],
    ['busRaw', 'Bus'],
    ['patenteRaw', 'Patente'],
    ['propietario', 'Propietario'],
    ['recSucursal', 'Rec. Sucursal'],
    ['asientosSucursal', 'Asientos Sucursal'],
    ['efectivoCamino', 'Efectivo Camino'],
    ['getnetCamino', 'Getnet Camino'],
    ['recCamino', 'Rec. Camino'],
    ['asientosCamino', 'Asientos Camino'],
    ['recTotal', 'Recaudación Total'],
    ['asientosTotal', 'Asientos Total']
  ];

  // ================================================================
  // 4. DROPZONES
  // ================================================================

  function attachDropzone(zoneId, inputId, statusId, slot) {
    const zone = document.getElementById(zoneId);
    const input = document.getElementById(inputId);
    const status = document.getElementById(statusId);

    function process(file) {
      if (!file) return;
      readFileAsText(file).then(text => {
        const rows = parseCSV(text);
        const { headers, data } = rowsToObjects(rows);
        loaded[slot] = { fileName: file.name, headers, data };
        status.textContent = '✓ ' + file.name + '  ·  ' + data.length.toLocaleString('es-CL') + ' filas';
        zone.classList.add('loaded');
        maybeEnableProcess();
      }).catch(err => {
        status.textContent = '✗ Error: ' + err.message;
      });
    }

    input.addEventListener('change', e => {
      if (e.target.files && e.target.files[0]) process(e.target.files[0]);
    });
    zone.addEventListener('dragover', e => { e.preventDefault();
      zone.classList.add('drag'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) process(e.dataTransfer.files[0]);
    });
  }

  function maybeEnableProcess() {
    const btn = document.getElementById('btnProcess');
    btn.disabled = !(loaded.A && loaded.B);
  }

  // ================================================================
  // 5. PROCESAMIENTO PRINCIPAL (CON MATCHING MEJORADO)
  // ================================================================

  function runProcess() {
    const msgEl = document.getElementById('processMsg');
    msgEl.textContent = '';
    const log = [];

    try {
      const clsA = classifyFile(loaded.A.headers);
      const clsB = classifyFile(loaded.B.headers);

      let flotaFile, recFile, swapped = false;
      if (clsA.tipo === 'flota' && clsB.tipo === 'recaudacion') { flotaFile = loaded.A;
        recFile = loaded.B; } else if (clsA.tipo === 'recaudacion' && clsB.tipo === 'flota') { flotaFile = loaded.B;
        recFile = loaded.A;
        swapped = true; } else { flotaFile = loaded.A;
        recFile = loaded.B; }

      if (swapped) log.push({ t: 'ok', m: 'Se detectaron los archivos en orden invertido — se reordenaron automáticamente.' });

      flotaSchema = detectFlotaSchema(flotaFile.headers, flotaFile.data);
      recaudacionSchema = detectRecaudacionSchema(recFile.headers);

      log.push({ t: 'ok', m: `Flota (${flotaFile.fileName}): clave de cruce = "${flotaSchema.keyCol}" (tipo: ${flotaSchema.keyType}), propietario = "${flotaSchema.ownerCol || 'NO DETECTADO'}"` });

      log.push({ t: 'ok', m: `Recaudación (${recFile.fileName}): columnas detectadas:` });
      log.push({ t: 'ok', m: `  - Efectivo Camino: "${recaudacionSchema.efectivoCamino || 'No encontrada'}"` });
      log.push({ t: 'ok', m: `  - Getnet Camino: "${recaudacionSchema.getnetCamino || 'No encontrada'}"` });
      log.push({ t: 'ok', m: `  - Rec. Camino: "${recaudacionSchema.recCamino || 'No encontrada'}"` });
      log.push({ t: 'ok', m: `  - Asientos Camino: "${recaudacionSchema.asientosCamino || 'No encontrada'}"` });
      log.push({ t: 'ok', m: `  - Rec. Sucursal: "${recaudacionSchema.recSucursal || 'No encontrada'}"` });
      log.push({ t: 'ok', m: `  - Asientos Sucursal: "${recaudacionSchema.asientosSucursal || 'No encontrada'}"` });
      log.push({ t: 'ok', m: `  - Bus: "${recaudacionSchema.bus || 'No encontrada'}"` });
      log.push({ t: 'ok', m: `  - Patente: "${recaudacionSchema.patente || 'No encontrada'}"` });

      if (!recaudacionSchema.getnetCamino) {
        log.push({ t: 'warn', m: '⚠️ No se encontró la columna "Getnet del oficial de campo". Verifica el nombre exacto en el archivo.' });
      }

      if (!flotaSchema.ownerCol) {
        log.push({ t: 'warn', m: 'No se encontró una columna de propietario clara en el archivo de flota. Todos los buses figurarán como "Sin propietario".' });
      }

      const busIndex = new Map();
      flotaFile.data.forEach(row => {
        const rawKey = row[flotaSchema.keyCol];
        const norm = normalizeKeyValue(rawKey, flotaSchema.keyType);
        if (norm === null) return;
        let owner = '';
        if (flotaSchema.ownerCol) {
          owner = String(row[flotaSchema.ownerCol] || '').trim();
          if (!owner) {
            const empresariosteCol = findColumn(flotaFile.headers, [/empresarioste/]);
            if (empresariosteCol) {
              owner = String(row[empresariosteCol] || '').trim();
            }
          }
        }
        owner = owner || 'Sin asignar';
        busIndex.set(norm, { owner, rawId: row[flotaSchema.keyCol] });
      });

      ticketsByKey = null;
      ventasSchema = null;
      let ticketTotal = 0;
      if (loaded.C) {
        ventasSchema = detectVentasSchema(loaded.C.headers);
        ticketsByKey = new Map();
        loaded.C.data.forEach(row => {
          const servicioVal = ventasSchema.servicioCol ? row[ventasSchema.servicioCol] : '';
          const fechaVal = ventasSchema.fechaCol ? row[ventasSchema.fechaCol] : '';
          const key = ticketKey(servicioVal, fechaVal);
          if (key === null) return;
          ticketTotal++;
          if (!ticketsByKey.has(key)) ticketsByKey.set(key, []);
          const tipo = ventasSchema.tipoCol ? row[ventasSchema.tipoCol] : '';
          const nombreSucursal = ventasSchema.nombreSucursalCol ? row[ventasSchema.nombreSucursalCol] : '';
          const montoNeto = ventasSchema.montoNetoCol ? parseMoneyCL(row[ventasSchema.montoNetoCol]) : 0;
          const esSucursal = tipo.trim().toLowerCase() !== 'tripulación' && nombreSucursal.trim().toLowerCase() !== 'tripulación';
          ticketsByKey.get(key).push({
            descripcion: ventasSchema.descripcionCol ? row[ventasSchema.descripcionCol] : '',
            tarifa: ventasSchema.tarifaCol ? parseMoneyCL(row[ventasSchema.tarifaCol]) : 0,
            montoNeto: montoNeto,
            esSucursal: esSucursal,
            tipo: tipo,
            nombreSucursal: nombreSucursal
          });
        });
        log.push({ t: 'ok', m: `Informe de ventas (${loaded.C.fileName}): ${ticketTotal.toLocaleString('es-CL')} boletos indexados en ${ticketsByKey.size.toLocaleString('es-CL')} servicios` });
      }

      let matched = 0,
        unmatched = 0,
        invalidKey = 0;
      consolidated = [];

      recFile.data.forEach(row => {
        const rawKey = row[recaudacionSchema.bus] || row[flotaSchema.keyCol];
        let norm = normalizeKeyValue(rawKey, flotaSchema.keyType);
        let info = null;
        let busFound = false;

        if (norm !== null) {
          info = busIndex.get(norm);
          if (info) busFound = true;
        }

        // Solo buscar en texto si el campo Bus es numérico
        if (!busFound && flotaSchema.keyType === 'busnum') {
          const cleanRaw = String(rawKey || '').replace(/[^0-9]/g, '');
          if (cleanRaw.length > 0 && /^\d+$/.test(cleanRaw)) {
            const rowText = Object.values(row).join(' ').toUpperCase();
            for (const [key, value] of busIndex) {
              const regex = new RegExp('\\b' + key + '\\b');
              if (regex.test(rowText)) {
                info = value;
                norm = key;
                busFound = true;
                break;
              }
            }
          }
        }

        if (!busFound && recaudacionSchema.patente) {
          const patenteRaw = row[recaudacionSchema.patente];
          if (patenteRaw) {
            const patenteNorm = normalizeKeyValue(patenteRaw, 'patente');
            if (patenteNorm) {
              info = busIndex.get(patenteNorm);
              if (info) {
                norm = patenteNorm;
                busFound = true;
              }
            }
          }
        }

        if (norm === null) invalidKey++;
        else if (!info) unmatched++;
        else matched++;

        const propietario = info ? info.owner : (norm === null ? 'Sin dato de bus' : 'Sin asignar');

        const recSucursal = recaudacionSchema.recSucursal ? parseMoneyCL(row[recaudacionSchema.recSucursal]) : 0;
        const asientosSuc = recaudacionSchema.asientosSucursal ? toInt(row[recaudacionSchema.asientosSucursal]) : 0;
        const recCamino = recaudacionSchema.recCamino ? parseMoneyCL(row[recaudacionSchema.recCamino]) : 0;
        const asientosCamino = recaudacionSchema.asientosCamino ? toInt(row[recaudacionSchema.asientosCamino]) : 0;
        const efectivoCamino = recaudacionSchema.efectivoCamino ? parseMoneyCL(row[recaudacionSchema.efectivoCamino]) : 0;
        const getnetCamino = recaudacionSchema.getnetCamino ? parseMoneyCL(row[recaudacionSchema.getnetCamino]) : 0;

        const servicioVal = recaudacionSchema.servicio ? row[recaudacionSchema.servicio] : '';
        const fechaVal = recaudacionSchema.fecha ? row[recaudacionSchema.fecha] : '';
        const ticketKeyVal = ticketKey(servicioVal, fechaVal);
        const tickets = (ticketsByKey && ticketKeyVal !== null) ? (ticketsByKey.get(ticketKeyVal) || []) : [];

        let recSucursalFromTickets = 0;
        let asientosSucursalFromTickets = 0;
        if (tickets.length > 0) {
          tickets.forEach(t => {
            if (t.esSucursal) {
              recSucursalFromTickets += t.montoNeto;
              asientosSucursalFromTickets++;
            }
          });
        }

        const finalRecSucursal = recSucursalFromTickets > 0 ? recSucursalFromTickets : recSucursal;
        const finalAsientosSuc = asientosSucursalFromTickets > 0 ? asientosSucursalFromTickets : asientosSuc;

        consolidated.push({
          fecha: fechaVal,
          servicio: servicioVal,
          origen: recaudacionSchema.origen ? row[recaudacionSchema.origen] : '',
          destino: recaudacionSchema.destino ? row[recaudacionSchema.destino] : '',
          busRaw: row[recaudacionSchema.bus] || '',
          patenteRaw: row[recaudacionSchema.patente] || '',
          propietario: propietario,
          recSucursal: finalRecSucursal,
          asientosSucursal: finalAsientosSuc,
          efectivoCamino: efectivoCamino,
          getnetCamino: getnetCamino,
          recCamino: recCamino,
          asientosCamino: asientosCamino,
          recTotal: finalRecSucursal + recCamino,
          asientosTotal: finalAsientosSuc + asientosCamino,
          tickets,
          ticketKeyVal
        });
      });

      if (ticketsByKey) {
        const usedKeys = new Set(consolidated.map(r => r.ticketKeyVal).filter(k => k !== null));
        const unmatchedTickets = Array.from(ticketsByKey.keys()).filter(k => !usedKeys.has(k)).reduce((s, k) => s + ticketsByKey.get(k).length, 0);
        log.push({ t: unmatchedTickets ? 'warn' : 'ok', m: `Boletos sin servicio correspondiente en Recaudación: ${unmatchedTickets.toLocaleString('es-CL')}` });
      }

      log.push({ t: unmatched ? 'warn' : 'ok', m: `Servicios cruzados con éxito: ${matched}  ·  sin propietario identificado: ${unmatched}  ·  sin bus válido en la fila: ${invalidKey}` });

      const ownerMap = new Map();
      consolidated.forEach(row => {
        const key = row.propietario;
        if (!ownerMap.has(key)) {
          ownerMap.set(key, {
            propietario: key,
            buses: new Set(),
            servicios: 0,
            recSucursal: 0,
            asientosSucursal: 0,
            efectivoCamino: 0,
            getnetCamino: 0,
            recCamino: 0,
            asientosCamino: 0,
            recTotal: 0,
            asientosTotal: 0
          });
        }
        const o = ownerMap.get(key);
        if (row.busRaw) o.buses.add(String(row.busRaw).trim());
        o.servicios++;
        o.recSucursal += row.recSucursal;
        o.asientosSucursal += row.asientosSucursal;
        o.efectivoCamino += row.efectivoCamino;
        o.getnetCamino += row.getnetCamino;
        o.recCamino += row.recCamino;
        o.asientosCamino += row.asientosCamino;
        o.recTotal += row.recTotal;
        o.asientosTotal += row.asientosTotal;
      });

      ownerSummary = Array.from(ownerMap.values()).map(o => ({
        ...o,
        nBuses: o.buses.size,
        ticketProm: o.servicios ? o.recTotal / o.servicios : 0
      })).sort((a, b) => b.recTotal - a.recTotal);

      lastRunMeta = {
        totalRec: consolidated.reduce((s, r) => s + r.recTotal, 0),
        totalServicios: consolidated.length,
        nPropietarios: ownerSummary.filter(o => o.propietario !== 'Sin asignar' && o.propietario !== 'Sin dato de bus').length,
        sinAsignar: unmatched + invalidKey,
        flotaSchema,
        recaudacionSchema,
        flotaFile,
        recFile,
        ticketsLoaded: !!ticketsByKey,
        ticketsTotal: ticketTotal
      };

      renderResults(log);

    } catch (err) {
      msgEl.textContent = 'Error al procesar: ' + err.message;
      console.error(err);
    }
  }

  // ================================================================
  // 6. RENDERIZADO DE RESULTADOS
  // ================================================================

  function renderResults(log) {
    document.getElementById('resultsSection').hidden = false;

    document.getElementById('mappingNote').textContent =
      `Cruce realizado por ${lastRunMeta.flotaSchema.keyType === 'patente' ? 'patente' : 'número de bus'}. ` +
      `Flota: "${lastRunMeta.flotaSchema.keyCol}" → Recaudación: "${lastRunMeta.recaudacionSchema.bus || '?'}". ` +
      `Recaudación Camino = columna "Recaudación en camino" (ya sumada). ` +
      `Efectivo Camino = "${lastRunMeta.recaudacionSchema.efectivoCamino || '?'}", ` +
      `Getnet Camino = "${lastRunMeta.recaudacionSchema.getnetCamino || '?'}"`;

    const statGrid = document.getElementById('statGrid');
    statGrid.innerHTML = `
      <div class="stat-card">
        <div class="label">Recaudación total</div>
        <div class="value">${fmtCLP(lastRunMeta.totalRec)}</div>
      </div>
      <div class="stat-card">
        <div class="label">Servicios procesados</div>
        <div class="value">${fmtInt(lastRunMeta.totalServicios)}</div>
      </div>
      <div class="stat-card">
        <div class="label">Propietarios identificados</div>
        <div class="value">${fmtInt(lastRunMeta.nPropietarios)}</div>
      </div>
      <div class="stat-card ${lastRunMeta.sinAsignar ? 'warn' : ''}">
        <div class="label">Servicios sin propietario</div>
        <div class="value">${fmtInt(lastRunMeta.sinAsignar)}</div>
      </div>
      ${lastRunMeta.ticketsLoaded ? `
      <div class="stat-card">
        <div class="label">Boletos indexados</div>
        <div class="value">${fmtInt(lastRunMeta.ticketsTotal)}</div>
      </div>` : ''}
    `;

    const logBox = document.getElementById('logBox');
    logBox.innerHTML = log.map(l => `<div class="l-${l.t}">${l.t === 'warn' ? '⚠️' : '✅'} ${escHtml(l.m)}</div>`).join('');

    const tbody = document.getElementById('ownerTableBody');
    tbody.innerHTML = ownerSummary.map((o, idx) => {
      const flagged = ['Sin asignar', 'Sin dato de bus'].includes(o.propietario);
      return `<tr>
        <td class="owner-cell">${escHtml(o.propietario)} ${flagged ? '<span class="pill pill-warn">revisar</span>' : ''}</td>
        <td class="num">${fmtInt(o.nBuses)}</td>
        <td class="num">${fmtInt(o.servicios)}</td>
        <td class="num">${fmtCLP(o.recSucursal)}</td>
        <td class="num">${fmtInt(o.asientosSucursal)}</td>
        <td class="num">${fmtCLP(o.efectivoCamino)}</td>
        <td class="num">${fmtCLP(o.getnetCamino)}</td>
        <td class="num">${fmtCLP(o.recCamino)}</td>
        <td class="num">${fmtInt(o.asientosCamino)}</td>
        <td class="num">${fmtCLP(o.recTotal)}</td>
        <td class="num">${fmtInt(o.asientosTotal)}</td>
        <td class="num">${fmtCLP(o.ticketProm)}</td>
        <td><button class="btn btn-ghost btn-small" data-owner-idx="${idx}">Descargar</button></td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-owner-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        const o = ownerSummary[parseInt(btn.getAttribute('data-owner-idx'), 10)];
        exportOwnerExcel(o.propietario);
      });
    });

    const headRow = document.getElementById('detailHeadRow');
    headRow.innerHTML = DETAIL_COLUMNS.map(([k, label]) =>
      `<th${(/rec|total|asientos|efectivo|getnet/.test(k) ? ' class="num"' : '')}>${label}</th>`
    ).join('') + (lastRunMeta.ticketsLoaded ? '<th class="num">Boletos</th>' : '');

    document.getElementById('detailDesc').textContent = lastRunMeta.ticketsLoaded ?
      'Cada fila es un servicio, con el propietario ya agregado. Haz clic en una fila para ver el detalle de boletos vendidos. Se muestran las primeras 300 filas; el Excel consolidado incluye la totalidad.' :
      'Cada fila es un servicio, con el propietario ya agregado. Se muestran las primeras 300 filas; el Excel consolidado incluye la totalidad.';

    const detailBody = document.getElementById('detailTableBody');
    const preview = consolidated.slice(0, 300);
    const colCount = DETAIL_COLUMNS.length + (lastRunMeta.ticketsLoaded ? 1 : 0);

    detailBody.innerHTML = preview.map((row, idx) => {
      const cells = DETAIL_COLUMNS.map(([k]) => {
        let val = row[k];
        let cls = '';
        if (['recSucursal', 'efectivoCamino', 'getnetCamino', 'recCamino', 'recTotal'].includes(k)) {
          val = fmtCLP(val);
          cls = ' class="num mono"';
        } else if (['asientosSucursal', 'asientosCamino', 'asientosTotal'].includes(k)) {
          val = fmtInt(val);
          cls = ' class="num mono"';
        } else if (k === 'propietario') {
          cls = ' class="owner-cell"';
        }
        return `<td${cls}>${escHtml(val)}</td>`;
      }).join('');

      const ticketCell = lastRunMeta.ticketsLoaded ?
        `<td class="num"><span class="ticket-badge">${row.tickets.length} <span class="chev">▶</span></span></td>` :
        '';

      const mainRow = `<tr${lastRunMeta.ticketsLoaded ? ' class="row-clickable" data-ridx="' + idx + '"' : ''}>${cells}${ticketCell}</tr>`;

      if (!lastRunMeta.ticketsLoaded) return mainRow;

      const subRow = `<tr class="ticket-subrow" data-sub-for="${idx}" style="display:none;"><td colspan="${colCount}">${renderTicketMiniTable(row.tickets)}</td></tr>`;
      return mainRow + subRow;
    }).join('');

    if (lastRunMeta.ticketsLoaded) {
      detailBody.querySelectorAll('tr.row-clickable').forEach(tr => {
        tr.addEventListener('click', () => {
          const idx = tr.getAttribute('data-ridx');
          const sub = detailBody.querySelector(`tr.ticket-subrow[data-sub-for="${idx}"]`);
          const isOpen = sub.style.display !== 'none';
          sub.style.display = isOpen ? 'none' : 'table-row';
          tr.classList.toggle('row-expanded', !isOpen);
        });
      });
    }

    document.getElementById('detailCount').textContent = `(${consolidated.length.toLocaleString('es-CL')} filas totales)`;
  }

  function renderTicketMiniTable(tickets) {
    if (!tickets || !tickets.length) {
      return '<div class="ticket-empty-note">Sin boletos encontrados para este servicio en el informe de ventas.</div>';
    }
    const rows = tickets.map(t => `
      <tr>
        <td>${escHtml(t.descripcion)}</td>
        <td>${t.esSucursal ? 'Sucursal' : 'Tripulación'}</td>
        <td>${escHtml(t.tipo)}</td>
        <td class="num">${fmtCLP(t.montoNeto)}</td>
      </tr>
    `).join('');
    return `<table class="ticket-mini-table">
      <thead><tr><th>Descripción</th><th>Origen</th><th>Tipo</th><th class="num">Monto</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // ================================================================
  // 7. EXPORTACIÓN A EXCEL
  // ================================================================

  function detailToSheetData(rows) {
    return rows.map(row => {
      const obj = {};
      DETAIL_COLUMNS.forEach(([k, label]) => { obj[label] = row[k]; });
      return obj;
    });
  }

  function autoWidth(sheetData) {
    if (!sheetData.length) return [];
    const keys = Object.keys(sheetData[0]);
    return keys.map(k => {
      let max = k.length;
      sheetData.forEach(r => { const v = r[k] === undefined || r[k] === null ? '' : String(r[k]); if (v.length > max) max = v.length; });
      return { wch: Math.min(Math.max(max + 2, 10), 42) };
    });
  }

  function sanitizeSheetName(name, used) {
    let clean = String(name || 'Propietario').replace(/[\\\/\?\*\[\]:]/g, '-').trim();
    if (!clean) clean = 'Propietario';
    clean = clean.substring(0, 31);
    let finalName = clean,
      i = 1;
    while (used.has(finalName)) {
      const suffix = ' (' + (++i) + ')';
      finalName = clean.substring(0, 31 - suffix.length) + suffix;
    }
    used.add(finalName);
    return finalName;
  }

  function todayStamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
  }

  function exportConsolidadoExcel() {
    if (!consolidated.length) return;
    const wb = XLSX.utils.book_new();
    const sheetData = detailToSheetData(consolidated);
    const ws = XLSX.utils.json_to_sheet(sheetData);
    ws['!cols'] = autoWidth(sheetData);
    XLSX.utils.book_append_sheet(wb, ws, 'Consolidado');

    if (lastRunMeta.ticketsLoaded) {
      const ticketData = [];
      consolidated.forEach(row => {
        row.tickets.forEach(t => {
          ticketData.push({
            'Servicio': row.servicio,
            'Fecha': row.fecha,
            'Propietario': row.propietario,
            'Bus': row.busRaw,
            'Descripción': t.descripcion,
            'Origen': t.esSucursal ? 'Sucursal' : 'Tripulación',
            'Tipo': t.tipo,
            'Monto': Math.round(t.montoNeto)
          });
        });
      });
      if (ticketData.length) {
        const wsT = XLSX.utils.json_to_sheet(ticketData);
        wsT['!cols'] = autoWidth(ticketData);
        XLSX.utils.book_append_sheet(wb, wsT, 'Boletos');
      }
    }
    XLSX.writeFile(wb, `Recaudacion_Consolidado_${todayStamp()}.xlsx`);
  }

  function exportAllOwnersExcel() {
    if (!ownerSummary.length) return;
    const wb = XLSX.utils.book_new();
    const used = new Set(['Consolidado']);

    const resumenData = ownerSummary.map(o => ({
      'Propietario': o.propietario,
      'N° Buses': o.nBuses,
      'Servicios': o.servicios,
      'Recaudación Sucursal': Math.round(o.recSucursal),
      'Asientos Sucursal': o.asientosSucursal,
      'Efectivo Camino': Math.round(o.efectivoCamino),
      'Getnet Camino': Math.round(o.getnetCamino),
      'Recaudación Camino': Math.round(o.recCamino),
      'Asientos Camino': o.asientosCamino,
      'Recaudación Total': Math.round(o.recTotal),
      'Asientos Total': o.asientosTotal,
      'Ticket Promedio': Math.round(o.ticketProm)
    }));
    const wsResumen = XLSX.utils.json_to_sheet(resumenData);
    wsResumen['!cols'] = autoWidth(resumenData);
    XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen');

    ownerSummary.forEach(o => {
      const rows = consolidated.filter(r => r.propietario === o.propietario);
      const sheetData = detailToSheetData(rows);
      const ws = XLSX.utils.json_to_sheet(sheetData);
      ws['!cols'] = autoWidth(sheetData);
      const name = sanitizeSheetName(o.propietario, used);
      XLSX.utils.book_append_sheet(wb, ws, name);

      if (lastRunMeta.ticketsLoaded) {
        const ticketData = [];
        rows.forEach(row => {
          row.tickets.forEach(t => {
            ticketData.push({
              'Servicio': row.servicio,
              'Fecha': row.fecha,
              'Propietario': row.propietario,
              'Bus': row.busRaw,
              'Descripción': t.descripcion,
              'Origen': t.esSucursal ? 'Sucursal' : 'Tripulación',
              'Tipo': t.tipo,
              'Monto': Math.round(t.montoNeto)
            });
          });
        });
        if (ticketData.length) {
          const wsT = XLSX.utils.json_to_sheet(ticketData);
          wsT['!cols'] = autoWidth(ticketData);
          XLSX.utils.book_append_sheet(wb, wsT, sanitizeSheetName('Boletos', used));
        }
      }
    });

    XLSX.writeFile(wb, `Recaudacion_Por_Propietario_${todayStamp()}.xlsx`);
  }

  function exportOwnerExcel(ownerName) {
    const rows = consolidated.filter(r => r.propietario === ownerName);
    if (!rows.length) return;
    const wb = XLSX.utils.book_new();
    const sheetData = detailToSheetData(rows);
    const ws = XLSX.utils.json_to_sheet(sheetData);
    ws['!cols'] = autoWidth(sheetData);
    const slug = String(ownerName).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    XLSX.utils.book_append_sheet(wb, ws, 'Detalle');

    if (lastRunMeta.ticketsLoaded) {
      const ticketData = [];
      rows.forEach(row => {
        row.tickets.forEach(t => {
          ticketData.push({
            'Servicio': row.servicio,
            'Fecha': row.fecha,
            'Bus': row.busRaw,
            'Descripción': t.descripcion,
            'Origen': t.esSucursal ? 'Sucursal' : 'Tripulación',
            'Tipo': t.tipo,
            'Monto': Math.round(t.montoNeto)
          });
        });
      });
      if (ticketData.length) {
        const wsT = XLSX.utils.json_to_sheet(ticketData);
        wsT['!cols'] = autoWidth(ticketData);
        XLSX.utils.book_append_sheet(wb, wsT, 'Boletos');
      }
    }

    XLSX.writeFile(wb, `Recaudacion_${slug}_${todayStamp()}.xlsx`);
  }

  // ================================================================
  // 8. NUEVA FUNCIÓN: DESCARGAR ZIP CON INDIVIDUALES
  // ================================================================

  function exportAllOwnersZip() {
    if (!ownerSummary.length) {
      alert('No hay datos para exportar. Primero procesa los archivos.');
      return;
    }
    if (typeof JSZip === 'undefined') {
      alert('La librería JSZip no está cargada. Verifica tu conexión a Internet.');
      return;
    }

    const zip = new JSZip();
    const usedNames = new Set();

    ownerSummary.forEach(o => {
      const rows = consolidated.filter(r => r.propietario === o.propietario);
      if (!rows.length) return;

      const sheetData = detailToSheetData(rows);
      const ws = XLSX.utils.json_to_sheet(sheetData);
      ws['!cols'] = autoWidth(sheetData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Detalle');

      if (lastRunMeta.ticketsLoaded) {
        const ticketData = [];
        rows.forEach(row => {
          row.tickets.forEach(t => {
            ticketData.push({
              'Servicio': row.servicio,
              'Fecha': row.fecha,
              'Bus': row.busRaw,
              'Descripción': t.descripcion,
              'Origen': t.esSucursal ? 'Sucursal' : 'Tripulación',
              'Tipo': t.tipo,
              'Monto': Math.round(t.montoNeto)
            });
          });
        });
        if (ticketData.length) {
          const wsT = XLSX.utils.json_to_sheet(ticketData);
          wsT['!cols'] = autoWidth(ticketData);
          XLSX.utils.book_append_sheet(wb, wsT, 'Boletos');
        }
      }

      const fileName = sanitizeSheetName(o.propietario, usedNames) + '.xlsx';
      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      zip.file(fileName, wbout);
    });

    zip.generateAsync({ type: 'blob' }).then(function(content) {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(content);
      link.download = `Recaudacion_Individuales_${todayStamp()}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    }).catch(function(err) {
      alert('Error al generar el ZIP: ' + err.message);
    });
  }

  // ================================================================
  // 9. INICIALIZACIÓN
  // ================================================================

  document.addEventListener('DOMContentLoaded', () => {
    attachDropzone('dzA', 'fileA', 'dzA-status', 'A');
    attachDropzone('dzB', 'fileB', 'dzB-status', 'B');
    attachDropzone('dzC', 'fileC', 'dzC-status', 'C');

    document.getElementById('btnProcess').addEventListener('click', runProcess);
    document.getElementById('btnExportAll').addEventListener('click', exportAllOwnersExcel);
    document.getElementById('btnExportConsolidado').addEventListener('click', exportConsolidadoExcel);
    document.getElementById('btnExportZip').addEventListener('click', exportAllOwnersZip);
  });

})();