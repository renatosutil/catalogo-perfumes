// Funções compartilhadas pelo coletor, pela publicação e pelo serviço de busca.
// O endereço da fonte de preços vem da variável FONTE_URL (não fica no código).
import * as cheerio from "cheerio";
import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const AQUI = dirname(fileURLToPath(import.meta.url));
export const DADOS_DIR = process.env.DADOS_DIR || AQUI;
export const UA = "Mozilla/5.0 (compatible; CatalogoPerfumes/1.0)";
export const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- datas (dia no fuso de Brasília, "AAAA-MM-DD") ----------
export const hoje = () =>
  process.env.HOJE || new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
export const dias = (de, ate) => (de ? Math.round((Date.parse(ate) - Date.parse(de)) / 864e5) : Infinity);

// ---------- arquivos JSON ----------
export const caminho = (nome) => join(DADOS_DIR, nome);
export function lerJson(arq, padrao) {
  if (!existsSync(arq)) {
    if (padrao !== undefined) return padrao;
    throw new Error(`arquivo não encontrado: ${arq}`);
  }
  return JSON.parse(readFileSync(arq, "utf8"));
}
export function gravarJson(arq, obj) {
  mkdirSync(dirname(arq), { recursive: true });
  const tmp = arq + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, arq);
}
export const lerLojas = () => lerJson(caminho("lojas.json"));

// ---------- criptografia (AES-256-GCM, chave derivada de DADOS_CHAVE) ----------
const MAGICO = Buffer.from("CPE1");
function chave() {
  const h = process.env.DADOS_CHAVE || "";
  if (!/^[0-9a-f]{64}$/i.test(h)) throw new Error("DADOS_CHAVE ausente ou inválida (precisa de 64 caracteres hex)");
  return Buffer.from(hkdfSync("sha256", Buffer.from(h, "hex"), Buffer.alloc(0), "catalogo-perfumes/dados/v1", 32));
}
export function cifrar(buf) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", chave(), iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGICO, iv, c.getAuthTag(), ct]);
}
export function decifrar(buf) {
  if (!buf.subarray(0, 4).equals(MAGICO)) throw new Error("arquivo cifrado em formato desconhecido");
  const d = createDecipheriv("aes-256-gcm", chave(), buf.subarray(4, 16));
  d.setAuthTag(buf.subarray(16, 32));
  return Buffer.concat([d.update(buf.subarray(32)), d.final()]);
}

// ---------- cliente educado: 1 pedido por vez, pausa com sorteio, para no 403/429 ----------
export class Bloqueio extends Error {
  constructor(status, url) {
    super(`HTTP ${status} em ${url}`);
    this.status = status;
  }
}
export class LimitePedidos extends Error {}

export function criarCliente({
  base = process.env.FONTE_URL,
  esperaMs = Number(process.env.ESPERA_MS ?? 10000),
  sorteio = 0.5,
  maxPedidos = Number(process.env.MAX_PEDIDOS || Infinity),
} = {}) {
  if (!base) throw new Error("FONTE_URL não definida");
  base = base.replace(/\/$/, "");
  let pedidos = 0, bytes = 0, ultimo = 0, fila = Promise.resolve();
  const umPedido = async (path) => {
    if (pedidos >= maxPedidos) throw new LimitePedidos(`limite de ${maxPedidos} pedidos atingido`);
    const espera = ultimo + esperaMs * (1 + Math.random() * sorteio) - Date.now();
    if (ultimo && espera > 0) await dorme(espera);
    const url = base + (path.startsWith("/") ? path : "/" + path);
    let erro;
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      try {
        pedidos++;
        const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "pt-BR,pt;q=0.9" } });
        const html = await r.text();
        bytes += Buffer.byteLength(html);
        ultimo = Date.now();
        if (r.status === 403 || r.status === 429) throw new Bloqueio(r.status, path);
        if (!r.ok) throw new Error(`HTTP ${r.status} em ${path}`);
        return { html, url: r.url };
      } catch (e) {
        ultimo = Date.now();
        if (e instanceof Bloqueio || tentativa === 2 || pedidos >= maxPedidos) throw e;
        erro = e;
        await dorme(esperaMs);
      }
    }
    throw erro;
  };
  return {
    // serializa: mesmo com várias chamadas simultâneas, só 1 pedido por vez
    get: (path) => (fila = fila.then(() => umPedido(path), () => umPedido(path))),
    stats: () => ({ pedidos, bytes }),
  };
}

// ---------- leitura das páginas ----------
export const paraNumero = (txt) => {
  const m = /(\d[\d.]*,?\d*)/.exec(String(txt || ""));
  return m ? parseFloat(m[1].replace(/\./g, "").replace(",", ".")) : NaN;
};
const lerTotal = ($) => {
  const m = /\(\s*([\d.]+)\s*Resultados/i.exec($("body").text());
  return m ? Number(m[1].replace(/\./g, "")) : null;
};
const lerAnunciante = (bloco) =>
  ((/advertiser(?:'|&#39;|&apos;|")\s*:\s*(?:'|&#39;|&apos;|")(.*?)(?:'|&#39;|&apos;|")\s*[,}]/.exec(bloco) || [])[1] || "").trim();
const lerCodigo = (txt) => (/C[óo]digo:\s*([^\s|]+)/i.exec(txt) || [])[1] || "";
const lerUsd = ($el) => {
  const t = $el.find(".promocao-item-preco-oferta").text();
  const m = /US\$\s*([\d.,]+)/.exec(t);
  return m ? paraNumero(m[1]) : NaN;
};
const imagem = ($, el) => {
  const im = $(el).find("img").first();
  let img = im.attr("data-src") || im.attr("src") || "";
  if (/loading-images|\.svg$/.test(img)) img = im.attr("data-src") || "";
  return img || null;
};
// modelo = link com "_<id>/" (um sublinhado); oferta isolada usa "__<id>/"
export const idModelo = (href) => (/[^_]_(\d+)\/?$/.exec(href || "") || [])[1] || null;
// tipos de modelo aceitos: perfumes e kits de perfume
export const ehPerfume = (href) => /^\/?(perfume|kit-perfume)-/i.test(href || "");

// busca filtrada por loja: ofertas [{loja, cod, usd, nome}]
export function lerBusca(html) {
  const $ = cheerio.load(html);
  const itens = [];
  $(".promocao-produtos-item-text").each((_, el) => {
    const loja = lerAnunciante($.html(el));
    const cod = lerCodigo($(el).text());
    const usd = lerUsd($(el));
    if (!loja || !cod || !usd) return;
    itens.push({ loja, cod, usd, nome: $(el).find(".promocao-item-nome a").first().text().trim() });
  });
  return { itens, total: lerTotal($) };
}

// listagem/busca geral de modelos: [{id, href, nome, img}]
export function lerModelos(html) {
  const $ = cheerio.load(html);
  const itens = [];
  $(".promocao-produtos-item-text").each((_, el) => {
    const a = $(el).find(".promocao-item-nome a").first();
    const href = a.attr("href");
    const id = idModelo(href);
    if (!id || !ehPerfume(href)) return;
    itens.push({ id, href, nome: a.text().trim().replace(/^Perfume\s+/i, ""), img: imagem($, el) });
  });
  return { itens, total: lerTotal($) };
}

// página do modelo: ofertas de todas as lojas [{loja, usd, cod}]
export function lerOfertas(html) {
  const $ = cheerio.load(html);
  const ofertas = [];
  $(".promocao-produtos-item-text").each((_, el) => {
    const loja = lerAnunciante($.html(el));
    const precoTxt = $(el).find(".promocao-item-preco-oferta strong, .promocao-item-preco-oferta span").first().text();
    const usd = paraNumero(precoTxt);
    if (!loja || !usd) return;
    ofertas.push({ loja, usd, cod: lerCodigo($(el).text()) });
  });
  return ofertas;
}

export function lerCotacao(html) {
  const txt = cheerio.load(html)("body").text().replace(/\s+/g, " ");
  const m = /Cota[çc][ãa]o do D[óo]lar\s*R\$\s*([\d.,]+)/i.exec(txt);
  return m ? paraNumero(m[1]) : null;
}

// ofertas das nossas lojas, a mais barata de cada loja: [[lojaIdx, usd, cod, t]]
export function ofertasDasLojas(ofertas, nomes, t) {
  const melhor = {};
  for (const o of ofertas) {
    const k = nomes.indexOf(o.loja);
    if (k < 0 || !o.cod) continue;
    if (!melhor[k] || o.usd < melhor[k][1]) melhor[k] = [k, o.usd, o.cod, t];
  }
  return Object.values(melhor).sort((a, b) => a[0] - b[0]);
}

export const normalizar = (s) =>
  String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/^perfume\s+/, "").replace(/\s+/g, " ").trim();

// ---------- preço público ----------
export function parametrosPreco() {
  const margem = Number(process.env.MARGEM);
  if (!Number.isFinite(margem)) throw new Error("MARGEM não definida");
  return {
    margem,
    acrescimo: Number(process.env.ACRESCIMO_COTACAO || 0),
    cotacaoFixa: Number(process.env.COTACAO_FIXA) || null,
  };
}
// produto bruto -> { n, i, p, r, a } (sem loja, sem dólar, sem margem)
export function produtoPublico(prod, cotacao, { margem, acrescimo }) {
  const o = (prod.o || []).filter((x) => x && x[1] > 0).sort((a, b) => a[0] - b[0]);
  if (!o.length || !cotacao) return null;
  const ref = o[0];
  const p = Math.ceil(ref[1] * cotacao * (1 + acrescimo) * (1 + margem) - 1e-9);
  return { n: prod.n, i: prod.i || null, p, r: o.map((x) => `${x[0]}-${x[2]}`).join(","), a: ref[3] };
}
