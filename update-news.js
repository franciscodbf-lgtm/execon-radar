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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function llamarClaude(body, intento = 1) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    const data = JSON.parse(text);
    if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
    return data;
  } catch(e) {
    if (intento < 3) {
      console.log(`  ⚠️ Error en intento ${intento}: ${e.message}. Reintentando en 10s...`);
      await sleep(10000);
      return llamarClaude(body, intento + 1);
    }
    throw e;
  }
}

async function buscarConClaude() {
  console.log('🔍 Buscando noticias con Claude + web_search...');

  const hoy = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const prompt = `Hoy es ${hoy}. Buscá 20 noticias reales y recientes de Argentina (últimos 90 días) sobre planes de expansión, inversiones en construcción, aperturas planificadas o proyectos de infraestructura física de empresas. Cualquier empresa que esté creciendo físicamente en Argentina es relevante: cadenas de comida, bancos, supermercados, retail, logística, salud privada, educación privada, estaciones de servicio, industria, oficinas corporativas, marcas internacionales que llegan al país.

Ejemplos de lo que buscamos: "Mostaza planea abrir 30 locales en 2026", "Mercado Libre construye nuevo depósito en Córdoba", "Universidad Siglo XXI amplía su campus", "Shell renueva sus estaciones en Argentina", "marca X desembarca en Argentina con 10 locales".

Foco en Córdoba, Buenos Aires, Mendoza, Santa Fe. Incluir resto del país.

Respondé SOLO con un JSON array válido, sin texto antes ni después, sin bloques de código:
[{"titulo":"...","resumen":"1-2 oraciones: empresa, tipo de inversión/obra, ubicación","sector":"banco|gastronomia|retail|logistica|industrial|energia|oficinas|salud|educacion|otros","provincia":"nombre provincia o Nacional","relevancia":2,"url":"https://..."}]

Relevancia: 3=obra muy probable para constructora, 2=relevante, 1=informativo.
IMPORTANTE: Respondé SIEMPRE solo con el JSON array. Sin explicaciones, sin texto adicional.`;

  const TOOLS = [{ type: 'web_search_20250305', name: 'web_search' }];
  let messages = [{ role: 'user', content: prompt }];
  let rawText  = '';
  let vuelta   = 0;

  while (vuelta < 10) {
    vuelta++;
    console.log(`  Vuelta ${vuelta}...`);

    const data = await llamarClaude({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      tools: TOOLS,
      messages
    });

    messages.push({ role: 'assistant', content: data.content });

    if (data.stop_reason === 'end_turn') {
      rawText = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
      console.log(`  ✅ Terminó en vuelta ${vuelta}`);
      console.log(`  📄 Respuesta (primeros 500 chars): ${rawText.substring(0, 500)}`);
      break;
    }

    if (data.stop_reason === 'tool_use') {
      const toolResults = data.content
        .filter(b => b.type === 'tool_use')
        .map(tb => ({ type: 'tool_result', tool_use_id: tb.id, content: JSON.stringify(tb.input) }));
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    rawText = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    break;
  }

  return rawText;
}

function parsearNoticias(rawText) {
  let clean = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('[');
  const end   = clean.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No se encontró JSON en la respuesta');

  let jsonStr = clean.slice(start, end + 1)
    .replace(/"((?:[^"\\]|\\.)*)"/g, (m, p) =>
      '"' + p.replace(/[\n\r\t]/g, ' ').replace(/[\x00-\x1F\x7F]/g, ' ') + '"'
    )
    .replace(/,\s*([}\]])/g, '$1');

  return JSON.parse(jsonStr);
}

(async () => {
  console.log('🚀 Execon Radar — Generando news.json\n');
  try {
    const rawText  = await buscarConClaude();
    if (!rawText.trim()) throw new Error('Claude no devolvió texto');
    const noticias = parsearNoticias(rawText);
    if (!Array.isArray(noticias) || !noticias.length) throw new Error('JSON vacío');

    const output = { generado: new Date().toISOString(), noticias };
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
    console.log(`\n💾 Guardado: ${noticias.length} noticias`);
    console.log('✅ Listo.');
  } catch(e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  }
})();
