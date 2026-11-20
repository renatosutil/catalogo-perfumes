// Aviso por WhatsApp (Evolution API) quando a coleta ou a busca têm problema.
// Variáveis: EVOLUTION_URL, EVOLUTION_INSTANCIA, EVOLUTION_APIKEY, ALERTA_NUMERO.
// Sem elas, só imprime o aviso no log. Uso direto: node scraper/alerta.mjs "texto"
import { fileURLToPath } from "node:url";

export async function alertar(texto) {
  const { EVOLUTION_URL: url, EVOLUTION_INSTANCIA: inst, EVOLUTION_APIKEY: chave, ALERTA_NUMERO: numero } = process.env;
  const msg = `⚠️ Catálogo de perfumes\n${texto}`;
  if (!url || !inst || !chave || !numero) {
    console.log(`(aviso por WhatsApp não configurado) ${texto}`);
    return false;
  }
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}/message/sendText/${encodeURIComponent(inst)}`, {
      method: "POST",
      headers: { apikey: chave, "content-type": "application/json" },
      body: JSON.stringify({ number: numero, text: msg }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) console.warn(`aviso por WhatsApp falhou: HTTP ${r.status}`);
    return r.ok;
  } catch (e) {
    console.warn("aviso por WhatsApp falhou:", e.message);
    return false;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  alertar(process.argv.slice(2).join(" ") || "teste de aviso").then((ok) => { process.exitCode = ok ? 0 : 1; });
}
