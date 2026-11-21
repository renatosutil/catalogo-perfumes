# Catálogo de perfumes

Site estático (GitHub Pages) onde o cliente monta um orçamento e envia pelo WhatsApp.
Os preços vêm de uma fonte de preços pública, coletados por um servidor próprio (VPS), e são publicados
aqui já convertidos para o preço final em reais.

## Como funciona

- **Coleta diária (VPS):** `scraper/scrape.mjs` atualiza os preços das ofertas já conhecidas pelas buscas da
  fonte de preços, uma loja por vez, conforme a agenda de cada loja; 1x por semana procura perfumes novos.
  Um pedido por vez, com pausa de `ESPERA_MS` (hoje 5 s, no `.env` da VPS) + sorteio de até 50%. A ampliação do catálogo
  trabalha até as 06h45 (`AMPLIACAO_ATE`). Se a fonte responder 403/429, a coleta para
  na hora e os dados anteriores são mantidos.
- **Busca sob demanda (VPS):** `server/api.mjs` atende a busca do site. O que não estiver no catálogo é
  procurado na hora (com cache, fila e limites por cliente) e passa a fazer parte do catálogo.
- **Publicação:** `scraper/publicar.mjs` gera `site/data.json` só com nome, foto, preço final (`p`),
  referência (`r`) e data do preço (`a`). O GitHub republica o site a cada mudança em `site/`.
- **Dados brutos:** ficam só cifrados no repositório (`scraper/*.enc`, AES-256-GCM). Os arquivos em texto puro
  (`bruto.json`, `estado.json`, `lojas.json`) estão no `.gitignore`.

## Configuração

| O que | Onde |
|---|---|
| WhatsApp, validade do preço (`diasPrecoValido`), fotos, título, endereço da busca (`api`) | `site/config.json` |
| Margem, acréscimo na cotação, cotação fixa, chave dos dados, endereço da fonte | arquivo `.env` na VPS (`MARGEM`, `ACRESCIMO_COTACAO`, `COTACAO_FIXA`, `DADOS_CHAVE`, `FONTE_URL`) |
| Lojas, ordem de prioridade e frequência de cada loja | `scraper/lojas.json` (cifrado no repositório) |
| Termos de busca usados na coleta | `scraper/termos.json` (opcional) |

Se o preço de referência tiver mais de `diasPrecoValido` dias, o site mostra "Consultar preço" e o item
não entra no total.

## Comandos

- `npm test` / `npm run testar`: testes com um servidor falso (não acessa a internet).
- `npm run decifrar` / `npm run cifrar`: abre e fecha os dados (precisa de `DADOS_CHAVE`).
- `npm run atualizar`: coleta. `npm run publicar`: gera `site/data.json`. `npm run cotacao`: só a cotação do dólar (1 pedido).

## Na VPS

Pasta `~/catalogo-perfumes`: `repo/` (este repositório), `compose.yaml`, `coletar.sh`, `.env`, `dados/` e
`coleta.log`. O cron roda `coletar.sh` uma vez por dia e `coletar.sh cotacao` a cada 3 horas; o serviço de busca roda no container `catalogo-api`.
