// Teste do coletor contra um servidor falso que imita o HTML do ComprasParaguai.
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const AQUI = dirname(fileURLToPath(import.meta.url));
const SAIDA = join(AQUI, "teste-saida.json");

const card = (id, nome, usd) => `
<div class="promocao-produtos-item-text"><div class="promocao-item-img"><a href="/perfume-${id}_${({asad:1001,yara:1002,raro:1003})[id]}/">
<img src="/static/images/loading-images.svg" data-src="https://img.exemplo/${id}.png" class="lozad"></a></div>
<div class="promocao-item-info"><div class="promocao-item-nome"><a href="/perfume-${id}_${({asad:1001,yara:1002,raro:1003})[id]}/">Perfume ${nome}</a></div></div>
<div class="promocao-item-preco-oferta"><div class="price-model"><span> US$&nbsp;${usd}<br></span></div></div></div>`;

const oferta = (loja, usd, cod) => `
<div class="promocao-produtos-item-text"><div class="promocao-item-nome"><a href="/x/">Item da loja</a></div>
<div class="promocao-item-caracteristicas"> Código: ${cod} </div>
<a onclick="gtag( 'event', 'add_to_wishlist', { 'description': 'Adição', 'product': 'X', 'advertiser': '${loja}' } )">w</a>
<div class="promocao-item-preco-oferta flex column"><span><strong>US$ ${usd}</strong></span><div>R$ 1,00</div></div></div>`;

const PRODUTOS = {
  asad: ["Lattafa Asad Eau de Parfum Masculino 100ML", "1.225,00"],
  yara: ["Lattafa Yara Eau de Parfum Feminino 100ML", "19,50"],
  raro: ["Perfume Sem Oferta Nas Lojas 100ML", "50,00"],
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (u.pathname === "/perfume/") {
    const p = Number(u.searchParams.get("page") || 1);
    if (p > 1) return res.end("<body>(2 Resultados</body>");
    const itens = Object.entries(PRODUTOS).map(([id, [n, usd]]) => card(id, n.replace(/^Perfume /, ""), usd)).join("");
    return res.end(`<body><h1>PERFUME (3 Resultados)</h1>${itens}</body>`);
  }
  if (u.pathname.startsWith("/perfume-asad")) {
    return res.end(`<body>${oferta("Cellshop", "21,00", "111")}${oferta("Nissei", "19,5", "222")}${oferta("Nissei", "20,00", "223")}${oferta("Outra Loja", "5,00", "9")}</body>`);
  }
  if (u.pathname.startsWith("/perfume-yara")) {
    return res.end(`<body>${oferta("Mega Eletrônicos", "18,00", "333")}</body>`);
  }
  if (u.pathname.startsWith("/perfume-raro")) {
    return res.end(`<body>${oferta("Loja Desconhecida", "10,00", "444")}</body>`);
  }
  if (u.pathname === "/") return res.end("<body><div>Cotação do Dólar</div><span>R$ 5,65</span></body>");
  res.statusCode = 404;
  res.end("nao");
});

await new Promise((r) => server.listen(0, r));
const porta = server.address().port;

const rodar = (extra) => new Promise((resolve) => {
  const f = spawn("node", [join(AQUI, "scrape.mjs")], {
    env: { ...process.env, BASE_URL: `http://127.0.0.1:${porta}`, SAIDA, MINIMO_OK: "1", ESPERA_MS: "1", ...extra },
  });
  let stdout = "", stderr = "";
  f.stdout.on("data", (b) => (stdout += b));
  f.stderr.on("data", (b) => (stderr += b));
  f.on("close", (status) => resolve({ status, stdout, stderr }));
});

// modo "top" limitado a 1: deve parar no primeiro perfume que as lojas tenham
let r = await rodar({ MODO: "top", QUANTIDADE: "1" });
assert.equal(r.status, 0, r.stderr);
assert.equal(JSON.parse(readFileSync(SAIDA, "utf8")).produtos.length, 1, "modo top deve respeitar a quantidade");
rmSync(SAIDA);

// modo "todos"
r = await rodar({ MODO: "todos" });
server.close();
console.log(r.stdout + r.stderr);
const d = JSON.parse(readFileSync(SAIDA, "utf8"));
rmSync(SAIDA);
assert.equal(d.cotacao, 5.65);
assert.equal(d.produtos.length, 2, "produto sem oferta nas lojas deve ser descartado");
const asad = d.produtos.find((p) => p.n.startsWith("Lattafa Asad"));
const nomes = d.lojas;
// Cellshop 21, Nissei = menor entre 19.5 e 20
assert.deepEqual(asad.o.map(([k, u, c]) => [nomes[k], u, c]).sort(), [["Cellshop", 21, "111"], ["Nissei", 19.5, "222"]].sort());
assert.equal(asad.i, "https://img.exemplo/asad.png");
const yara = d.produtos.find((p) => p.n.startsWith("Lattafa Yara"));
assert.deepEqual(yara.o.map(([k, u, c]) => [nomes[k], u, c]), [["Mega Eletrônicos", 18, "333"]]);
console.log("TESTE OK");
