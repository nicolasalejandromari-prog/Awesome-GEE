// ============================================================================
// CRECIMIENTO DE LA MANCHA URBANA DE LA CUMBRE (Punilla, Córdoba)
// Script para Google Earth Engine — Code Editor (JavaScript)
// ============================================================================
//
// Objetivo: cuantificar y visualizar el avance de la superficie urbanizada
// de La Cumbre desde ~1990 hasta la actualidad, como insumo técnico para el
// POAT-LC (complementa las Figuras 4.2.1 y 4.2.2 del Pre-diagnóstico, que
// hoy son cualitativas/históricas y basadas en fotointerpretación/catastro).
//
// Metodología (v3): las versiones anteriores clasificaban "a mano" con un
// umbral de índices espectrales (NDBI > NDVI y NDBI > MNDWI, Zha et al.,
// 2003) sobre compuestos propios de Landsat/Sentinel-2. Es un método válido
// y muy usado, pero NO es el estado del arte: es de 2003, sensible al umbral
// elegido, y en zonas de urbanización dispersa/baja densidad como La Cumbre
// en 1990 subdetecta (cada casa aislada rodeada de jardín/arbolado queda
// "diluida" en un píxel de 30m dominado por vegetación).
//
// Esta versión usa en cambio dos productos ya entrenados/validados y
// pensados específicamente para mapear asentamientos humanos:
//   - 1990, 2000, 2010 → World Settlement Footprint Evolution (WSF Evo,
//     DLR/Marconcini et al. 2021, Nature Scientific Data). Clasificación
//     multitemporal (no un umbral de una sola imagen) de Landsat 5/7,
//     1985-2015 anual, 30 m, con un modelo que impone crecimiento monótono
//     (una vez detectado como asentamiento, sigue siéndolo en años
//     posteriores) — resuelve de raíz el problema de subdetección en 1990
//     que teníamos con el umbral NDBI manual.
//     Asset (catálogo comunitario sat-io): projects/sat-io/open-datasets/WSF/WSF_EVO
//   - 2020 y Hoy → Dynamic World V1 (Google/WRI, 2022). Modelo de deep
//     learning (red neuronal) entrenado sobre miles de tiles etiquetados a
//     mano, 10 m, casi tiempo real desde 2015-06-27, con enmascarado de
//     nubes propio del producto. Es el estándar actual para cobertura de
//     suelo/urbano en GEE para el período reciente.
//     Asset (catálogo oficial): GOOGLE/DYNAMICWORLD/V1
//
// Con este cambio ya no hace falta armar compuestos propios ni enmascarar
// nubes a mano (Landsat QA_PIXEL / Sentinel-2 Cloud Score+): ambos productos
// ya resuelven eso internamente con métodos más robustos que un compuesto
// mediana simple. Se conserva igual un composite Sentinel-2 con Cloud
// Score+ SOLO como capa de referencia visual (RGB), no para clasificar.
//
// Metodología (v4) — CALIBRACIÓN ENTRE FUENTES: WSF Evolution (30 m) y
// Dynamic World (10 m) no miden lo mismo, así que comparar sus valores
// crudos entre sí (ej. 2010 vs. 2020) mezcla urbanización real con
// diferencia de sensor/resolución — el salto se ve artificialmente grande.
// Para poder dar UN número de crecimiento real, comparable en todo el
// período 1990-hoy, se agrega un paso de calibración en el año de solape
// (2015, último año de WSF Evolution y primer año con cobertura de
// Dynamic World): se mide el área construida con ambos métodos en ese
// mismo año y se calcula el factor que hace coincidir sus valores. Ese
// factor se aplica después a los cortes de Dynamic World (2020, Hoy) para
// llevarlos a la escala de WSF Evolution — ver Bloque 4bis. El resultado es
// una serie "calibrada" continua y comparable de punta a punta; la serie
// "cruda" (sin calibrar) se conserva igual en la tabla, para transparencia.
//
// Visualización: UNA sola capa "Fases de crecimiento urbano", donde cada
// píxel tiene el color del período en que se urbanizó por primera vez. La
// calibración es un ajuste sobre el número agregado de superficie (ha), no
// existe una forma defendible de "corregir" píxel a píxel un mapa con un
// factor escalar — el mapa muestra siempre la detección cruda de cada
// fuente.
//
// Salida: mapa de fases de crecimiento urbano + tabla de superficie (ha,
// cruda y calibrada) y % de crecimiento (serie calibrada) por corte
// temporal.
//
// Área de estudio: polígono propio "radio_urbano_LC" (Asset del usuario en
// el proyecto ee-nicolasalejandromari) — ver Bloque 1.
// ============================================================================


// ----------------------------------------------------------------------------
// BLOQUE 1 — ÁREA DE ESTUDIO
// ----------------------------------------------------------------------------

var radioUrbanoLC = ee.FeatureCollection('projects/ee-nicolasalejandromari/assets/radio_urbano_LC');
var aoi = radioUrbanoLC.geometry();

Map.centerObject(aoi, 13);
Map.addLayer(aoi, {color: 'white'}, 'Área de estudio (AOI)', false);


// ----------------------------------------------------------------------------
// BLOQUE 2 — WORLD SETTLEMENT FOOTPRINT EVOLUTION (1990 / 2000 / 2010 / 2015)
// ----------------------------------------------------------------------------

// Una sola banda: el valor de cada píxel es el AÑO (1985-2015) en que ese
// lugar fue detectado por primera vez como asentamiento; 0 = nunca
// detectado como tal en el período. La renombramos por las dudas (evita
// depender del nombre de banda que traiga el asset).
// Si da error de acceso: los assets de sat-io son públicos, pero si tu
// cuenta nunca los usó puede pedir "aceptar" el catálogo la primera vez —
// mirá https://gee-community-catalog.org/projects/wsf/ para el link directo.
//
// OJO: este asset es una ImageCollection (viene dividido en varios
// "tiles"/imágenes, no una sola imagen global), aunque conceptualmente
// represente una única capa. Por eso NO se carga con ee.Image() — hay que
// cargarlo como ImageCollection y unir los tiles con .mosaic() para tener
// una sola imagen continua sobre el AOI.
var wsfEvo = ee.ImageCollection('projects/sat-io/open-datasets/WSF/WSF_EVO')
  .filterBounds(aoi)
  .mosaic()
  .select(0)
  .rename('wsf_year');

// wsfBuiltByYear: booleano (0/1) de "ya estaba urbanizado en o antes de
// <year>". WSF Evo cubre hasta 2015, así que sirve tal cual para 1990,
// 2000, 2010 y también para 2015 (usado en el Bloque 4bis como ancla de
// calibración, no como corte propio en el mapa/tabla principal).
// .unmask(0): si el asset trae píxeles enmascarados (sin dato) dentro del
// AOI, se tratan como "no urbanizado". Sin esto, al combinar con Dynamic
// World en el Bloque 5 (.max()) la máscara se propaga y se perderían
// detecciones de 2020/Hoy en esos píxeles.
function wsfBuiltByYear(year) {
  return wsfEvo.gt(0).and(wsfEvo.lte(year)).unmask(0).rename('built');
}


// ----------------------------------------------------------------------------
// BLOQUE 3 — DYNAMIC WORLD (2015 para calibración, 2020 y Hoy)
// ----------------------------------------------------------------------------

// Dynamic World da, por cada imagen Sentinel-2, la probabilidad estimada
// de que el píxel sea "built" (0 a 1) más una banda "label" con la clase
// más probable. Para un corte temporal armamos el promedio de la
// probabilidad "built" en la ventana de fechas y comparamos contra
// DW_BUILT_THRESHOLD: cuanto más bajo el número, más permisivo (captura
// más construcciones aisladas/chicas rodeadas de arbolado, típicas de la
// zona rural de La Cumbre — casas de fin de semana en lotes grandes), pero
// también más riesgo de falsos positivos (suelo desnudo, caminos de
// tierra, techos de invernadero). Escala de referencia:
//   0.5  → estricto (el valor "de manual" del producto)
//   0.35 → intermedio
//   0.25 → permisivo (el que quedó activo — priorizamos no perder
//          construcciones sueltas aunque entre algo de ruido)
// Para ajustarlo, cambiá solo el número de la línea de abajo y volvé a
// correr el script.
// IMPORTANTE: este umbral solo afecta los cortes basados en Dynamic World
// (2015 de calibración, 2020 y Hoy). NO afecta 1990/2000/2010 (WSF
// Evolution, Bloque 2) — ese dataset no da una probabilidad continua, da
// directamente el año de detección, así que no tiene un umbral equivalente
// para tocar.
// El producto ya viene con su propio enmascarado de nubes interno
// (probabilidad de nube S2 + índices de desplazamiento de sombra), no hace
// falta agregar uno.
var DW_BUILT_THRESHOLD = 0.25;

function getDynamicWorldBuiltBool(start, end) {
  var dw = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
    .filterBounds(aoi)
    .filterDate(start, end)
    .select('built');

  var meanBuiltProb = dw.mean();
  var built = meanBuiltProb.gt(DW_BUILT_THRESHOLD).unmask(0).rename('built');
  return built;
}

// --- Sentinel-2 SOLO como capa de referencia visual (no para clasificar) ---
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
// BLOQUE 4 — SUPERFICIE (ha) POR ÉPOCA, SERIE CRUDA (WSF 1990/2000/2010)
// ----------------------------------------------------------------------------

// results: {epoch, areaHa, areaHaCalibrada} para la tabla final (Bloque 6).
// epochBool: máscara booleana (0/1) de cada corte — se usa tanto para el
// área como para la clasificación acumulada (Bloque 5).
var results = [];
var epochBool = {};

// scaleM = resolución nativa de la fuente — scale explícito (regla de oro
// #3). isCalibratable = false para WSF (es la escala de referencia, no se
// le aplica factor); true para cortes de Dynamic World (se corrigen en el
// Bloque 4bis, una vez calculado el factor).
function computeAreaHa(boolImg, scaleM) {
  var areaImg = boolImg.multiply(ee.Image.pixelArea());
  var areaStats = areaImg.reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: aoi,
    scale: scaleM,
    maxPixels: 1e9,
    tileScale: 4
  });
  return ee.Number(areaStats.get('built')).divide(10000);
}

function addResult(label, boolImg, scaleM, isCalibratable) {
  var areaHa = computeAreaHa(boolImg, scaleM);
  results.push({
    epoch: label,
    areaHa: areaHa,
    // se completa en el Bloque 4ter para los cortes de Dynamic World; para
    // WSF, la serie cruda YA es la serie calibrada (es la escala de
    // referencia).
    areaHaCalibrada: isCalibratable ? null : areaHa
  });
}

// --- 1990 / 2000 / 2010 — WSF Evolution, 30 m (serie de referencia) ---
[1990, 2000, 2010].forEach(function(year) {
  var built = wsfBuiltByYear(year);
  epochBool[year] = built;
  addResult(String(year) + ' (WSF Evolution)', built, 30, false);
});


// ----------------------------------------------------------------------------
// BLOQUE 4bis — CALIBRACIÓN ENTRE MÉTODOS (año de solape: 2015)
// ----------------------------------------------------------------------------
// WSF Evolution cubre hasta 2015; Dynamic World arranca el 2015-06-27. Ese
// año común es el punto donde podemos medir la MISMA realidad con los dos
// métodos y ver cuánto difieren solo por diferencia de sensor/resolución —
// esa diferencia es lo que descontamos del salto 2010→2020 para no
// confundirlo con urbanización real.
//
// WSF 2015: estado "a fin de 2015" según el producto (acumulado anual).
// DW 2015: promedio de probabilidad "built" en la ventana jul-2015 a
// jun-2016 — el primer período de 12 meses de Dynamic World (arranca a
// mitad de 2015), lo más cercano posible al mismo momento que mide WSF.
// OJO: en ese período solo volaba Sentinel-2A (2B se lanzó en 2017), así
// que hay bastantes menos imágenes que en 2020/Hoy. Si el factor sale raro,
// revisá cuántas imágenes entraron (ver print más abajo).

var wsf2015 = wsfBuiltByYear(2015);
var wsf2015AreaHa = computeAreaHa(wsf2015, 30);

var DW_2015_START = '2015-07-01';
var DW_2015_END = '2016-06-30';
var dw2015Bool = getDynamicWorldBuiltBool(DW_2015_START, DW_2015_END);
var dw2015AreaHa = computeAreaHa(dw2015Bool, 10);
var dw2015ImageCount = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
  .filterBounds(aoi)
  .filterDate(DW_2015_START, DW_2015_END)
  .size();

// Factor de calibración: por cuánto hay que MULTIPLICAR un valor medido
// con Dynamic World para llevarlo a la escala de WSF Evolution. Se espera
// < 1 (Dynamic World, con más resolución y umbral permisivo, detecta más
// superficie que WSF para la misma realidad — el factor lo compensa).
var calibrationFactor = wsf2015AreaHa.divide(dw2015AreaHa);


// ----------------------------------------------------------------------------
// BLOQUE 4ter — SUPERFICIE (ha) POR ÉPOCA, DYNAMIC WORLD (2020 y Hoy)
// ----------------------------------------------------------------------------

// --- 2020 — Dynamic World, 10 m ---
var built2020 = getDynamicWorldBuiltBool('2020-01-01', '2021-01-01');
epochBool[2020] = built2020;
addResult('2020 (Dynamic World)', built2020, 10, true);

// --- Hoy — Dynamic World, 10 m, últimos 12 meses ---
// Las fechas se arman del lado del cliente (JavaScript puro): así la
// etiqueta sale sin getInfo() bloqueantes (regla de oro #8).
var nowJs = new Date();
var startJs = new Date(nowJs.getTime());
startJs.setMonth(startJs.getMonth() - 12);
function formatYearMonth(d) {
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
}
var currentStart = ee.Date(startJs.getTime());
var currentEnd = ee.Date(nowJs.getTime());
var builtNowBool = getDynamicWorldBuiltBool(currentStart, currentEnd);
var hoyLabel = 'Hoy (Dynamic World, ' + formatYearMonth(startJs) +
  ' a ' + formatYearMonth(nowJs) + ')';
addResult(hoyLabel, builtNowBool, 10, true);

// Aplica el factor de calibración a los cortes de Dynamic World (los que
// quedaron con areaHaCalibrada = null en addResult).
results.forEach(function(r) {
  if (r.areaHaCalibrada === null) {
    r.areaHaCalibrada = r.areaHa.multiply(calibrationFactor);
  }
});

// Capa de referencia visual (no interviene en la clasificación).
Map.addLayer(
  getSentinel2RgbComposite(currentStart, currentEnd),
  {bands: ['B4', 'B3', 'B2'], min: 0, max: 3000},
  'Sentinel-2 RGB (referencia visual)', false
);


// ----------------------------------------------------------------------------
// BLOQUE 5 — FASES DE CRECIMIENTO URBANO (una sola capa, un color por época)
// ----------------------------------------------------------------------------
// A cada píxel se le asigna un único número (1 a 5) según el período en que
// se urbanizó POR PRIMERA VEZ, usando la unión acumulada de cada corte
// (1990 ⊂ 1990-2000 ⊂ ... ⊂ Hoy). Como las fuentes/resoluciones difieren
// entre cortes (WSF Evo 30m vs. Dynamic World 10m), la unión acumulada
// (.max(), equivalente a un OR) garantiza que el resultado sea monótono:
// nunca "desaparece" superficie ya urbanizada al pasar al corte siguiente.
// El mapa usa siempre la detección CRUDA de cada fuente (el factor de
// calibración del Bloque 4bis es una corrección de área agregada, no
// aplica a nivel de píxel).
// Limitación a tener en cuenta al leer el mapa: la fase 4 ("2010-2020")
// incluye también construcciones anteriores que WSF (30 m) no llegó a ver
// y Dynamic World (10 m) sí — es el mismo efecto que corrige el factor de
// calibración en la tabla, pero acá se ve sin corregir.

var cum1990 = epochBool[1990];
var cum2000 = cum1990.max(epochBool[2000]);
var cum2010 = cum2000.max(epochBool[2010]);
var cum2020 = cum2010.max(epochBool[2020]);
var cumHoy  = cum2020.max(builtNowBool);

var growthPhases = ee.Image(0)
  .where(cumHoy, 5)
  .where(cum2020, 4)
  .where(cum2010, 3)
  .where(cum2000, 2)
  .where(cum1990, 1)
  .selfMask(); // 0 = nunca urbanizado -> transparente, no tapa el resto

// Una fase, un color: 1=hasta 1990 (más viejo/frío) ... 5=2020-Hoy (más
// nuevo/cálido).
var phasePalette = ['#2166ac', '#67a9cf', '#fee08b', '#fdae61', '#d73027'];

Map.addLayer(
  growthPhases,
  {min: 1, max: 5, palette: phasePalette},
  'Fases de crecimiento urbano'
);


// ----------------------------------------------------------------------------
// BLOQUE 6 — TABLA DE RESULTADOS Y % DE CRECIMIENTO (SERIE CALIBRADA)
// ----------------------------------------------------------------------------
// Se evalúa una sola vez todo el diccionario de resultados (server -> client)
// para no llamar getInfo() repetidamente (regla de oro #8).

ee.Dictionary({
  wsf2015: wsf2015AreaHa,
  dw2015: dw2015AreaHa,
  dw2015Images: dw2015ImageCount,
  factor: calibrationFactor
}).evaluate(function(cal, err) {
  if (err) {
    print('Error calculando la calibración: ' + err);
    return;
  }
  print('=== Calibración entre métodos (año de solape: 2015) ===');
  print('WSF Evolution, 2015: ' + cal.wsf2015.toFixed(1) + ' ha');
  print('Dynamic World, jul-2015 a jun-2016: ' + cal.dw2015.toFixed(1) + ' ha (' +
    cal.dw2015Images + ' imágenes)');
  print('Factor de calibración aplicado a los cortes de Dynamic World (2020, Hoy): ' +
    cal.factor.toFixed(3));
});

var resultsList = ee.List(results.map(function(r) {
  return ee.Dictionary({epoch: r.epoch, raw: r.areaHa, calibrated: r.areaHaCalibrada});
}));

resultsList.evaluate(function(values, err) {
  if (err) {
    print('Error calculando la superficie: ' + err);
    return;
  }
  print('=== Superficie de mancha urbana — La Cumbre (ha) ===');
  print('cruda = medición directa de cada fuente | calibrada = ajustada al factor de WSF (serie comparable de punta a punta)');
  var prevCalibrated = null;
  values.forEach(function(v) {
    var line = v.epoch + ':  cruda ' + v.raw.toFixed(1) + ' ha, calibrada ' + v.calibrated.toFixed(1) + ' ha';
    if (prevCalibrated !== null && prevCalibrated > 0) {
      var growthPct = ((v.calibrated - prevCalibrated) / prevCalibrated) * 100;
      // Signo explícito según el valor (antes se anteponía "+" fijo, y un
      // valor negativo salía como "+-3.2%").
      var sign = growthPct >= 0 ? '+' : '';
      line += '   (' + sign + growthPct.toFixed(1) + '% vs. corte anterior, serie calibrada)';
    }
    print(line);
    prevCalibrated = v.calibrated;
  });

  // Gráfico de barras con la serie CALIBRADA (comparable de punta a punta).
  var chartData = values.map(function(v) { return [v.epoch, v.calibrated]; });
  chartData.unshift(['Período', 'Superficie urbana calibrada (ha)']);
  var chart = ui.Chart(chartData, 'ColumnChart', {
    title: 'Crecimiento de la mancha urbana — La Cumbre (serie calibrada)',
    hAxis: {title: 'Período'},
    vAxis: {title: 'Superficie urbanizada (ha), escala WSF Evolution'},
    legend: {position: 'none'}
  });
  print(chart);
});


// ----------------------------------------------------------------------------
// BLOQUE 7 — LEYENDA EN EL MAPA
// ----------------------------------------------------------------------------

var legend = ui.Panel({style: {position: 'bottom-left', padding: '8px 15px'}});
legend.add(ui.Label('Fases de crecimiento urbano', {fontWeight: 'bold'}));
var legendEntries = [
  {label: 'Hasta 1990 (WSF Evolution)', color: phasePalette[0]},
  {label: '1990 – 2000 (WSF Evolution)', color: phasePalette[1]},
  {label: '2000 – 2010 (WSF Evolution)', color: phasePalette[2]},
  {label: '2010 – 2020 (Dynamic World)', color: phasePalette[3]},
  {label: '2020 – Hoy (Dynamic World)', color: phasePalette[4]}
];
legendEntries.forEach(function(entry) {
  var colorBox = ui.Label('', {
    backgroundColor: entry.color,
    padding: '8px', margin: '0 0 4px 0'
  });
  var description = ui.Label(entry.label, {margin: '0 0 4px 6px'});
  legend.add(ui.Panel([colorBox, description], ui.Panel.Layout.Flow('horizontal')));
});
Map.add(legend);


// ----------------------------------------------------------------------------
// BLOQUE 8 — EXPORTAR RESULTADOS (opcional)
// ----------------------------------------------------------------------------
// Si querés el ráster de fases para usar en QGIS/Felt/GIS Cloud, descomentá
// y ajustá (Export corre en batch, sin el límite de ~5 min del editor
// interactivo — ver regla de oro #9 en caso de timeout).
//
// Export.image.toDrive({
//   image: growthPhases,
//   description: 'fases_crecimiento_urbano_la_cumbre_v4',
//   folder: 'POAT_LC_mancha_urbana',
//   region: aoi,
//   scale: 10,          // resolución de Dynamic World, la más fina de las fuentes usadas
//   crs: 'EPSG:4326',
//   maxPixels: 1e9
// });
