// Gera site/data.json público a partir de scraper/bruto.json.
// Só sai: atualizadoEm e, por produto, { n: nome, i: foto, p: preço final em R$, r: referência, a: data do preço }.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AQUI, caminho, lerJson, gravarJson, parametrosPreco, produtoPublico } from "./comum.mjs";

export function publicar({ saida = process.env.SAIDA || join(AQUI, "..", "site", "data.json"), log = console.log } = {}) {
  const bruto = lerJson(caminho("bruto.json"));
  const preco = parametrosPreco();
  const cotacao = preco.cotacaoFixa || bruto.cotacao;
  if (!cotacao) throw new Error("sem cotação (nem lida, nem COTACAO_FIXA)");
  const produtos = bruto.produtos.map((p) => produtoPublico(p, cotacao, preco)).filter(Boolean);
  gravarJson(saida, { atualizadoEm: new Date().toISOString(), produtos });
  log(`Publicado: ${produtos.length} perfumes em ${saida}`);
  return produtos.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { publicar(); } catch (e) { console.error("ERRO:", e.message); process.exit(1); }
}
