# Catálogo de perfumes com atualização automática

Site estático hospedado no GitHub Pages. A cada 6 horas o GitHub roda o coletor
(`scraper/scrape.mjs`), lê os preços do ComprasParaguai, grava `site/data.json` e republica o site.
O cliente monta o orçamento e envia pelo WhatsApp, com a loja mais barata e o código do produto na mensagem.

## Colocar no ar (uma vez só, ~10 minutos)

1. Crie uma conta em https://github.com (grátis) e um repositório **público** novo, ex.: `catalogo-perfumes`.
2. Envie todos os arquivos desta pasta para o repositório (botão **Add file > Upload files**,
   incluindo as pastas `.github`, `scraper` e `site`, o `package.json` e o `package-lock.json`).
3. No repositório: **Settings > Pages > Build and deployment > Source: GitHub Actions**.
4. Aba **Actions > Atualizar catálogo > Run workflow**. Em alguns minutos o endereço do site aparece
   em Settings > Pages (algo como `https://SEU-USUARIO.github.io/catalogo-perfumes/`).
5. Edite `site/config.json` direto no GitHub (ícone de lápis) e coloque o seu WhatsApp (DDI+DDD, só números),
   a margem e, se quiser, uma cotação fixa. Ao salvar, o site é republicado sozinho.

## Ajustes comuns

| O que | Onde |
|---|---|
| WhatsApp, acréscimo na cotação, margem, cotação fixa, fotos, título | `site/config.json`. Preço de venda = US$ × (cotação × (1 + `acrescimoCotacao`)) × (1 + `margem`); hoje 5% e 35% |
| Adicionar/remover lojas e **ordem de prioridade** | `scraper/lojas.json` (o `nome` deve ser igual ao nome da loja no ComprasParaguai). O preço mostrado é o da primeira loja da lista que tiver o perfume (hoje: Mega, Macedonia, Nissei, Cellshop, Madrid Center), mesmo que outra seja mais barata |
| Quantos perfumes entram | `scraper/modo.json`: `{"modo":"top","quantidade":200}` (os 200 mais procurados) ou `{"modo":"todos"}` (todos os perfumes das lojas; leva bem mais tempo, veja abaixo) |
| Frequência | linha `cron` em `.github/workflows/atualizar.yml` |

## Se a atualização parar

- Veja a aba **Actions**: o passo "Coletar preços" mostra o erro. Se o ComprasParaguai estiver bloqueando
  os servidores do GitHub (erro 403/429), o site continua no ar com o último preço bom.
- Rode `npm run testar` para conferir que o coletor ainda entende o formato do site (usa um servidor falso).
- O coletor lê só informações públicas, com pausa entre as páginas. Veja os termos de uso do ComprasParaguai
  antes de divulgar o site em larga escala.

## Passar para "todos os perfumes das 5 lojas"

1. Em `scraper/modo.json` troque o conteúdo por `{ "modo": "todos" }` e salve.
2. Em `.github/workflows/atualizar.yml` troque a frequência `"17 */6 * * *"` por `"17 5 * * *"` (uma vez por dia):
   a coleta completa lê milhares de páginas e leva de 30 min a poucas horas.
3. Rode **Actions > Atualizar catálogo > Run workflow**. O site mostra 60 perfumes por vez, com o botão "Mostrar mais".

## Onde a coleta roda (desde 16/11/2026)

O ComprasParaguai bloqueia os servidores do GitHub e da AWS (erro 403). Por isso a coleta roda na VPS,
em `~/catalogo-perfumes`, pelo Cloudflare WARP (container `catalogo-warp`, proxy só para o coletor).
O cron do usuário `ubuntu` roda `~/catalogo-perfumes/coletar.sh` a cada 6 horas; se os preços mudarem, ele envia
`site/data.json` para este repositório (chave de deploy só deste repositório) e o GitHub republica o site.
Log: `~/catalogo-perfumes/coleta.log`.
