// Testes do coletor, da publicação, da criptografia e do serviço de busca contra um servidor falso
// que imita o HTML da fonte de preços. Não acessa a internet.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const AQUI = dirname(fileURLToPath(import.meta.url));
const LOJAS = [
  { slug: "loja-alfa", nome: "Loja Alfa", frequenciaDias: 1 },
  { slug: "loja-beta", nome: "Loja Beta", frequenciaDias: 7 },
];
const HOJE = "2026-11-20";
const CHAVE = randomBytes(32).toString("hex");

// ---------- servidor falso ----------
const oferta = (loja, usd, cod, nome = "Item") => `
<div class="promocao-produtos-item-text"><div class="promocao-item-nome"><a href="/x__1/">${nome}</a></div>
<div class="promocao-item-caracteristicas"> Código: ${cod} </div>
<a onclick="gtag( 'event', 'add_to_wishlist', { 'product': 'X', 'advertiser': '${loja}' } )">w</a>
<div class="promocao-item-preco-oferta flex column"><span><strong>US$ ${usd}</strong></span><div>R$ 1,00</div></div></div>`;
const modelo = (href, nome) => `
<div class="promocao-produtos-item-text"><img src="/static/images/loading-images.svg" data-src="https://img.exemplo${href}.png">
<div class="promocao-item-nome"><a href="${href}">Perfume ${nome}</a></div></div>`;
const pagina = (total, corpo) => `<body><h1>(${total} Resultados)</h1>${corpo}</body>`;

let modo = "normal";
const pedidos = [], alertas = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "POST" && u.pathname === "/message/sendText/teste") {
    let corpo = "";
    req.on("data", (b) => (corpo += b));
    return req.on("end", () => { alertas.push({ chave: req.headers.apikey, ...JSON.parse(corpo) }); res.end("{}"); });
  }
  pedidos.push(u.pathname + u.search);
  res.setHeader("content-type", "text/html; charset=utf-8");
  const fim = (html) => res.end(html);
  if (u.pathname === "/") return fim("<body><div>Cotação do Dólar</div><span>R$ 5,65</span></body>");
  if (u.pathname === "/busca/") {
    if (modo === "429") { res.statusCode = 429; return fim("devagar"); }
    const q = u.searchParams.get("q"), loja = u.searchParams.get("loja"), pag = Number(u.searchParams.get("page") || 1);
    if (!loja && q === "asad") {
      // ofertas soltas (sem modelo): kit da nossa loja entra; creme e loja de fora não
      const solta = (href, loja, usd, cod, nome) => oferta(loja, usd, cod, nome).replace('href="/x__1/"', `href="${href}"`);
      return fim(pagina(6, modelo("/creme-corporal-asad_9006/", "Creme Asad") + modelo("/perfume-marca-x_5001/", "Marca X Masculino 100ML") + modelo("/kit-perfume-asad-duo_9005/", "Kit Asad Duo Masculino")
        + solta("/kit-asad-trio-100ml__7001/", "Loja Alfa", "40,00", "777", "Kit Perfume Asad Trio Edp 100ML")
        + solta("/creme-asad__7002/", "Loja Alfa", "9,00", "778", "Creme Corporal Asad 280g")
        + solta("/kit-asad-outra__7003/", "Outra Loja", "30,00", "779", "Kit Perfume Asad Outra Edp")));
    }
    if (loja === "loja-alfa" && q === "perfume masculino" && pag === 1) {
      return fim(pagina(2, oferta("Loja Alfa", "18,50", "111") + oferta("Loja Alfa", "10,00", "999", "Perfume Desconhecido")));
    }
    return fim(pagina(0, ""));
  }
  if (u.pathname === "/perfume/") {
    const loja = u.searchParams.get("loja");
    if (loja === "loja-alfa") return fim(pagina(4, modelo("/creme-corporal-y_9004/", "Creme") + modelo("/perfume-marca-x_5001/", "Marca X Masculino 100ML") + modelo("/perfume-novo-um_9001/", "Novo Um Feminino 100ML") + modelo("/perfume-novo-dois_9002/", "Novo Dois 100ML")));
    if (loja === "loja-beta") return fim(pagina(1, modelo("/perfume-novo-dois_9002/", "Novo Dois 100ML")));
    return fim(pagina(0, ""));
  }
  if (u.pathname === "/perfume-novo-um_9001/") return fim(`<body>${oferta("Loja Alfa", "25,00", "333")}${oferta("Outra Loja", "5,00", "1")}${oferta("Loja Beta", "27,00", "444")}</body>`);
  if (u.pathname === "/kit-perfume-asad-duo_9005/") return fim(`<body>${oferta("Loja Beta", "30,00", "555")}</body>`);
  res.statusCode = 404;
  fim("não");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const FONTE = `http://127.0.0.1:${server.address().port}`;

// ---------- utilitários ----------
const dir = mkdtempSync(join(tmpdir(), "catalogo-teste-"));
const arq = (n) => join(dir, n);
const ler = (n) => JSON.parse(readFileSync(arq(n), "utf8"));
const grava = (n, o) => writeFileSync(arq(n), JSON.stringify(o));
const ENV = { DADOS_DIR: dir, FONTE_URL: FONTE, ESPERA_MS: "1", HOJE, DADOS_CHAVE: CHAVE, MARGEM: "0.35", ACRESCIMO_COTACAO: "0.05", DESCOBERTOS: arq("descobertos.json"),
  EVOLUTION_URL: FONTE, EVOLUTION_INSTANCIA: "teste", EVOLUTION_APIKEY: "chave-teste", ALERTA_NUMERO: "5541000000000" };
const rodar = (script, args = [], extra = {}) => new Promise((resolve) => {
  const f = spawn(process.execPath, [join(AQUI, script), ...args], { env: { ...process.env, ...ENV, ...extra } });
  let out = "";
  f.stdout.on("data", (b) => (out += b));
  f.stderr.on("data", (b) => (out += b));
  f.on("close", (status) => resolve({ status, out }));
});
const produtoX = () => ({ id: "5001", n: "Marca X Masculino 100ML", i: null, o: [[0, 20, "111", "2026-11-01"], [1, 30, "222", "2026-11-10"]] });
let ok = 0;
const passo = (nome) => console.log(`✔ ${nome}`) || ok++;

try {
  grava("lojas.json", LOJAS);

  // 1. casamento por lojaIdx:cod + agenda por loja + fila de novos
  grava("bruto.json", { versao: 1, cotacao: 5, produtos: [produtoX()] });
  grava("estado.json", { varredura: { "loja-alfa": "2026-11-15", "loja-beta": "2026-11-18" }, novos: "2026-11-19" });
  pedidos.length = 0;
  let r = await rodar("scrape.mjs");
  assert.equal(r.status, 0, r.out);
  let b = ler("bruto.json"), e = ler("estado.json");
  assert.deepEqual(b.produtos[0].o, [[0, 18.5, "111", HOJE], [1, 30, "222", "2026-11-10"]], "oferta conhecida atualiza usd e t");
  assert.equal(b.produtos.length, 1, "oferta desconhecida não entra no catálogo");
  assert.ok(e.fila.some((f) => f.k === "0:999"), "oferta desconhecida vai para a fila");
  assert.equal(b.cotacao, 5.65);
  passo("casamento por lojaIdx:cod (preço e data atualizados; desconhecida vai para a fila)");
  assert.ok(!pedidos.some((p) => p.includes("loja=loja-beta")), "loja semanal não vencida não é varrida");
  assert.equal(e.varredura["loja-alfa"], HOJE);
  assert.equal(e.varredura["loja-beta"], "2026-11-18");
  assert.ok(!pedidos.some((p) => p.startsWith("/perfume/")), "sem busca de novos fora da semana");
  assert.match(r.out, /Pedidos: \d+ \| [\d.]+ MB/);
  assert.match(r.out, /cobertura do catálogo 1\/1 \(100\.0%\)/);
  passo("agenda por loja (só a loja vencida; imprime pedidos, MB, tempo e cobertura)");

  // 2. perfumes novos (semanal): só modelos fora do catálogo, perfumes, no máximo MAX_NOVOS
  grava("estado.json", { varredura: { "loja-alfa": HOJE, "loja-beta": "2026-11-19" }, novos: "2026-11-10" });
  pedidos.length = 0;
  r = await rodar("scrape.mjs", [], { MAX_NOVOS: "1" });
  assert.equal(r.status, 0, r.out);
  b = ler("bruto.json");
  const novo = b.produtos.find((p) => p.id === "9001");
  assert.ok(novo, "modelo novo entra no catálogo");
  assert.deepEqual(novo.o, [[0, 25, "333", HOJE], [1, 27, "444", HOJE]], "ofertas [lojaIdx, usd, cod, t] só das nossas lojas");
  assert.ok(!pedidos.includes("/perfume-marca-x_5001/"), "modelo já conhecido não é aberto");
  assert.ok(!pedidos.some((p) => p.includes("creme")), "item que não é perfume é ignorado");
  assert.ok(!pedidos.includes("/perfume-novo-dois_9002/"), "respeita MAX_NOVOS");
  assert.equal(ler("estado.json").novos, HOJE);
  passo("perfumes novos (ignora conhecidos e não-perfumes, respeita o limite)");

  // 3. HTTP 429: para na hora, sai com 0, ::warning::, dados anteriores mantidos
  grava("estado.json", { varredura: { "loja-alfa": "2026-11-15", "loja-beta": "2026-11-19" }, novos: "2026-11-19" });
  const antesB = readFileSync(arq("bruto.json")), antesE = readFileSync(arq("estado.json"));
  modo = "429";
  r = await rodar("scrape.mjs");
  modo = "normal";
  assert.equal(r.status, 0, "429 sai com código 0");
  assert.match(r.out, /::warning::/);
  assert.ok(readFileSync(arq("bruto.json")).equals(antesB) && readFileSync(arq("estado.json")).equals(antesE), "nada gravado");
  passo("429 (::warning::, código 0, dados mantidos)");
  assert.equal(alertas.length, 1, "um aviso no bloqueio");
  assert.equal(alertas[0].chave, "chave-teste");
  assert.equal(alertas[0].number, "5541000000000");
  assert.ok(alertas[0].text.includes("bloqueou a coleta (HTTP 429"), alertas[0].text);
  passo("aviso por WhatsApp no bloqueio (apikey, número e texto)");

  // leitura muito abaixo da anterior -> aviso
  alertas.length = 0;
  grava("estado.json", { varredura: { "loja-alfa": "2026-11-15", "loja-beta": "2026-11-19" }, novos: "2026-11-19", lidas: { "loja-alfa": 200 } });
  r = await rodar("scrape.mjs");
  assert.equal(r.status, 0, r.out);
  assert.equal(alertas.length, 1, r.out);
  assert.ok(alertas[0].text.includes("Loja Alfa: só 2 ofertas lidas (na vez anterior: 200)"), alertas[0].text);
  assert.equal(ler("estado.json").lidas["loja-alfa"], 2);
  passo("aviso quando a leitura cai para menos da metade (possível mudança no site)");

  // 4. serviço de busca: devolve só campos públicos, aceita kit, ignora creme, guarda descobertos
  Object.assign(process.env, ENV, { ESPERA_API_MS: "1" });
  const { criarServico } = await import("../server/api.mjs");
  const api = criarServico();
  await new Promise((ok2) => api.listen(0, "127.0.0.1", ok2));
  const URL_API = `http://127.0.0.1:${api.address().port}`;
  const resp = await (await fetch(`${URL_API}/buscar?q=asad`)).json();
  assert.equal((await fetch(`${URL_API}/buscar?q=ab`)).status, 400);
  api.close();
  assert.equal(resp.produtos.length, 3, JSON.stringify(resp));
  for (const p of resp.produtos) assert.deepEqual(Object.keys(p).sort(), ["a", "i", "n", "p", "r"]);
  assert.ok(resp.produtos.some((p) => p.n.startsWith("Kit Asad") && p.r === "1-555"));
  assert.ok(resp.produtos.some((p) => p.n === "Kit Perfume Asad Trio Edp 100ML" && p.r === "0-777"), "kit em oferta solta entra");
  assert.ok(!resp.produtos.some((p) => /Creme|Outra/.test(p.n)), "creme e loja de fora ficam de fora");
  assert.ok(!JSON.stringify(resp).match(/Loja|US\$|usd|margem/i));
  assert.deepEqual(ler("descobertos.json").map((p) => p.id).sort(), ["9005", "o7001"]);
  passo("busca sob demanda (só n/i/p/r/a; kit entra, creme não; guarda o achado)");

  // coleta seguinte junta os descobertos ao catálogo
  grava("estado.json", { varredura: { "loja-alfa": HOJE, "loja-beta": HOJE }, novos: HOJE });
  r = await rodar("scrape.mjs");
  assert.equal(r.status, 0, r.out);
  assert.ok(ler("bruto.json").produtos.some((p) => p.id === "9005"));
  assert.ok(!existsSync(arq("descobertos.json")));
  passo("coleta incorpora os perfumes achados pela busca");

  // cotação a cada 3 h: 1 pedido; só republica se mudou; ignora leitura absurda
  const comCotacao = (c) => { const b2 = ler("bruto.json"); b2.cotacao = c; grava("bruto.json", b2); };
  const SAIDA_C = { SAIDA: arq("data-cotacao.json") };
  comCotacao(5.65); pedidos.length = 0;
  r = await rodar("cotacao.mjs", [], SAIDA_C);
  assert.match(r.out, /sem mudança/); assert.equal(pedidos.length, 1); assert.ok(!existsSync(arq("data-cotacao.json")));
  comCotacao(5.5);
  r = await rodar("cotacao.mjs", [], SAIDA_C);
  assert.match(r.out, /5\.5 -> R\$ 5\.65/); assert.equal(ler("bruto.json").cotacao, 5.65); assert.ok(existsSync(arq("data-cotacao.json")));
  comCotacao(8);
  r = await rodar("cotacao.mjs", [], SAIDA_C);
  assert.match(r.out, /ignorada/); assert.equal(ler("bruto.json").cotacao, 8);
  comCotacao(5.65);
  passo("cotação a cada 3 h (1 pedido; republica só se mudou; ignora leitura absurda)");

  // 5. criptografia ida e volta
  const original = readFileSync(arq("bruto.json"));
  r = await rodar("cripto.mjs", ["cifrar"]);
  assert.equal(r.status, 0, r.out);
  const enc = readFileSync(arq("bruto.enc"));
  assert.ok(!enc.includes("Loja Alfa") && !enc.includes("Marca X") && !enc.includes("111"), "cifrado não tem texto puro");
  assert.ok(existsSync(arq("lojas.enc")) && existsSync(arq("estado.enc")));
  rmSync(arq("bruto.json"));
  r = await rodar("cripto.mjs", ["decifrar"]);
  assert.ok(readFileSync(arq("bruto.json")).equals(original), "ida e volta igual");
  r = await rodar("cripto.mjs", ["cifrar"]);
  assert.match(r.out, /bruto: sem mudança/);
  r = await rodar("cripto.mjs", ["decifrar"], { DADOS_CHAVE: randomBytes(32).toString("hex") });
  assert.notEqual(r.status, 0, "chave errada não decifra");
  passo("criptografia AES-256-GCM (ida e volta, chave errada falha, sem regravar sem mudança)");

  // 6. data.json público: preço final, referência, data; sem US$, lojas ou margem
  r = await rodar("publicar.mjs", [], { SAIDA: arq("data.json") });
  assert.equal(r.status, 0, r.out);
  const txt = readFileSync(arq("data.json"), "utf8"), pub = JSON.parse(txt);
  const x = pub.produtos.find((p) => p.n.startsWith("Marca X"));
  assert.equal(x.p, Math.ceil(18.5 * 5.65 * 1.05 * 1.35), "p = ceil(usd × cotação × 1,05 × 1,35)");
  assert.equal(x.r, "0-111,1-222");
  assert.equal(x.a, HOJE);
  assert.deepEqual(Object.keys(pub).sort(), ["atualizadoEm", "produtos"]);
  for (const p of pub.produtos) assert.deepEqual(Object.keys(p).sort(), ["a", "i", "n", "p", "r"]);
  for (const proibido of ["US$", "usd", "Loja Alfa", "Loja Beta", "margem", "0.35", "cotacao"]) assert.ok(!txt.includes(proibido), `data.json contém "${proibido}"`);
  passo(`data.json público (p=${x.p}, r=${x.r}; sem US$, lojas, margem ou cotação)`);

  console.log(`\nTESTE OK (${ok} verificações)`);
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
