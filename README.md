# Navegador de mídias

Aplicação independente em Node.js + Express + Cheerio e frontend HTML/CSS/JavaScript sem framework. O backend busca o HTML público da origem e extrai os dados; o navegador não faz requisições cross-origin diretamente.

## Requisitos
- Node.js 18 ou mais recente
- Conexão à internet

## Executar
1. Extraia a pasta do projeto.
2. Abra a pasta `erome-media-browser` no VS Code.
3. No terminal integrado, execute `npm install`.
4. Execute `npm start`.
5. Abra `http://localhost:3000` no navegador.
6. Para abrir em outro dispositivo na mesma rede Wi-Fi, use o endereço IPv4 local do computador que executa o servidor, seguido de `:3000` (por exemplo, `http://<IP-LOCAL-DO-COMPUTADOR>:3000`).

## Funcionalidades
- Explore de álbuns em Hot e New
- Busca por termo com paginação e contexto preservado ao alternar entre Todas, New e Popular
- Perfil público com listagem de álbuns
- Visualização de álbum com filtro por fotos/vídeos
- Navegação sequencial de álbuns preservando a fonte Explore ou o termo/ordenação da pesquisa; páginas extras só são carregadas por links `rel="next"` validados
- Extração de mídias, descrição, tags e comentários vinculados em estruturas `.media-group`/`.player` e elementos de comentários
- Modo de resultados em Álbuns ou Mídias
- Seção de `Vídeos BR` para pesquisas focadas em conteúdo em português/Brasil
- Feed vertical `TTOK` e `TTOK BR` compartilhando o mesmo pipeline de extração e filtragem de mídias
- Feed progressivo: exibe resultados assim que uma mídia elegível é encontrada, segue páginas públicas validadas e tenta cada tópico de descoberta configurado uma vez ao terminar os fluxos Explore
- Áudio ligado por padrão no TTOK e TTOK BR; a preferência de áudio fica no armazenamento local e um botão de reprodução permite iniciar manualmente quando o navegador bloqueia autoplay com som
- Histórico e favoritos locais, atalhos de teclado no feed e diagnóstico com contagens da sessão
- Proxy local para reproduzir arquivos MP4 do EroMe de forma segura e com suporte a `Range`
- Acesso na rede local: o Express escuta em `0.0.0.0` e o frontend usa URLs relativas para as rotas da aplicação

## Arquivos
- `server.js`: servidor local, rotas da aplicação, requisições HTTP e cache curto.
- `src/parser.js`: parser do HTML de listagens, perfis e álbuns, incluindo fontes de vídeo em `.media-group`/`.player`, tags e comentários públicos.
- `public/index.html`: estrutura da interface.
- `public/styles.css`: visual responsivo (inclui telas a partir de 300 px).
- `public/app.js`: pesquisa, navegação, perfis, filtros, ordenação por visualizações, alternância entre álbuns e mídias e seções de vídeo.
- `package.json`: dependências e comandos.

## Limitações conhecidas
- O site de origem pode mudar a estrutura HTML, limitar requisições ou devolver páginas de verificação. O projeto informa esses casos em vez de tentar contornar proteções.
- Hot e New são suportados com base nos caminhos observados no HTML de referência (`/explore` e `/explore/new`). A paginação só é habilitada quando o HTML fornece links `rel="next"` ou `rel="prev"`.
- A sequência de álbuns não injeta recomendações de Explore em uma pesquisa. Para paginação contínua, usa apenas o `rel="next"` do mesmo caminho e, em pesquisas, mantém o mesmo termo; URLs fora do caminho/origem ou com contexto diferente são rejeitadas. A aplicação não cria números de página por conta própria.
- O TTOK inicia pelas páginas públicas Explore/Explore New e, quando elas acabam, percorre uma lista finita de tópicos de busca já usados pelo aplicativo, cada tópico uma vez. Isso não garante acesso a conteúdo que a origem não exponha ou cujo HTML não tenha links de continuação.
- Os seletores `.media-group`, `.player`, `.album-tag` e comentários foram verificados com fixtures locais controladas. Não havia snapshots reais da pesquisa `teresina` nem do álbum `QMfNbUxW` entre os arquivos acessíveis nesta sessão; portanto, a compatibilidade dessas estruturas com páginas ao vivo ainda não foi confirmada.
- O player do TTOK mostra o quadro inteiro (`object-fit: contain`) sobre fundo preto, sem reenquadrar ou reencodar os arquivos. O proxy local de vídeo permanece limitado a MP4 em domínios `erome.com`; outros formatos/hosts podem precisar ser abertos na origem.
- Em uma pesquisa, New mantém o termo e usa a rota de pesquisa já existente. O código não adiciona parâmetros de ordenação que não foram confirmados na origem: se os cards fornecerem datas explícitas e válidas, a página carregada é ordenada localmente; caso contrário, mantém-se a ordem da origem e a interface informa essa limitação. Isso não representa uma ordenação global por data.
- Popular ordena localmente a página carregada pelos contadores de visualizações extraídos dos cards. Não é uma busca global por popularidade.
- Os filtros na listagem usam contadores de fotos/vídeos quando presentes no card. Se o tipo não for informado, o card fica como desconhecido e não é falsamente classificado.
- O player usa um proxy local limitado a arquivos MP4 em domínios `erome.com`, encaminha cabeçalhos de referência e suporta requisições HTTP Range para permitir carregamento progressivo e busca na linha do tempo. Se o host bloquear a requisição, o navegador ainda poderá não reproduzir o arquivo.
- Perfis públicos são lidos por `/:username`; a paginação depende do link `rel="next"` retornado pela origem.
- “Mais vistos” ordena os álbuns já carregados usando a contagem de visualizações disponível nos cards. Não transforma essa ordenação local em uma busca global por popularidade.
- O HTML de referência não expõe um campo confiável de país para álbuns ou perfis. Por isso, não foi adicionado um filtro geográfico que pudesse classificar usuários incorretamente; buscar termos como “Brasil” é apenas pesquisa textual, não uma localização verificada.
- Use somente para conteúdo ao qual você tem direito de acesso e respeite os termos e direitos aplicáveis. Não inclui login automatizado nem bypass de CAPTCHA ou bloqueios.

## Diagnóstico
- `http://localhost:3000/api/health` deve retornar `{"ok":true}`.
- Se a origem bloquear ou falhar, o frontend exibirá a mensagem retornada pelo backend.
- Se outro dispositivo não conseguir abrir o endereço local, verifique se ambos estão na mesma rede e se o Firewall do Windows permite conexões TCP de entrada na porta 3000 para o perfil **Privado**. O projeto não altera regras de firewall automaticamente. Se necessário, crie manualmente uma regra de entrada para TCP/3000 limitada ao perfil Privado; não habilite o perfil Público.

## Testes
- Execute `npm test` para verificar parsing em fixtures, deduplicação, filtragem brasileira, paginação validada e separação das chaves de cache. O teste de rotas usa uma resposta HTML vazia controlada; ele não simula nem certifica a ordenação, o HTML de páginas reais ou a disponibilidade das mídias no EroMe.
