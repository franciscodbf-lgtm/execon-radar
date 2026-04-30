/**
 * update-news.js
 * Execon — Radar Comercial
 * Corre 1 vez por día en GitHub Actions
 */
 
const fs   = require('fs');
const path = require('path');
 
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OUTPUT_FILE       = path.join(__dirname, 'news.json');
 
if (!ANTHROPIC_API_KEY) { console.error('❌ Falta ANTHROPIC_API_KEY'); process.exit(1); }
 
// ─── Llamada a Claude con web_search (loop multi-turno) ───────────────────────
async function buscarConClaude() {
  console.log('🔍 Buscando noticias con Claude + web_search...');
 
  const hoy = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
 
  const prompt = `Hoy es ${hoy}. Buscá 20 noticias reales y recientes de Argentina (últimos 30 días) sobre expansión e inversión corporativa relevante para una constructora: nuevas sucursales bancarias, apertura de cadenas gastronómicas, retail, supermercados, logística, oficinas corporativas, plantas industriales, salud privada. Foco en Córdoba, Buenos Aires, Mendoza, Santa Fe.
 
Cuando termines de buscar, respondé SOLO con un JSON array válido, sin texto antes ni después, sin bloques de código:
[{"titulo":"...","resumen":"1-2 oraciones: empresa, tipo de inversión, ubicación","sector":"banco|gastronomia|retail|logistica|industrial|energia|oficinas|salud|educacion|otros","provincia":"nombre provincia o Nacional","relevancia":2,"url":"https://..."}]
 
Relevancia: 3=obra muy probable para constructora, 2=relevante, 1=informativo.`;
 
  const HEADERS = {
    'Content-Type': 'application/json',
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  const TOOLS = [{ type: 'web_search_20250305', name: 'web_search' }];
 
  let messages = [{ role: 'user', content: prompt }];
  let rawText  = '';
  let intentos = 0;
 
  while (intentos < 10) {
    intentos++;
    console.log(`  Vuelta ${intentos}...`);
 
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4000,
        tools: TOOLS,
        messages
      })
    });
 
    const data = await res.json();
    if (!res.ok) throw new Error(`Claude API error: ${data.error?.message || res.status}`);
 
    messages.push({ role: 'assistant', content: data.content });
 
    if (data.stop_reason === 'end_turn') {
      rawText = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
      console.log(`  ✅ Claude terminó en vuelta ${intentos}`);
      break;
    }
 
    if (data.stop_reason === 'tool_use') {
      const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
      const toolResults   = toolUseBlocks.map(tb => ({
        type: 'tool_result',
        tool_use_id: tb.id,
        content: JSON.stringify(tb.input)
      }));
      messages.push({ role: 'user', content: toolResults });
      continue;
    }
 
    rawText = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    break;
  }
 
  return rawText;
}
 
// ─── Parsear JSON de la respuesta ─────────────────────────────────────────────
function parsearNoticias(rawText) {
  let clean = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('[');
  const end   = clean.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No se encontró JSON en la respuesta de Claude');
 
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
    const rawText  = await buscarConClaude();
 
    if (!rawText.trim()) throw new Error('Claude no devolvió texto');
 
    const noticias = parsearNoticias(rawText);
 
    if (!Array.isArray(noticias) || !noticias.length) {
      throw new Error('El JSON está vacío o no es un array');
    }
 
    const output = { generado: new Date().toISOString(), noticias };
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
    console.log(`\n💾 Guardado: ${noticias.length} noticias en news.json`);
    console.log('✅ Listo.');
 
  } catch(e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  }
})();
