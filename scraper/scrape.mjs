// Coletor leve. Lê scraper/bruto.json e scraper/estado.json (texto puro, fora do git) e:
//  1. varre as buscas por loja das lojas vencidas (agenda em lojas.json, campo frequenciaDias),
//     atualizando preço e data das ofertas já conhecidas (chave lojaIdx:código);
//     ofertas desconhecidas vão para a fila de "novos" e não entram no catálogo nesta varredura;
//  2. 1x por semana, descobre modelos novos nas 10 primeiras páginas de cada loja e abre a página
//     só dos que ainda não estão no catálogo (no máximo MAX_NOVOS);
//  3. junta os perfumes achados pelo serviço de busca (arquivo DESCOBERTOS).
// Se a fonte responder 403/429: para na hora, não grava nada, imprime ::warning:: e sai com código 0.
import { existsSync, renameSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  caminho, lerJson, gravarJson, lerLojas, hoje, dias, criarCliente, Bloqueio, LimitePedidos,
  lerBusca, lerModelos, lerOfertas, lerCotacao, ofertasDasLojas, normalizar,
} from "./comum.mjs";
import { alertar } from "./alerta.mjs";

const TERMOS_PADRAO = ["perfume masculino", "perfume feminino", "perfume unissex"];
const POR_PAGINA = 20;
const MAX_NOVOS = Number(process.env.MAX_NOVOS || 150);
const PAGINAS_NOVOS = Number(process.env.PAGINAS_NOVOS || 10);
const DIAS_NOVOS = 7;

export async function coletar({ cliente = criarCliente(), log = console.log } = {}) {
  const inicio = Date.now();
  const dia = hoje();
  const lojas = lerLojas();
  const nomes = lojas.map((l) => l.nome);
  const termos = lerJson(caminho("termos.json"), TERMOS_PADRAO);
  const bruto = lerJson(caminho("bruto.json"));
  const estado = lerJson(caminho("estado.json"), {});
  estado.varredura ||= {};
  estado.fila ||= [];
  estado.lidas ||= {};
  const avisos = [];
  const soLojas = process.env.SO_LOJAS ? process.env.SO_LOJAS.split(",") : null;
  const naoSalvar = process.env.NAO_SALVAR === "1";

  // índice das ofertas conhecidas: "lojaIdx:cod" -> oferta (array mutável dentro do produto)
  const indice = new Map();
  const ids = new Set(), nomesConhecidos = new Set();
  for (const p of bruto.produtos) {
    if (p.id) ids.add(String(p.id));
    nomesConhecidos.add(normalizar(p.n));
    for (const o of p.o) indice.set(`${o[0]}:${o[2]}`, o);
  }

  // agenda: lojas diárias vencidas + no máximo 1 loja semanal (a mais atrasada)
  const vencidas = lojas
    .map((l, idx) => ({ ...l, idx, freq: Number(l.frequenciaDias || 1), atraso: dias(estado.varredura[l.slug], dia) }))
    .filter((l) => (soLojas ? soLojas.includes(l.slug) : l.atraso >= l.freq));
  const diarias = vencidas.filter((l) => soLojas || l.freq <= 1);
  const semanal = soLojas ? [] : vencidas.filter((l) => l.freq > 1).sort((a, b) => b.atraso - a.atraso).slice(0, 1);
  const varrer = [...diarias, ...semanal];
  const fazerNovos = !soLojas && !semanal.length && dias(estado.novos, dia) >= DIAS_NOVOS;
  log(`Dia ${dia} | lojas a varrer: ${varrer.map((l) => l.nome).join(", ") || "nenhuma"} | perfumes novos: ${fazerNovos ? "sim" : "não"}`);

  const resumo = [];
  const fila = new Map(estado.fila.map((f) => [f.k, f]));
  let cotacao = null, novosAdicionados = 0;
  try {
    cotacao = lerCotacao((await cliente.get("/")).html);

    for (const loja of varrer) {
      const vistos = new Set();
      let atualizadas = 0, desconhecidas = 0;
      for (const termo of termos) {
        for (let pag = 1; pag <= 500; pag++) {
          const q = encodeURIComponent(termo);
          const { itens, total } = lerBusca((await cliente.get(`/busca/?q=${q}&loja=${loja.slug}&page=${pag}`)).html);
          for (const it of itens) {
            if (it.loja !== loja.nome) continue;
            const k = `${loja.idx}:${it.cod}`;
            if (vistos.has(k)) continue;
            vistos.add(k);
            const o = indice.get(k);
            if (o) { o[1] = it.usd; o[3] = dia; atualizadas++; }
            else { desconhecidas++; fila.set(k, { k, n: it.nome, usd: it.usd, t: dia }); }
          }
          if (!itens.length || pag * POR_PAGINA >= (total || 0)) break;
        }
      }
      const doCatalogo = [...indice.keys()].filter((k) => k.startsWith(loja.idx + ":")).length;
      resumo.push({ loja: loja.nome, slug: loja.slug, ofertasLidas: vistos.size, atualizadas, doCatalogo, desconhecidas });
      // leitura muito abaixo da anterior: provável mudança no site da fonte
      const antes = estado.lidas[loja.slug] || 0;
      if (vistos.size === 0 || (antes >= 100 && vistos.size < antes * 0.5)) {
        avisos.push(`${loja.nome}: só ${vistos.size} ofertas lidas (na vez anterior: ${antes}). A fonte pode ter mudado o site.`);
      }
      estado.lidas[loja.slug] = vistos.size;
      estado.varredura[loja.slug] = dia;
    }

    if (fazerNovos) {
      const candidatos = new Map();
      for (const loja of lojas) {
        for (let pag = 1; pag <= PAGINAS_NOVOS; pag++) {
          const { itens, total } = lerModelos((await cliente.get(`/perfume/?page=${pag}&loja=${loja.slug}`)).html);
          for (const m of itens) {
            if (ids.has(m.id) || nomesConhecidos.has(normalizar(m.nome)) || candidatos.has(m.id)) continue;
            candidatos.set(m.id, m);
          }
          if (!itens.length || pag * POR_PAGINA >= (total || 0)) break;
        }
      }
      log(`  modelos fora do catálogo nas ${PAGINAS_NOVOS} primeiras páginas: ${candidatos.size} (abrindo até ${MAX_NOVOS})`);
      for (const m of [...candidatos.values()].slice(0, MAX_NOVOS)) {
        const o = ofertasDasLojas(lerOfertas((await cliente.get(m.href)).html), nomes, dia);
        if (!o.length) continue;
        bruto.produtos.push({ id: m.id, n: m.nome, i: m.img, o });
        ids.add(m.id);
        for (const x of o) { indice.set(`${x[0]}:${x[2]}`, x); fila.delete(`${x[0]}:${x[2]}`); }
        novosAdicionados++;
      }
      estado.novos = dia;
    }
  } catch (e) {
    const s = cliente.stats();
    if (e instanceof Bloqueio) {
      log(`::warning::Fonte de preços respondeu ${e.message}. Coleta interrompida; dados anteriores mantidos.`);
      await alertar(`A fonte de preços bloqueou a coleta (${e.message}). Os preços do site ficaram como estavam.`);
      log(`Pedidos: ${s.pedidos} | ${(s.bytes / 1048576).toFixed(1)} MB | ${Math.round((Date.now() - inicio) / 1000)}s`);
      return { ok: false, bloqueio: true };
    }
    if (e instanceof LimitePedidos) {
      log(`::warning::${e.message}; nada gravado.`);
      imprimirResumo(resumo, s, inicio, log);
      return { ok: false, limite: true, resumo };
    }
    throw e;
  }

  // perfumes achados pelo serviço de busca sob demanda
  const descobertos = process.env.DESCOBERTOS;
  let processando = null;
  if (descobertos && existsSync(descobertos)) {
    processando = descobertos + ".processando";
    renameSync(descobertos, processando);
    for (const p of lerJson(processando, [])) {
      if (ids.has(String(p.id)) || nomesConhecidos.has(normalizar(p.n))) continue;
      bruto.produtos.push(p);
      ids.add(String(p.id));
      nomesConhecidos.add(normalizar(p.n));
      novosAdicionados++;
    }
  }

  if (cotacao) { bruto.cotacao = cotacao; bruto.cotacaoEm = dia; }
  estado.fila = [...fila.values()].sort((a, b) => (a.t < b.t ? 1 : -1)).slice(0, 3000);
  const s = cliente.stats();
  imprimirResumo(resumo, s, inicio, log);
  for (const a of avisos) log(`::warning::${a}`);
  if (avisos.length) await alertar(avisos.join("\n"));
  log(`Perfumes novos no catálogo: ${novosAdicionados} | total: ${bruto.produtos.length} | fila de ofertas desconhecidas: ${estado.fila.length} | cotação: ${cotacao ?? "não lida"}`);

  if (naoSalvar) {
    log("(teste: nada gravado)");
    if (processando) renameSync(processando, descobertos);
    return { ok: true, resumo };
  }
  gravarJson(caminho("bruto.json"), bruto);
  gravarJson(caminho("estado.json"), estado);
  if (processando) rmSync(processando);
  return { ok: true, resumo };
}

function imprimirResumo(resumo, s, inicio, log) {
  for (const r of resumo) {
    const pct = r.doCatalogo ? ((100 * r.atualizadas) / r.doCatalogo).toFixed(1) : "-";
    log(`  ${r.loja}: ${r.ofertasLidas} ofertas lidas | cobertura do catálogo ${r.atualizadas}/${r.doCatalogo} (${pct}%) | desconhecidas: ${r.desconhecidas}`);
  }
  log(`Pedidos: ${s.pedidos} | ${(s.bytes / 1048576).toFixed(1)} MB | ${Math.round((Date.now() - inicio) / 1000)}s`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  coletar().catch(async (e) => {
    console.error("ERRO:", e.message);
    await alertar(`A coleta de preços falhou: ${e.message}. Os preços do site ficaram como estavam.`);
    process.exitCode = 1;
  });
}
