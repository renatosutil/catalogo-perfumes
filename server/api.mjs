// Serviço de busca sob demanda. GET /buscar?q=termo
// Procura o termo na fonte de preços, abre a página só dos modelos que ainda não estão no catálogo
// (no máximo MAX_NOVOS_BUSCA por busca) e devolve só { n, i, p, r, a } — sem loja, dólar ou margem.
// Proteções: 1 pedido por vez à fonte, pausa entre pedidos, cache por termo, limite por cliente e
// limite global por minuto; se a fonte responder 403/429, fica 30 min sem consultá-la.
import http from "node:http";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  caminho, lerJson, gravarJson, lerLojas, hoje, criarCliente, Bloqueio,
  lerModelos, lerOfertas, ofertasDasLojas, normalizar, parametrosPreco, produtoPublico,
} from "../scraper/comum.mjs";

const env = process.env;
const PORTA = Number(env.PORTA || 8098);
const ORIGEM = env.ORIGEM || "*";
const DESCOBERTOS = env.DESCOBERTOS || caminho("descobertos.json");
const MAX_NOVOS_BUSCA = Number(env.MAX_NOVOS_BUSCA || 3);
const CACHE_MS = Number(env.CACHE_HORAS || 12) * 3600e3;
const POR_CLIENTE_MIN = Number(env.BUSCAS_POR_MINUTO || 8);
const PEDIDOS_FONTE_MIN = Number(env.PEDIDOS_FONTE_POR_MINUTO || 20);
const PAUSA_BLOQUEIO_MS = 30 * 60e3;

export function criarServico({ cliente = criarCliente({ esperaMs: Number(env.ESPERA_API_MS ?? 1000) }) } = {}) {
  const preco = parametrosPreco();
  const nomes = lerLojas().map((l) => l.nome);
  const cache = new Map(); // termo -> { em, corpo }
  const porCliente = new Map(); // ip -> [instantes]
  let pedidosFonte = []; // instantes dos pedidos à fonte (janela de 1 min)
  let bloqueadoAte = 0;

  // catálogo conhecido = bruto.json (recarregado quando muda) + descobertos.json
  let bruto = { produtos: [] }, mtime = 0;
  const catalogo = () => {
    const arq = caminho("bruto.json");
    if (existsSync(arq) && statSync(arq).mtimeMs !== mtime) { bruto = lerJson(arq); mtime = statSync(arq).mtimeMs; }
    const extra = lerJson(DESCOBERTOS, []);
    const porId = new Map(), porNome = new Map();
    for (const p of [...bruto.produtos, ...extra]) {
      if (p.id) porId.set(String(p.id), p);
      porNome.set(normalizar(p.n), p);
    }
    return { porId, porNome, extra, cotacao: preco.cotacaoFixa || bruto.cotacao };
  };

  const podeConsultarFonte = (n) => {
    const agora = Date.now();
    pedidosFonte = pedidosFonte.filter((t) => agora - t < 60e3);
    return agora >= bloqueadoAte && pedidosFonte.length + n <= PEDIDOS_FONTE_MIN;
  };
  const pedir = async (path) => { pedidosFonte.push(Date.now()); return (await cliente.get(path)).html; };

  async function buscar(termo) {
    const chave = normalizar(termo);
    const c = cache.get(chave);
    if (c && Date.now() - c.em < CACHE_MS) return c.corpo;
    if (!podeConsultarFonte(1)) return { produtos: [], indisponivel: true };

    const cat = catalogo();
    const saida = [], novos = [];
    let parcial = false;
    try {
      const { itens } = lerModelos(await pedir(`/busca/?q=${encodeURIComponent(termo)}`));
      for (const m of itens) {
        const conhecido = cat.porId.get(m.id) || cat.porNome.get(normalizar(m.nome));
        if (conhecido) { saida.push(conhecido); continue; }
        if (novos.length >= MAX_NOVOS_BUSCA || !podeConsultarFonte(1)) { parcial = true; continue; }
        const o = ofertasDasLojas(lerOfertas(await pedir(m.href)), nomes, hoje());
        if (!o.length) continue;
        const prod = { id: m.id, n: m.nome, i: m.img, o };
        novos.push(prod);
        saida.push(prod);
      }
    } catch (e) {
      if (e instanceof Bloqueio) {
        bloqueadoAte = Date.now() + PAUSA_BLOQUEIO_MS;
        console.warn(`fonte respondeu ${e.message}; pausa de 30 min`);
        return { produtos: [], indisponivel: true };
      }
      console.warn("erro na busca:", e.message);
      parcial = true;
    }
    if (novos.length) {
      const extra = lerJson(DESCOBERTOS, []);
      const ja = new Set(extra.map((p) => String(p.id)));
      gravarJson(DESCOBERTOS, [...extra, ...novos.filter((p) => !ja.has(String(p.id)))]);
    }
    const corpo = { produtos: saida.map((p) => produtoPublico(p, cat.cotacao, preco)).filter(Boolean), parcial };
    if (!parcial) cache.set(chave, { em: Date.now(), corpo });
    return corpo;
  }

  return http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    res.setHeader("access-control-allow-origin", ORIGEM);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    const responder = (status, obj) => { res.statusCode = status; res.end(JSON.stringify(obj)); };
    if (u.pathname === "/saude") return responder(200, { ok: true });
    if (u.pathname !== "/buscar" || req.method !== "GET") return responder(404, { erro: "não encontrado" });

    const termo = (u.searchParams.get("q") || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (normalizar(termo).length < 3) return responder(400, { erro: "digite ao menos 3 letras" });

    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const agora = Date.now();
    const lista = (porCliente.get(ip) || []).filter((t) => agora - t < 60e3);
    if (lista.length >= POR_CLIENTE_MIN) return responder(429, { erro: "muitas buscas; aguarde um minuto" });
    lista.push(agora);
    porCliente.set(ip, lista);
    if (porCliente.size > 5000) porCliente.clear();

    try { responder(200, await buscar(termo)); }
    catch (e) { console.error(e); responder(500, { erro: "falha na busca" }); }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  criarServico().listen(PORTA, () => console.log(`busca sob demanda na porta ${PORTA}`));
}
