// Gera site/data.json público a partir de scraper/bruto.json.
// Só sai: atualizadoEm e, por produto, { n: nome, i: foto, p: preço final em R$, r: referência, a: data do preço,
// h: posição no "em alta" do dia (só nos que estão em alta) }.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AQUI, caminho, lerJson, gravarJson, parametrosPreco, produtoPublico, normalizar, dias, hoje } from "./comum.mjs";

export function publicar({ saida = process.env.SAIDA || join(AQUI, "..", "site", "data.json"), log = console.log } = {}) {
  const bruto = lerJson(caminho("bruto.json"));
  const preco = parametrosPreco();
  const cotacao = preco.cotacaoFixa || bruto.cotacao;
  if (!cotacao) throw new Error("sem cotação (nem lida, nem COTACAO_FIXA)");
  // "em alta" vale por até 2 dias (se a coleta falhar um dia, a vitrine não some)
  const alta = bruto.alta && dias(bruto.alta.dia, hoje()) <= 2 ? bruto.alta.itens : [];
  const porId = new Map(alta.map((x, i) => [String(x.id), i + 1]));
  const porNome = new Map(alta.map((x, i) => [x.n, i + 1]));
  const produtos = bruto.produtos.map((p) => {
    const pub = produtoPublico(p, cotacao, preco);
    if (!pub) return null;
    const h = porId.get(String(p.id)) || porNome.get(normalizar(p.n));
    if (h) pub.h = h;
    return pub;
  }).filter(Boolean);
  gravarJson(saida, { atualizadoEm: new Date().toISOString(), produtos });
  log(`Publicado: ${produtos.length} itens em ${saida} (${produtos.filter((p) => p.h).length} em alta)`);
  return produtos.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { publicar(); } catch (e) { console.error("ERRO:", e.message); process.exit(1); }
}
