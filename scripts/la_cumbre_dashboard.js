// ============================================================================
// DASHBOARD — CRECIMIENTO DE LA MANCHA URBANA DE LA CUMBRE (Punilla, Córdoba)
// Script para Google Earth Engine — Code Editor (JavaScript) / Earth Engine App
// ============================================================================
//
// Versión "dashboard" de la_cumbre_crecimiento_urbano.js: mismo método (WSF
// Evolution 1990-2010 + Dynamic World 2020/Hoy, calibrados en 2015), pero
// en vez de imprimir en la consola arma una interfaz con:
//   - mapa de fases de crecimiento urbano (un color por período), con
//     selector "mostrar hasta" para ver cómo avanza la mancha corte a corte
//     y clic sobre el mapa para consultar la fase de un punto;
//   - panel lateral con indicadores (superficie 1990, superficie hoy,
//     crecimiento total, factor de calibración), gráfico de superficie
//     cruda vs. calibrada, gráfico de ritmo de urbanización (ha/año) por
//     período y tabla resumen;
//   - links de descarga (CSV de la tabla y GeoTIFF de las fases).
//
// Se puede publicar como Earth Engine App (Apps → New App) para compartirlo
// sin que haga falta abrir el Code Editor. OJO: el asset del área de estudio
// tiene que ser legible por la App (compartilo como público o con el
// proyecto de la App).
//
// El cálculo (Bloques 1 a 5) es una copia del script de análisis: si se
// cambia el método allá (umbral de Dynamic World, ventanas de fechas, etc.)
// hay que replicarlo acá.
// ============================================================================


// ----------------------------------------------------------------------------
// BLOQUE 1 — ÁREA DE ESTUDIO
// ----------------------------------------------------------------------------

var radioUrbanoLC = ee.FeatureCollection('projects/ee-nicolasalejandromari/assets/radio_urbano_LC');
var aoi = radioUrbanoLC.geometry();


// ----------------------------------------------------------------------------
// BLOQUE 2 — WORLD SETTLEMENT FOOTPRINT EVOLUTION (1990 / 2000 / 2010 / 2015)
// ----------------------------------------------------------------------------
// Banda única = año (1985-2015) de primera detección como asentamiento;
// 0 = nunca. Ver el script de análisis para el detalle.

var wsfEvo = ee.ImageCollection('projects/sat-io/open-datasets/WSF/WSF_EVO')
  .filterBounds(aoi)
  .mosaic()
  .select(0)
  .rename('wsf_year');

function wsfBuiltByYear(year) {
  return wsfEvo.gt(0).and(wsfEvo.lte(year)).unmask(0).rename('built');
}


// ----------------------------------------------------------------------------
// BLOQUE 3 — DYNAMIC WORLD (2015 para calibración, 2020 y Hoy)
// ----------------------------------------------------------------------------

var DW_BUILT_THRESHOLD = 0.25; // mismo umbral permisivo que el script de análisis

function getDynamicWorldBuiltBool(start, end) {
  return ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
    .filterBounds(aoi)
    .filterDate(start, end)
    .select('built')
    .mean()
    .gt(DW_BUILT_THRESHOLD)
    .unmask(0)
    .rename('built');
}

function getSentinel2RgbComposite(start, end) {
  var s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(aoi)
    .filterDate(start, end)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30));
  var csPlus = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');
  return s2
    .linkCollection(csPlus, ['cs_cdf'])
    .map(function(img) {
      // cs_cdf >= 0.60 = píxel "claro" (sin nube/sombra) según Cloud Score+.
      return img.updateMask(img.select('cs_cdf').gte(0.60));
    })
    .median();
}


// ----------------------------------------------------------------------------
// BLOQUE 4 — SUPERFICIE (ha) POR CORTE + CALIBRACIÓN EN 2015
// ----------------------------------------------------------------------------

function computeAreaHa(boolImg, scaleM) {
  var areaStats = boolImg.multiply(ee.Image.pixelArea()).reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: aoi,
    scale: scaleM,
    maxPixels: 1e9,
    tileScale: 4
  });
  return ee.Number(areaStats.get('built')).divide(10000);
}

// --- Calibración (año de solape 2015) ---
var DW_2015_START = '2015-07-01';
var DW_2015_END = '2016-06-30';
var wsf2015AreaHa = computeAreaHa(wsfBuiltByYear(2015), 30);
var dw2015AreaHa = computeAreaHa(getDynamicWorldBuiltBool(DW_2015_START, DW_2015_END), 10);
var dw2015ImageCount = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
  .filterBounds(aoi)
  .filterDate(DW_2015_START, DW_2015_END)
  .size();
var calibrationFactor = wsf2015AreaHa.divide(dw2015AreaHa);

// --- Ventana "Hoy" (últimos 12 meses), armada del lado del cliente ---
var nowJs = new Date();
var startJs = new Date(nowJs.getTime());
startJs.setMonth(startJs.getMonth() - 12);
function formatYearMonth(d) {
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
}
var currentStart = ee.Date(startJs.getTime());
var currentEnd = ee.Date(nowJs.getTime());

// --- Cortes temporales ---
// year: año (decimal para "Hoy") que se usa para calcular ha/año entre
// cortes. phase: número de fase en el mapa (Bloque 5).
var epochs = [
  {label: '1990', source: 'WSF Evolution', year: 1990, phase: 1,
   bool: wsfBuiltByYear(1990), scale: 30, calibrate: false},
  {label: '2000', source: 'WSF Evolution', year: 2000, phase: 2,
   bool: wsfBuiltByYear(2000), scale: 30, calibrate: false},
  {label: '2010', source: 'WSF Evolution', year: 2010, phase: 3,
   bool: wsfBuiltByYear(2010), scale: 30, calibrate: false},
  {label: '2020', source: 'Dynamic World', year: 2020.5, phase: 4,
   bool: getDynamicWorldBuiltBool('2020-01-01', '2021-01-01'), scale: 10, calibrate: true},
  {label: 'Hoy (' + formatYearMonth(nowJs) + ')', source: 'Dynamic World',
   year: nowJs.getFullYear() + nowJs.getMonth() / 12 - 0.5, phase: 5,
   bool: getDynamicWorldBuiltBool(currentStart, currentEnd), scale: 10, calibrate: true}
];

var epochStats = ee.List(epochs.map(function(e) {
  var raw = computeAreaHa(e.bool, e.scale);
  var calibrated = e.calibrate ? raw.multiply(calibrationFactor) : raw;
  return ee.Dictionary({raw: raw, calibrated: calibrated});
}));


// ----------------------------------------------------------------------------
// BLOQUE 5 — FASES DE CRECIMIENTO URBANO
// ----------------------------------------------------------------------------
// Unión acumulada de los cortes (.max() = OR) → cada píxel queda con la fase
// (1 a 5) en que aparece urbanizado por primera vez. Detección cruda de cada
// fuente (la calibración es sobre el área total, no por píxel). La fase 4
// incluye también construcciones anteriores que WSF (30 m) no vio y Dynamic
// World (10 m) sí.

var cumulative = [];
epochs.forEach(function(e, i) {
  cumulative.push(i === 0 ? e.bool : cumulative[i - 1].max(e.bool));
});

var growthPhases = ee.Image(0);
for (var i = cumulative.length - 1; i >= 0; i--) {
  growthPhases = growthPhases.where(cumulative[i], epochs[i].phase);
}
growthPhases = growthPhases.rename('fase').selfMask();

var phasePalette = ['#2166ac', '#67a9cf', '#fee08b', '#fdae61', '#d73027'];
var phaseLabels = [
  'Hasta 1990 (WSF Evolution)',
  '1990 – 2000 (WSF Evolution)',
  '2000 – 2010 (WSF Evolution)',
  '2010 – 2020 (Dynamic World)',
  '2020 – Hoy (Dynamic World)'
];


// ----------------------------------------------------------------------------
// BLOQUE 6 — INTERFAZ: MAPA
// ----------------------------------------------------------------------------

var map = ui.Map();
map.setOptions('HYBRID');
map.centerObject(aoi, 13);
map.style().set('cursor', 'crosshair');

var aoiOutline = ee.Image().byte().paint({featureCollection: radioUrbanoLC, color: 1, width: 2});

// Índices fijos de las capas, para poder reemplazar la de fases desde el
// selector sin reordenar las demás.
var LAYER_S2 = 0;
var LAYER_PHASES = 1;
var LAYER_AOI = 2;

map.layers().set(LAYER_S2, ui.Map.Layer(
  getSentinel2RgbComposite(currentStart, currentEnd),
  {bands: ['B4', 'B3', 'B2'], min: 0, max: 3000},
  'Sentinel-2 RGB (últimos 12 meses)', false
));

function phasesLayerUpTo(maxPhase) {
  return ui.Map.Layer(
    growthPhases.updateMask(growthPhases.lte(maxPhase)),
    {min: 1, max: 5, palette: phasePalette},
    'Fases de crecimiento urbano', true, 0.85
  );
}
map.layers().set(LAYER_PHASES, phasesLayerUpTo(5));
map.layers().set(LAYER_AOI, ui.Map.Layer(aoiOutline, {palette: ['ffffff']}, 'Radio urbano (AOI)'));

// --- Consulta por clic: fase del punto ---
var inspectLabel = ui.Label('Hacé clic en el mapa para ver en qué período se urbanizó ese punto.', {
  fontSize: '12px', color: '#555', whiteSpace: 'pre-wrap'
});

map.onClick(function(coords) {
  inspectLabel.setValue('Consultando…');
  var point = ee.Geometry.Point([coords.lon, coords.lat]);
  growthPhases.reduceRegion({
    reducer: ee.Reducer.first(),
    geometry: point,
    scale: 10
  }).evaluate(function(result, err) {
    if (err) {
      inspectLabel.setValue('Error en la consulta: ' + err);
      return;
    }
    var phase = result && result.fase;
    var where = coords.lat.toFixed(5) + ', ' + coords.lon.toFixed(5);
    inspectLabel.setValue(phase ?
      where + '\nUrbanizado en: ' + phaseLabels[phase - 1] :
      where + '\nSin urbanizar según las fuentes usadas.');
  });
});


// ----------------------------------------------------------------------------
// BLOQUE 7 — INTERFAZ: PANEL LATERAL
// ----------------------------------------------------------------------------

var COLOR_TEXT_MUTED = '#5f6368';
var sectionTitleStyle = {fontWeight: 'bold', fontSize: '14px', margin: '16px 8px 4px 8px'};

var panel = ui.Panel({style: {width: '400px', padding: '8px'}});

panel.add(ui.Label('Crecimiento de la mancha urbana — La Cumbre', {
  fontWeight: 'bold', fontSize: '18px', margin: '8px 8px 2px 8px'
}));
panel.add(ui.Label(
  'Punilla, Córdoba · 1990 a hoy · Insumo técnico POAT-LC. ' +
  'WSF Evolution (30 m) para 1990-2010 y Dynamic World (10 m) para 2020-hoy, ' +
  'calibrados entre sí en 2015.',
  {fontSize: '12px', color: COLOR_TEXT_MUTED, margin: '0 8px 8px 8px'}
));

// --- Indicadores ---
function makeKpi(title) {
  var value = ui.Label('…', {fontSize: '20px', fontWeight: 'bold', margin: '0'});
  var caption = ui.Label('', {fontSize: '11px', color: COLOR_TEXT_MUTED, margin: '2px 0 0 0'});
  var card = ui.Panel([
    ui.Label(title, {fontSize: '11px', color: COLOR_TEXT_MUTED, margin: '0 0 2px 0'}),
    value,
    caption
  ], null, {width: '170px', padding: '8px', margin: '4px', border: '1px solid #dadce0'});
  return {card: card, value: value, caption: caption};
}

var kpiArea1990 = makeKpi('Superficie urbanizada 1990');
var kpiAreaNow = makeKpi('Superficie urbanizada hoy');
var kpiGrowth = makeKpi('Crecimiento 1990 → hoy');
var kpiFactor = makeKpi('Factor de calibración (2015)');

panel.add(ui.Panel([kpiArea1990.card, kpiAreaNow.card], ui.Panel.Layout.Flow('horizontal')));
panel.add(ui.Panel([kpiGrowth.card, kpiFactor.card], ui.Panel.Layout.Flow('horizontal')));

// --- Mapa: mostrar hasta ---
panel.add(ui.Label('Mapa', sectionTitleStyle));
panel.add(ui.Select({
  items: phaseLabels.map(function(label, idx) {
    return {label: 'Mostrar hasta: ' + label.replace(/ \(.*\)$/, ''), value: idx + 1};
  }),
  value: 5,
  style: {stretch: 'horizontal', margin: '4px 8px'},
  onChange: function(value) {
    map.layers().set(LAYER_PHASES, phasesLayerUpTo(value));
  }
}));

phaseLabels.forEach(function(label, idx) {
  panel.add(ui.Panel([
    ui.Label('', {backgroundColor: phasePalette[idx], padding: '7px', margin: '2px 0 2px 8px'}),
    ui.Label(label, {fontSize: '12px', margin: '2px 0 2px 6px'})
  ], ui.Panel.Layout.Flow('horizontal')));
});
panel.add(inspectLabel);

// --- Contenedores que se llenan cuando llegan los datos ---
panel.add(ui.Label('Superficie urbanizada por corte', sectionTitleStyle));
var chartAreaPanel = ui.Panel([ui.Label('Calculando…', {color: COLOR_TEXT_MUTED})]);
panel.add(chartAreaPanel);

panel.add(ui.Label('Ritmo de urbanización por período', sectionTitleStyle));
var chartRatePanel = ui.Panel([ui.Label('Calculando…', {color: COLOR_TEXT_MUTED})]);
panel.add(chartRatePanel);

panel.add(ui.Label('Tabla resumen', sectionTitleStyle));
var tablePanel = ui.Panel([ui.Label('Calculando…', {color: COLOR_TEXT_MUTED})]);
panel.add(tablePanel);

panel.add(ui.Label('Descargas', sectionTitleStyle));
var downloadsPanel = ui.Panel();
panel.add(downloadsPanel);

panel.add(ui.Label('Notas de método', sectionTitleStyle));
panel.add(ui.Label(
  '• Serie calibrada: los cortes de Dynamic World se multiplican por el factor ' +
  '(área WSF 2015 / área Dynamic World jul-2015 a jun-2016) para llevarlos a la ' +
  'escala de WSF y poder comparar toda la serie.\n' +
  '• El mapa muestra la detección cruda de cada fuente: la fase 2010–2020 incluye ' +
  'también construcciones anteriores que WSF (30 m) no detectó y Dynamic World (10 m) sí.\n' +
  '• Umbral de Dynamic World: probabilidad media "built" > ' + DW_BUILT_THRESHOLD + ' (permisivo).',
  {fontSize: '11px', color: COLOR_TEXT_MUTED, whiteSpace: 'pre-wrap', margin: '0 8px'}
));

ui.root.widgets().reset([ui.SplitPanel({
  firstPanel: panel,
  secondPanel: map,
  orientation: 'horizontal'
})]);


// ----------------------------------------------------------------------------
// BLOQUE 8 — DATOS → INDICADORES, GRÁFICOS Y TABLA
// ----------------------------------------------------------------------------
// Una sola evaluación (server -> client) con todo lo que necesita el panel
// (regla de oro #8: nada de getInfo() repetidos).

function fmtHa(x) { return x.toFixed(1) + ' ha'; }
function fmtPct(x) { return (x >= 0 ? '+' : '') + x.toFixed(1) + '%'; }

ee.Dictionary({
  epochs: epochStats,
  wsf2015: wsf2015AreaHa,
  dw2015: dw2015AreaHa,
  dw2015Images: dw2015ImageCount,
  factor: calibrationFactor
}).evaluate(function(data, err) {
  if (err) {
    [chartAreaPanel, chartRatePanel, tablePanel].forEach(function(p) {
      p.clear();
      p.add(ui.Label('Error al calcular: ' + err, {color: '#b3261e'}));
    });
    return;
  }

  // Filas client-side, con métricas por período (respecto del corte anterior).
  var rows = epochs.map(function(e, i) {
    var stats = data.epochs[i];
    var row = {
      label: e.label, source: e.source, year: e.year,
      raw: stats.raw, calibrated: stats.calibrated,
      newHa: null, growthPct: null, haPerYear: null
    };
    if (i > 0) {
      var prev = data.epochs[i - 1].calibrated;
      row.newHa = stats.calibrated - prev;
      row.growthPct = prev > 0 ? (row.newHa / prev) * 100 : null;
      row.haPerYear = row.newHa / (e.year - epochs[i - 1].year);
    }
    return row;
  });
  var first = rows[0];
  var last = rows[rows.length - 1];

  // --- Indicadores ---
  kpiArea1990.value.setValue(fmtHa(first.calibrated));
  kpiArea1990.caption.setValue('WSF Evolution');
  kpiAreaNow.value.setValue(fmtHa(last.calibrated));
  kpiAreaNow.caption.setValue('calibrada · cruda ' + fmtHa(last.raw));
  if (first.calibrated > 0) {
    var totalPct = (last.calibrated - first.calibrated) / first.calibrated * 100;
    kpiGrowth.value.setValue(fmtPct(totalPct));
    kpiGrowth.caption.setValue('×' + (last.calibrated / first.calibrated).toFixed(2) +
      ' la superficie de 1990');
  } else {
    kpiGrowth.value.setValue('—');
    kpiGrowth.caption.setValue('sin superficie en 1990');
  }
  kpiFactor.value.setValue(data.factor !== null ? data.factor.toFixed(3) : '—');
  kpiFactor.caption.setValue('WSF ' + fmtHa(data.wsf2015) + ' / DW ' + fmtHa(data.dw2015) +
    ' (' + data.dw2015Images + ' imág.)');

  // --- Gráfico 1: superficie calibrada vs. cruda ---
  var areaTable = [['Corte', 'Calibrada (escala WSF)', 'Cruda (cada fuente)']].concat(
    rows.map(function(r) { return [r.label, r.calibrated, r.raw]; })
  );
  chartAreaPanel.clear();
  chartAreaPanel.add(ui.Chart(areaTable, 'ColumnChart', {
    colors: ['#2166ac', '#bdbdbd'],
    vAxis: {title: 'ha', minValue: 0},
    legend: {position: 'bottom'},
    chartArea: {width: '80%', height: '65%'},
    height: 240
  }));

  // --- Gráfico 2: ha/año por período, cada barra con el color de su fase ---
  var rateTable = [['Período', 'ha/año', {role: 'style'}]];
  rows.slice(1).forEach(function(r, idx) {
    rateTable.push([
      phaseLabels[idx + 1].replace(/ \(.*\)$/, ''),
      r.haPerYear,
      phasePalette[idx + 1]
    ]);
  });
  chartRatePanel.clear();
  chartRatePanel.add(ui.Chart(rateTable, 'ColumnChart', {
    vAxis: {title: 'ha nuevas por año (serie calibrada)', minValue: 0},
    legend: {position: 'none'},
    chartArea: {width: '80%', height: '65%'},
    height: 220
  }));

  // --- Tabla resumen ---
  var cellStyle = {fontSize: '11px', margin: '2px 4px', width: '64px', fontWeight: 'normal'};
  var headStyle = {fontSize: '11px', margin: '2px 4px', width: '64px', fontWeight: 'bold'};
  function tableRow(cells, style) {
    return ui.Panel(cells.map(function(c, j) {
      // Primera columna más ancha (nombre del corte).
      var s = {fontSize: style.fontSize, margin: style.margin, fontWeight: style.fontWeight,
               width: j === 0 ? '96px' : style.width};
      return ui.Label(c, s);
    }), ui.Panel.Layout.Flow('horizontal'));
  }
  tablePanel.clear();
  tablePanel.add(tableRow(['Corte', 'Cruda', 'Calibrada', 'Δ vs. ant.', 'ha/año'], headStyle));
  rows.forEach(function(r) {
    tablePanel.add(tableRow([
      r.label,
      r.raw.toFixed(1),
      r.calibrated.toFixed(1),
      r.growthPct === null ? '—' : fmtPct(r.growthPct),
      r.haPerYear === null ? '—' : r.haPerYear.toFixed(1)
    ], cellStyle));
  });
  tablePanel.add(ui.Label('Superficies en ha. Δ y ha/año sobre la serie calibrada.', {
    fontSize: '10px', color: COLOR_TEXT_MUTED, margin: '4px'
  }));

  // --- Descarga CSV de la tabla (ya calculada, sin volver a procesar) ---
  var tableFc = ee.FeatureCollection(rows.map(function(r) {
    return ee.Feature(null, {
      corte: r.label, fuente: r.source,
      ha_cruda: r.raw, ha_calibrada: r.calibrated,
      ha_nuevas: r.newHa, crecimiento_pct: r.growthPct, ha_por_anio: r.haPerYear,
      factor_calibracion: data.factor
    });
  }));
  tableFc.getDownloadURL('CSV',
    ['corte', 'fuente', 'ha_cruda', 'ha_calibrada', 'ha_nuevas', 'crecimiento_pct',
     'ha_por_anio', 'factor_calibracion'],
    'la_cumbre_mancha_urbana',
    function(url) {
      if (url) {
        downloadsPanel.add(ui.Label('Tabla de superficies (CSV)', {fontSize: '12px'}, url));
      }
    });
});

// --- Descarga GeoTIFF de las fases (independiente de la tabla) ---
growthPhases.toByte().getDownloadURL({
  name: 'la_cumbre_fases_crecimiento',
  region: aoi,
  scale: 10,
  crs: 'EPSG:4326',
  format: 'GEO_TIFF'
}, function(url, err) {
  downloadsPanel.add(url ?
    ui.Label('Ráster de fases (GeoTIFF, 10 m, 1 = hasta 1990 … 5 = 2020-hoy)', {fontSize: '12px'}, url) :
    ui.Label('GeoTIFF no disponible (' + err + '). Usá Export.image.toDrive del script de análisis.',
      {fontSize: '11px', color: COLOR_TEXT_MUTED}));
});
