// Coleta perfumes e preços das lojas listadas em lojas.json, via ComprasParaguai.
// Saída: site/data.json. Se a coleta falhar ou vier quase vazia, o arquivo antigo é mantido.
import * as cheerio from "cheerio";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.BASE_URL || "https://mobile.comprasparaguai.com.br").replace(/\/$/, "");
const SAIDA = process.env.SAIDA || join(AQUI, "..", "site", "data.json");
const MINIMO_OK = Number(process.env.MINIMO_OK || 50);
const ESPERA_MS = Number(process.env.ESPERA_MS || 350);
const LOJAS = JSON.parse(readFileSync(join(AQUI, "lojas.json"), "utf8"));
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

async function baixar(url, tentativas = 3) {
  let erro;
  for (let i = 1; i <= tentativas; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "pt-BR,pt;q=0.9" } });
      if (r.status === 403 || r.status === 429) throw new Error(`HTTP ${r.status} (acesso bloqueado ou limitado)`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      erro = e;
      await dorme(1500 * i);
    }
  }
  throw new Error(`${url}: ${erro.message}`);
}

export const paraNumero = (txt) => {
  const m = /(\d[\d.]*,?\d*)/.exec(String(txt || ""));
  if (!m) return NaN;
  return parseFloat(m[1].replace(/\./g, "").replace(",", "."));
};

export const idDoLink = (href) => (/_(\d+)\/?$/.exec(href || "") || [])[1] || null;

// Lista de resultados: devolve [{id, href, nome, img}]
export function lerListagem(html) {
  const $ = cheerio.load(html);
  const itens = [];
  $(".promocao-produtos-item-text").each((_, el) => {
    const a = $(el).find(".promocao-item-nome a").first();
    const href = a.attr("href");
    const id = idDoLink(href);
    if (!id) return;
    const im = $(el).find("img").first();
    let img = im.attr("data-src") || im.attr("src") || "";
    if (/loading-images|\.svg$/.test(img)) img = im.attr("data-src") || "";
    itens.push({ id, href, nome: a.text().trim().replace(/^Perfume\s+/i, ""), img: img || null });
  });
  const m = /\(\s*([\d.]+)\s*Resultados/i.exec($("body").text());
  const total = m ? Number(m[1].replace(/\./g, "")) : null;
  return { itens, total };
}

// Página do produto: devolve ofertas [{loja, usd, cod}] (todas as lojas)
export function lerOfertas(html) {
  const $ = cheerio.load(html);
  const ofertas = [];
  $(".promocao-produtos-item-text").each((_, el) => {
    const bloco = $.html(el);
    const mLoja = /advertiser(?:'|&#39;|&apos;|")\s*:\s*(?:'|&#39;|&apos;|")(.*?)(?:'|&#39;|&apos;|")\s*[,}]/.exec(bloco);
    if (!mLoja) return;
    const precoTxt = $(el).find(".promocao-item-preco-oferta strong, .promocao-item-preco-oferta span").first().text();
    const usd = paraNumero(precoTxt);
    if (!usd) return;
    const cod = (/Código:\s*(\S+)/.exec($(el).text()) || [])[1] || "";
    ofertas.push({ loja: mLoja[1].trim(), usd, cod });
  });
  return ofertas;
}

export function lerCotacao(html) {
  const txt = cheerio.load(html)("body").text().replace(/\s+/g, " ");
  const m = /Cota[çc][ãa]o do D[óo]lar\s*R\$\s*([\d.,]+)/i.exec(txt);
  return m ? paraNumero(m[1]) : null;
}

// Lê o modo em scraper/modo.json (ou variáveis MODO / QUANTIDADE):
//   { "modo": "top", "quantidade": 200 }  -> os N perfumes mais procurados que as lojas têm
//   { "modo": "todos" }                    -> todos os perfumes das lojas de lojas.json
function lerModo() {
  let m = { modo: "top", quantidade: 200 };
  try { m = { ...m, ...JSON.parse(readFileSync(join(AQUI, "modo.json"), "utf8")) }; } catch {}
  if (process.env.MODO) m.modo = process.env.MODO;
  if (process.env.QUANTIDADE) m.quantidade = Number(process.env.QUANTIDADE);
  return m;
}

// Executa tarefas com no máximo N em paralelo, mantendo a ordem dos resultados.
async function emParalelo(itens, n, fn) {
  const res = new Array(itens.length);
  let prox = 0;
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, async () => {
    while (prox < itens.length) {
      const k = prox++;
      res[k] = await fn(itens[k], k);
    }
  }));
  return res;
}

async function principal() {
  const inicio = Date.now();
  const { modo, quantidade } = lerModo();
  const nomes = LOJAS.map((l) => l.nome);
  const CONC = Number(process.env.CONCORRENCIA || 3);
  console.log(`Fonte: ${BASE} | modo: ${modo}${modo === "top" ? " " + quantidade : ""} | lojas (por prioridade): ${nomes.join(", ")}`);

  const totaisPorLoja = {};
  let erros = 0;
  const ofertasDe = async (c) => {
    try {
      const ofertas = lerOfertas(await baixar(`${BASE}${c.href.startsWith("/") ? "" : "/"}${c.href}`));
      const melhor = {};
      for (const o of ofertas) {
        const k = nomes.indexOf(o.loja);
        if (k < 0) continue;
        if (!melhor[k] || o.usd < melhor[k][0]) melhor[k] = [o.usd, o.cod];
      }
      const o = Object.entries(melhor).map(([k, [usd, cod]]) => [Number(k), usd, cod]);
      return o.length ? { n: c.nome, i: c.img, o } : null;
    } catch (e) {
      erros++;
      console.warn("  falhou:", c.nome, e.message);
      return null;
    } finally {
      await dorme(ESPERA_MS);
    }
  };

  let produtos = [];
  if (modo === "todos") {
    // 1) candidatos: todas as páginas de cada loja, na ordem de prioridade
    const candidatos = new Map();
    for (const loja of LOJAS) {
      for (let p = 1; p <= 2000; p++) {
        const { itens, total } = lerListagem(await baixar(`${BASE}/perfume/?page=${p}&loja=${loja.slug}`));
        if (p === 1) totaisPorLoja[loja.nome] = total;
        if (!itens.length) break;
        for (const it of itens) if (!candidatos.has(it.id)) candidatos.set(it.id, it);
        await dorme(ESPERA_MS);
      }
      console.log(`  ${loja.nome}: ${totaisPorLoja[loja.nome] ?? "?"} perfumes | candidatos até agora: ${candidatos.size}`);
    }
    // 2) ofertas de cada um
    const lista = [...candidatos.values()];
    let feitos = 0;
    const res = await emParalelo(lista, CONC, async (c) => {
      const r = await ofertasDe(c);
      if (++feitos % 100 === 0) console.log(`  ${feitos}/${lista.length} lidos...`);
      return r;
    });
    produtos = res.filter(Boolean);
  } else {
    // modo "top": percorre a lista geral por relevância até juntar N perfumes que as lojas tenham
    const vistos = new Set();
    for (let p = 1; p <= 200 && produtos.length < quantidade; p++) {
      const { itens, total } = lerListagem(await baixar(`${BASE}/perfume/?page=${p}`));
      if (p === 1) totaisPorLoja.geral = total;
      if (!itens.length) break;
      const novos = itens.filter((it) => !vistos.has(it.id));
      novos.forEach((it) => vistos.add(it.id));
      const res = await emParalelo(novos, CONC, ofertasDe);
      for (const r of res) if (r && produtos.length < quantidade) produtos.push(r);
      console.log(`  página ${p}: ${produtos.length}/${quantidade}`);
      await dorme(ESPERA_MS);
    }
  }

  // cotação do dólar mostrada no site
  let cotacao = null;
  try {
    cotacao = lerCotacao(await baixar(`${BASE}/`));
  } catch (e) {
    console.warn("  cotação não lida:", e.message);
  }

  if (produtos.length < MINIMO_OK) {
    throw new Error(`Só ${produtos.length} produtos coletados (mínimo ${MINIMO_OK}); mantendo o data.json anterior.`);
  }
  if (!cotacao && existsSync(SAIDA)) {
    try { cotacao = JSON.parse(readFileSync(SAIDA, "utf8")).cotacao ?? null; } catch {}
  }

  mkdirSync(dirname(SAIDA), { recursive: true });
  writeFileSync(
    SAIDA,
    JSON.stringify({ atualizadoEm: new Date().toISOString(), modo, cotacao, lojas: nomes, totaisPorLoja, produtos })
  );
  console.log(`OK: ${produtos.length} perfumes, ${erros} erros, ${Math.round((Date.now() - inicio) / 1000)}s. Cotação: ${cotacao}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  principal().catch((e) => {
    console.error("ERRO:", e.message);
    process.exit(1);
  });
}
