// Atualização leve da cotação do dólar (1 pedido). Se mudou, grava em bruto.json e republica site/data.json.
// Proteções: ignora variação maior que VARIACAO_MAX (padrão 15%) em relação à anterior (provável erro de leitura);
// 403/429: não grava nada, sai com 0 (a coleta diária é quem avisa por WhatsApp).
import { fileURLToPath } from "node:url";
import { caminho, lerJson, gravarJson, criarCliente, Bloqueio, lerCotacao, hoje, parametrosPreco } from "./comum.mjs";
import { publicar } from "./publicar.mjs";

const VARIACAO_MAX = Number(process.env.VARIACAO_MAX || 0.15);

export async function atualizarCotacao({ cliente = criarCliente(), log = console.log } = {}) {
  if (parametrosPreco().cotacaoFixa) { log("COTACAO_FIXA definida: nada a fazer"); return { mudou: false }; }
  const bruto = lerJson(caminho("bruto.json"));
  let nova;
  try {
    nova = lerCotacao((await cliente.get("/")).html);
  } catch (e) {
    if (e instanceof Bloqueio) { log(`::warning::Fonte respondeu ${e.message}; cotação mantida em ${bruto.cotacao}.`); return { mudou: false, bloqueio: true }; }
    throw e;
  }
  const antiga = bruto.cotacao;
  if (!nova) { log(`::warning::Cotação não encontrada na página; mantida em ${antiga}.`); return { mudou: false }; }
  if (antiga && Math.abs(nova - antiga) / antiga > VARIACAO_MAX) {
    log(`::warning::Cotação lida (${nova}) varia mais de ${VARIACAO_MAX * 100}% da anterior (${antiga}); ignorada.`);
    return { mudou: false };
  }
  if (nova === antiga) { log(`Cotação sem mudança: R$ ${nova}`); return { mudou: false }; }
  bruto.cotacao = nova;
  bruto.cotacaoEm = hoje();
  gravarJson(caminho("bruto.json"), bruto);
  log(`Cotação: R$ ${antiga} -> R$ ${nova}`);
  publicar({ log });
  return { mudou: true, antiga, nova };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  atualizarCotacao().catch((e) => { console.error("ERRO:", e.message); process.exitCode = 1; });
}
