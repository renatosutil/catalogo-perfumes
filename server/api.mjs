// Serviço de busca sob demanda. GET /buscar?q=termo  |  GET /ficha?r=ref&n=nome (ficha olfativa)
// Procura o termo na fonte de preços, abre a página só dos modelos que ainda não estão no catálogo
// (no máximo MAX_NOVOS_BUSCA por busca) e devolve só { n, i, p, r, a } — sem loja, dólar ou margem.
// Proteções: 1 pedido por vez à fonte, pausa entre pedidos, cache por termo, limite por cliente e
// limite global por minuto; se a fonte responder 403/429, fica 30 min sem consultá-la.
import http from "node:http";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  caminho, lerJson, gravarJson, lerLojas, hoje, criarCliente, Bloqueio,
  lerModelos, lerOfertas, lerBusca, lerFicha, ofertaPerfume, ofertasDasLojas, normalizar, parametrosPreco, produtoPublico,
} from "../scraper/comum.mjs";
import { alertar } from "../scraper/alerta.mjs";

const env = process.env;
const PORTA = Number(env.PORTA || 8098);
const ORIGEM = env.ORIGEM || "*";
const DESCOBERTOS = env.DESCOBERTOS || caminho("descobertos.json");
const FICHAS = env.FICHAS || join(dirname(DESCOBERTOS), "fichas.json");
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
    const porId = new Map(), porNome = new Map(), porOferta = new Map();
    for (const p of [...bruto.produtos, ...extra]) {
      if (p.id) porId.set(String(p.id), p);
      porNome.set(normalizar(p.n), p);
      for (const o of p.o || []) porOferta.set(`${o[0]}:${o[2]}`, p);
    }
    return { porId, porNome, porOferta, extra, cotacao: preco.cotacaoFixa || bruto.cotacao };
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
      const html = await pedir(`/busca/?q=${encodeURIComponent(termo)}`);
      const { itens } = lerModelos(html);
      // ofertas soltas (sem modelo, ex.: kits) das nossas lojas: entram como produto próprio, 1 oferta
      const vistos = new Set();
      for (const it of lerBusca(html).itens) {
        const k = nomes.indexOf(it.loja);
        const chaveOferta = `${k}:${it.cod}`;
        if (k < 0 || !it.idOferta || !ofertaPerfume(it.nome) || vistos.has(chaveOferta)) continue;
        vistos.add(chaveOferta);
        const conhecido = cat.porOferta.get(chaveOferta) || cat.porId.get("o" + it.idOferta);
        if (conhecido) { if (!saida.includes(conhecido)) saida.push(conhecido); continue; }
        const prod = { id: "o" + it.idOferta, n: it.nome.replace(/^Perfume\s+/i, ""), i: it.img, o: [[k, it.usd, it.cod, hoje()]] };
        novos.push(prod);
        saida.push(prod);
        cat.porOferta.set(chaveOferta, prod);
      }
      let abertos = 0;
      for (const m of itens) {
        const conhecido = cat.porId.get(m.id) || cat.porNome.get(normalizar(m.nome));
        if (conhecido) { if (!saida.includes(conhecido)) saida.push(conhecido); continue; }
        if (abertos >= MAX_NOVOS_BUSCA || !podeConsultarFonte(1)) { parcial = true; continue; }
        abertos++;
        const o = ofertasDasLojas(lerOfertas(await pedir(m.href)), nomes, hoje());
        if (!o.length || o.some((x) => cat.porOferta.has(`${x[0]}:${x[2]}`))) continue;
        const prod = { id: m.id, n: m.nome, i: m.img, o };
        novos.push(prod);
        saida.push(prod);
      }
    } catch (e) {
      if (e instanceof Bloqueio) {
        bloqueadoAte = Date.now() + PAUSA_BLOQUEIO_MS;
        console.warn(`fonte respondeu ${e.message}; pausa de 30 min`);
        alertar(`A busca sob demanda foi bloqueada pela fonte (${e.message}). Ela fica 30 min parada; o site segue com o catálogo.`);
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

  // ficha olfativa: achada pela referência (r) ou pelo nome; guardada em FICHAS por 90 dias
  const fichaDoCache = (k) => {
    const c = lerJson(FICHAS, {})[k];
    return c && Date.now() - c.em < (c.f ? 90 : 30) * 864e5 ? c : null;
  };
  function produtoDaFicha(ref, nome) {
    const cat = catalogo();
    for (const parte of String(ref || "").split(",")) {
      const [l, c] = parte.split("-");
      const p = cat.porOferta.get(`${l}:${c}`);
      if (p) return p;
    }
    return nome ? cat.porNome.get(normalizar(nome)) : null;
  }
  const chaveFicha = (p) => (p.id ? "m" + p.id : "n:" + normalizar(p.n));
  async function ficha(p) {
    if (String(p.id || "").startsWith("o")) return { ficha: null }; // kit em oferta solta: sem ficha
    const k = chaveFicha(p);
    const c = fichaDoCache(k);
    if (c) return { ficha: c.f };
    if (!podeConsultarFonte(2)) return { ficha: null, indisponivel: true };
    try {
      let id = p.id;
      if (!id) {
        const { itens } = lerModelos(await pedir(`/busca/?q=${encodeURIComponent(p.n)}`));
        id = itens.find((m) => normalizar(m.nome) === normalizar(p.n))?.id;
      }
      const f = id ? lerFicha(await pedir(`/perfume_${id}/`)) : null;
      gravarJson(FICHAS, { ...lerJson(FICHAS, {}), [k]: { em: Date.now(), f } });
      return { ficha: f };
    } catch (e) {
      if (e instanceof Bloqueio) {
        bloqueadoAte = Date.now() + PAUSA_BLOQUEIO_MS;
        console.warn(`fonte respondeu ${e.message}; pausa de 30 min`);
        alertar(`A busca sob demanda foi bloqueada pela fonte (${e.message}). Ela fica 30 min parada; o site segue com o catálogo.`);
        return { ficha: null, indisponivel: true };
      }
      console.warn("erro na ficha:", e.message);
      return { ficha: null };
    }
  }

  return http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    res.setHeader("access-control-allow-origin", ORIGEM);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    const responder = (status, obj) => { res.statusCode = status; res.end(JSON.stringify(obj)); };
    if (u.pathname === "/saude") return responder(200, { ok: true });
    if (!["/buscar", "/ficha"].includes(u.pathname) || req.method !== "GET") return responder(404, { erro: "não encontrado" });

    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const liberado = () => {
      const agora = Date.now();
      const lista = (porCliente.get(ip) || []).filter((t) => agora - t < 60e3);
      if (lista.length >= POR_CLIENTE_MIN) return false;
      lista.push(agora);
      porCliente.set(ip, lista);
      if (porCliente.size > 5000) porCliente.clear();
      return true;
    };

    if (u.pathname === "/ficha") {
      const p = produtoDaFicha(u.searchParams.get("r"), u.searchParams.get("n"));
      if (!p) return responder(200, { ficha: null });
      if (!fichaDoCache(chaveFicha(p)) && !liberado()) return responder(429, { erro: "aguarde um minuto" });
      try { return responder(200, await ficha(p)); }
      catch (e) { console.error(e); return responder(500, { erro: "falha na ficha" }); }
    }

    const termo = (u.searchParams.get("q") || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (normalizar(termo).length < 3) return responder(400, { erro: "digite ao menos 3 letras" });
    if (!liberado()) return responder(429, { erro: "muitas buscas; aguarde um minuto" });

    try { responder(200, await buscar(termo)); }
    catch (e) { console.error(e); responder(500, { erro: "falha na busca" }); }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  criarServico().listen(PORTA, () => console.log(`busca sob demanda na porta ${PORTA}`));
}
