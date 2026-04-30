/**
 * update-news.js
 * Execon — Radar Comercial
 *
 * Ejecutar: node update-news.js
 * Cron:     1 vez por día vía GitHub Actions
 *
 * Variables de entorno requeridas:
 *   NEWSAPI_KEY      → https://newsapi.org  (plan gratis: 100 req/día)
 *   ANTHROPIC_API_KEY → https://console.anthropic.com
 */

const fs   = require('fs');
const path = require('path');

const NEWSAPI_KEY       = process.env.NEWSAPI_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OUTPUT_FILE       = path.join(__dirname, 'news.json');

// ─── Validación de env ────────────────────────────────────────────────────────
if (!NEWSAPI_KEY)       { console.error('❌ Falta NEWSAPI_KEY');       process.exit(1); }
if (!ANTHROPIC_API_KEY) { console.error('❌ Falta ANTHROPIC_API_KEY'); process.exit(1); }

// ─── 1. Buscar noticias en NewsAPI ────────────────────────────────────────────
async function fetchFromNewsAPI() {
  console.log('📰 Buscando noticias en NewsAPI...');

  const queries = [
    'banco sucursal Argentina apertura',
    'McDonald\'s Burger King Starbucks Argentina expansión',
    'supermercado retail local comercial Argentina inversión',
    'logística Mercado Libre depósito Argentina',
    'planta industrial oficina corporativa Argentina',
    'Córdoba Buenos Aires Mendoza Santa Fe inversión obra',
  ];

  const articles = [];
  const seenUrls = new Set();

  for (const q of queries) {
    try {
      const url = `https://newsapi.org/v2/everything?` +
        `q=${encodeURIComponent(q)}` +
        `&language=es` +
        `&sortBy=publishedAt` +
        `&pageSize=10` +
        `&from=${daysAgo(30)}` +
        `&apiKey=${NEWSAPI_KEY}`;

      const res  = await fetch(url);
      const data = await res.json();

      if (data.status !== 'ok') {
        console.warn(`  ⚠️  Query "${q}" → ${data.message || data.status}`);
        continue;
      }

      for (const a of (data.articles || [])) {
        if (!seenUrls.has(a.url) && a.title && !a.title.includes('[Removed]')) {
          seenUrls.add(a.url);
          articles.push({
            titulo:  a.title,
            resumen: a.description || a.content?.substring(0, 200) || '',
            url:     a.url,
            fuente:  a.source?.name || '',
            fecha:   a.publishedAt?.substring(0, 10) || '',
          });
        }
      }
    } catch (e) {
      console.warn(`  ⚠️  Error en query "${q}": ${e.message}`);
    }

    // Pausa corta para no saturar la API
    await sleep(300);
  }

  console.log(`  ✅ ${articles.length} artículos obtenidos de NewsAPI`);
  return articles;
}

// ─── 2. Filtrar y clasificar con Claude (1 llamada) ───────────────────────────
async function filterWithClaude(articles) {
  console.log('🤖 Filtrando con Claude (1 llamada)...');

  // Limitar input para reducir tokens
  const subset = articles.slice(0, 80).map((a, i) =>
    `${i+1}. TITULO: ${a.titulo}\nRESUMEN: ${a.resumen?.substring(0,150)}\nURL: ${a.url}`
  ).join('\n\n');

  const prompt = `Sos un analista de inteligencia comercial para Execon SRL, constructora argentina especializada en obras corporativas: bancos, gastronomía, retail, logística, oficinas, industrial.

De las siguientes noticias, seleccioná las 20 MÁS relevantes para Execon (obras potenciales en Argentina).

Criterios de selección:
- Expansión de sucursales bancarias
- Apertura de cadenas gastronómicas o locales
- Inversión en supermercados o retail
- Expansión logística (depósitos, centros de distribución)
- Nuevas oficinas o plantas industriales
- Proyectos de salud privada o educación

Para cada una elegida devolvé SOLO este JSON array (sin texto adicional):
[{"titulo":"...","resumen":"2 oraciones: empresa, tipo de inversión, ubicación","sector":"banco|gastronomia|retail|logistica|industrial|energia|oficinas|salud|educacion|otros","provincia":"nombre o Nacional","relevancia":1|2|3,"url":"..."}]

Relevancia: 3=obra muy probable, 2=relevante, 1=informativo

NOTICIAS:
${subset}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',   // Modelo más barato
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Claude API error: ${err.error?.message || res.status}`);
  }

  const data = await res.json();
  const raw  = data.content.filter(b => b.type === 'text').map(b => b.text).join('');

  // Extraer JSON robusto
  const start = raw.indexOf('[');
  const end   = raw.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('Claude no devolvió JSON válido');

  let jsonStr = raw.slice(start, end + 1)
    .replace(/"((?:[^"\\]|\\.)*)"/g, (m, p) =>
      '"' + p.replace(/[\n\r\t]/g, ' ').replace(/[\x00-\x1F\x7F]/g, ' ') + '"'
    )
    .replace(/,\s*([}\]])/g, '$1');

  const noticias = JSON.parse(jsonStr);
  console.log(`  ✅ Claude seleccionó ${noticias.length} noticias`);
  return noticias;
}

// ─── 3. Fallback: clasificación simple sin Claude ─────────────────────────────
function classifyFallback(articles) {
  console.log('⚡ Usando clasificación fallback (sin Claude)...');

  const keywords = {
    banco:       ['banco', 'bbva', 'galicia', 'santander', 'macro', 'itaú', 'icbc', 'hsbc', 'sucursal bancaria'],
    gastronomia: ['mcdonald', 'burger king', 'starbucks', 'mostaza', 'kfc', 'restaurant', 'gastronomía', 'cadena gastronómica'],
    retail:      ['carrefour', 'coto', 'changomás', 'walmart', 'falabella', 'zara', 'h&m', 'shopping', 'local comercial'],
    logistica:   ['mercado libre', 'andreani', 'oca', 'logística', 'depósito', 'centro de distribución'],
    industrial:  ['planta industrial', 'fábrica', 'industria', 'manufactura', 'parque industrial'],
    oficinas:    ['oficina', 'torre corporativa', 'edificio de oficinas', 'coworking'],
    salud:       ['clínica', 'hospital', 'sanatorio', 'salud privada', 'centro médico'],
    educacion:   ['colegio', 'universidad', 'instituto', 'educación privada'],
    energia:     ['energía', 'solar', 'renovable', 'planta de energía'],
  };

  const result = [];
  for (const a of articles.slice(0, 40)) {
    const texto = (a.titulo + ' ' + a.resumen).toLowerCase();
    let sector = 'otros';
    for (const [s, kws] of Object.entries(keywords)) {
      if (kws.some(k => texto.includes(k))) { sector = s; break; }
    }

    // Solo incluir si tiene alguna keyword relevante
    const anyMatch = Object.values(keywords).flat().some(k => texto.includes(k));
    if (!anyMatch) continue;

    result.push({
      titulo:    a.titulo,
      resumen:   a.resumen?.substring(0, 200) || 'Sin descripción disponible.',
      sector,
      provincia: 'Nacional',
      relevancia: 2,
      url:       a.url,
    });

    if (result.length >= 20) break;
  }

  console.log(`  ✅ Fallback clasificó ${result.length} noticias`);
  return result;
}

// ─── 4. Guardar news.json ─────────────────────────────────────────────────────
function saveNews(noticias) {
  const output = {
    generado: new Date().toISOString(),
    noticias,
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log(`💾 Guardado en ${OUTPUT_FILE} (${noticias.length} noticias)`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().substring(0, 10);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('🚀 Execon Radar — Generando news.json\n');

  try {
    // 1. Obtener artículos de NewsAPI
    const articles = await fetchFromNewsAPI();

    if (!articles.length) {
      console.error('❌ No se obtuvieron artículos de NewsAPI');
      process.exit(1);
    }

    // 2. Filtrar con Claude (con fallback si falla)
    let noticias;
    try {
      noticias = await filterWithClaude(articles);
    } catch (e) {
      console.warn(`⚠️  Claude falló (${e.message}), usando fallback...`);
      noticias = classifyFallback(articles);
    }

    // 3. Guardar
    saveNews(noticias);
    console.log('\n✅ Listo. El frontend ya puede leer news.json');

  } catch (e) {
    console.error('❌ Error fatal:', e.message);
    process.exit(1);
  }
})();
