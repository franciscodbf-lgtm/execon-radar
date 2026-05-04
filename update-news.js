/**
 * update-news.js
 * Execon — Radar Comercial
 * Corre 3 veces por semana en GitHub Actions
 * Costo: ~$0.01 por ejecución (solo Claude Haiku para clasificar)
 */
 
const fs   = require('fs');
const path = require('path');
 
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SERPAPI_KEY       = process.env.SERPAPI_KEY;
const OUTPUT_FILE       = path.join(__dirname, 'news.json');
const SEEN_FILE         = path.join(__dirname, 'seen-urls.json');
 
if (!ANTHROPIC_API_KEY) { console.error('❌ Falta ANTHROPIC_API_KEY'); process.exit(1); }
if (!SERPAPI_KEY)       { console.error('❌ Falta SERPAPI_KEY');       process.exit(1); }
 
// ─── URLs ya vistas (para no repetir noticias) ────────────────────────────────
function cargarVistas() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))); }
  catch { return new Set(); }
}
function guardarVistas(vistas) {
  // Guardar solo las últimas 500 para no crecer indefinidamente
  const arr = [...vistas].slice(-500);
  fs.writeFileSync(SEEN_FILE, JSON.stringify(arr), 'utf8');
}
 
// ─── Buscar en Google News via SerpApi ───────────────────────────────────────
async function buscarEnGoogle(query) {
  const url = `https://serpapi.com/search.json?engine=google_news&q=${encodeURIComponent(query)}&gl=ar&hl=es&api_key=${SERPAPI_KEY}`;
  try {
    const res  = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    if (data.error) { console.warn(`  ⚠️ SerpApi: ${data.error}`); return []; }
    return (data.news_results || []).map(r => ({
      titulo:  r.title || '',
      resumen: r.snippet || '',
      url:     r.link || '',
      fuente:  r.source?.name || '',
    })).filter(r => r.titulo && r.url);
  } catch(e) {
    console.warn(`  ⚠️ Error buscando "${query}": ${e.message}`);
    return [];
  }
}
 
// ─── Clasificar con Claude Haiku (1 sola llamada) ─────────────────────────────
async function clasificarConClaude(articulos) {
  console.log(`🤖 Clasificando ${articulos.length} artículos con Claude...`);
 
  const lista = articulos.slice(0, 50).map((a, i) =>
    `${i+1}. ${a.titulo} | ${a.resumen.substring(0, 100)} | URL: ${a.url}`
  ).join('\n');
 
  const prompt = `Sos un analista para Execon SRL, constructora argentina de obras corporativas.
 
De esta lista, seleccioná las 10 noticias más relevantes sobre expansión física, construcción, aperturas o inversiones de empresas en Argentina. Cadenas gastronómicas, retail, supermercados, bancos, logística, salud, educación privada, estaciones de servicio, industria, oficinas, marcas internacionales.
 
NOTICIAS:
${lista}
 
Respondé SOLO con un JSON array de exactamente 10 elementos, sin texto adicional:
[{"titulo":"...","resumen":"1 oración corta: empresa y tipo de obra","sector":"banco|gastronomia|retail|logistica|industrial|energia|oficinas|salud|educacion|otros","provincia":"nombre o Nacional","relevancia":2,"url":"https://..."}]`;
 
  const res  = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }]
    })
  });
 
  const text = await res.text();
  const data = JSON.parse(text);
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
 
  const rawText = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
 
  let clean = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('[');
  const end   = clean.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error(`No se encontró JSON. Respuesta: ${clean.substring(0, 200)}`);
 
  let jsonStr = clean.slice(start, end + 1)
    .replace(/"((?:[^"\\]|\\.)*)"/g, (m, p) =>
      '"' + p.replace(/[\n\r\t]/g, ' ').replace(/[\x00-\x1F\x7F]/g, ' ') + '"'
    )
    .replace(/,\s*([}\]])/g, '$1');
 
  return JSON.parse(jsonStr);
}
 
// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('🚀 Execon Radar — Generando news.json\n');
  try {
    // 1. Cargar URLs ya vistas
    const vistas = cargarVistas();
    console.log(`📋 URLs ya vistas: ${vistas.size}`);
 
    // 2. Buscar en Google News con varias queries
    console.log('🔍 Buscando en Google News...');
    const queries = [
      'expansión apertura local empresa Argentina 2026',
      'nueva sucursal tienda inversión Argentina',
      'plan expansión construcción obra Argentina empresa',
      'marca internacional desembarca llega Argentina',
      'inauguración depósito planta oficina Argentina',
    ];
 
    const resultados = await Promise.all(queries.map(q => buscarEnGoogle(q)));
    const todos = resultados.flat();
 
    // 3. Filtrar los ya vistos y deduplicar
    const seenUrls   = new Set();
    const articulos  = todos.filter(a => {
      if (vistas.has(a.url) || seenUrls.has(a.url)) return false;
      seenUrls.add(a.url);
      return true;
    });
 
    console.log(`  ✅ ${todos.length} artículos obtenidos, ${articulos.length} nuevos`);
 
    if (!articulos.length) {
      console.log('⚠️ No hay artículos nuevos. Manteniendo news.json anterior.');
      process.exit(0);
    }
 
    // 4. Clasificar con Claude — 2 llamadas de 10 para llegar a 20
    const mitad1 = await clasificarConClaude(articulos.slice(0, 50));
    const mitad2 = await clasificarConClaude(articulos.slice(50, 100));
    const noticias = [...(mitad1 || []), ...(mitad2 || [])];
    if (!Array.isArray(noticias) || !noticias.length) throw new Error('Claude no devolvió noticias');
 
    // 5. Guardar URLs vistas
    noticias.forEach(n => vistas.add(n.url));
    guardarVistas(vistas);
 
    // 6. Guardar news.json
    const output = { generado: new Date().toISOString(), noticias };
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
    console.log(`\n💾 Guardado: ${noticias.length} noticias`);
    console.log('✅ Listo.');
 
  } catch(e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  }
})();
 
