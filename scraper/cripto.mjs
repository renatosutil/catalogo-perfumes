// node scraper/cripto.mjs cifrar   -> bruto.json, estado.json, lojas.json  =>  .enc
// node scraper/cripto.mjs decifrar -> .enc  =>  .json
// Ao cifrar, só regrava o .enc se o conteúdo mudou (evita commits sem mudança).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { caminho, cifrar, decifrar } from "./comum.mjs";

export const ARQUIVOS = ["bruto", "estado", "lojas"];

export function executar(acao, log = console.log) {
  for (const nome of ARQUIVOS) {
    const json = caminho(nome + ".json"), enc = caminho(nome + ".enc");
    if (acao === "cifrar") {
      if (!existsSync(json)) continue;
      const atual = readFileSync(json);
      if (existsSync(enc) && decifrar(readFileSync(enc)).equals(atual)) { log(`${nome}: sem mudança`); continue; }
      writeFileSync(enc, cifrar(atual));
      log(`${nome}: cifrado`);
    } else if (acao === "decifrar") {
      if (!existsSync(enc)) continue;
      writeFileSync(json, decifrar(readFileSync(enc)));
      log(`${nome}: decifrado`);
    } else throw new Error("uso: cripto.mjs cifrar|decifrar");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { executar(process.argv[2]); } catch (e) { console.error("ERRO:", e.message); process.exit(1); }
}
