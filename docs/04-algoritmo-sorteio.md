# Colete — Algoritmo de sorteio equilibrado (v3)

**Especificação normativa e binária do balanceamento de times.** Documento de apoio a
`01-requisitos.md` §5.7. Qualquer mudança de ordem, encoding, PRNG, orçamento, score ou
consumo aleatório exige nova `algorithm_version`; “otimização interna” só é compatível se
passar os vetores dourados byte a byte.

## 1. Limites da promessa

Entrada: `N` jogadores de linha, cada um com UUID e nota inteira 1–5, e `K` times.
Na v3: `2 <= K <= 10`, `K <= N <= 30`. Goleiros não entram; posições são informativas.
Times têm `floor(N/K)` ou `ceil(N/K)` jogadores. Se `N % K != 0`, a interface exige a
confirmação de que média por jogador não compensa jogar com uma pessoa a menos.

O algoritmo equilibra a nota humana informada. A trilha prova o que o servidor registrou,
não que a nota é correta nem que o resultado garante equilíbrio em campo.

## 2. Tipos, ordenação e encoding

- `u8`, `u16` e `u64` são inteiros sem sinal, **big-endian**. Cálculo usa inteiro arbitrário;
  serialização rejeita valor fora da largura.
- UUID é exatamente seus 16 bytes de rede; não é string, não inclui hífen e é comparado
  lexicograficamente byte a byte.
- Texto é UTF-8 sem BOM e sempre precedido pelo comprimento indicado. A versão v3 usa apenas
  ASCII nesses campos, mas o encoding continua normativo.
- Arrays têm contagem explícita; não há delimitador textual, `JSON.stringify`, locale,
  ordem de objeto ou float na entrada canônica.

`balanced_sizes(N,K)` produz primeiro `N % K` capacidades `ceil(N/K)` e depois as demais
`floor(N/K)`. Este vetor é usado na construção; depois os times perdem identidade.

### 2.1 Canonicalização de time e candidato

1. Ordenar os UUIDs de cada time pelos 16 bytes.
2. `team_bytes = u16(player_count) || uuid_1 || ... || uuid_m`.
3. Ordenar `team_bytes` completos lexicograficamente.
4. `candidate_bytes = u16(team_count) || team_bytes_1 || ... || team_bytes_K`.
5. `canonical_key` é o hex lowercase, sem prefixo, de `candidate_bytes`.

Notas não entram na chave: o snapshot vincula UUID a nota. Rótulos Time 1..K são atribuídos
somente após a canonicalização, nessa ordem.

## 3. Score lexicográfico exato

Para cada time `t`:

- `avg(t) = sum(stars)/size`;
- `high(t) = count(stars >= 4)/size`;
- `low(t) = count(stars <= 2)/size`.

Centros globais: `sum(all stars)/N`, `count(all stars >=4)/N` e
`count(all stars <=2)/N`. Para uma lista `x`:
`range(x)=max(x)-min(x)` e `dispersion(x,center)=Σ_t |x(t)-center|`.
Times têm o mesmo peso, inclusive quando os tamanhos diferem.

Menor tupla vence, na ordem:

1. `range(avg)`;
2. `dispersion(avg)`;
3. `range(high)`;
4. `dispersion(high)`;
5. `range(low)`;
6. `dispersion(low)`.

Cada componente é uma fração não negativa reduzida por MDC, denominador positivo.
Comparação usa multiplicação cruzada em inteiro arbitrário. JSON privado é exatamente:

```json
{"components":[{"num":"0","den":"1"},{"num":"0","den":"1"},{"num":"0","den":"1"},{"num":"0","den":"1"},{"num":"0","den":"1"},{"num":"0","den":"1"}]}
```

O encoding binário do score é `u8(6)` seguido, para cada componente, por
`u64(numerator) || u64(denominator)`. Float é proibido em teste, comparação e persistência.

## 4. xoshiro256** e `nextInt`

Semente: 32 bytes exibidos como 64 hex lowercase. Os quatro words consecutivos são lidos
como `u64` big-endian; estado todo zero é inválido. Todas as operações abaixo usam máscara
`2^64-1`; as linhas são executadas na ordem mostrada:

```text
nextU64():
    result = rotl64((s1 * 5) mod 2^64, 7) * 9 mod 2^64
    t = (s1 << 17) mod 2^64
    s2 = s2 xor s0
    s3 = s3 xor s1
    s1 = s1 xor s2        # usa o s2 já atualizado
    s0 = s0 xor s3        # usa o s3 já atualizado
    s2 = s2 xor t
    s3 = rotl64(s3, 45)
    return result
```

Para `1 <= bound <= 2^53`:

```text
nextInt(bound):
    limit = 2^64 - (2^64 mod bound)
    repeat x = nextU64() until x < limit
    return x mod bound
```

Fisher–Yates começa na lista ordenada por UUID e, para `i=N-1..1`, troca `a[i]` por
`a[nextInt(i+1)]`. Não existe chamada implícita a RNG.

## 5. Ramo exato: N <= 12

Enumeração é streaming e não guarda todos os candidatos/ótimos:

1. jogadores em UUID crescente; capacidades em `balanced_sizes`;
2. preencher times da esquerda para a direita;
3. para cada capacidade, combinações dos jogadores restantes em ordem lexicográfica;
4. para capacidades iguais consecutivas, aceitar apenas `team_bytes` estritamente maior
   que o time anterior de mesma capacidade; isso elimina permutações de times;
5. canonicalizar e pontuar cada partição completa.

Reservoir sampling entre ótimos:

```text
if score < best: best=candidate; tie_count=1
if score == best: tie_count += 1; replace best iff nextInt(tie_count) == 0
```

A primeira linha não consome PRNG; a segunda consome exatamente uma chamada lógica a
`nextInt` por empate posterior, incluindo suas rejeições internas. Memória adicional é
`O(N+K)` mais a pilha/composição corrente, não `O(number_of_optima)`.

## 6. Ramo heurístico: N > 12

Parâmetros imutáveis da v3:

| Parâmetro | Valor |
|---|---:|
| Inícios `R` | 60 |
| Passes completos máximos por início | 100 |
| Orçamento de avaliações vizinhas por início | 20.000 |
| Vizinhanças | 1↔1, depois 2↔2 |

Início 0 é serpentina. Jogadores são ordenados por `(rating desc, uuid asc)` e distribuídos
na sequência de índices `0..K-1`, depois `K-1..0`, repetindo os extremos e pulando time
cheio. Inícios 1–59 fazem o Fisher–Yates normativo e fatiam nas capacidades, sem reordenar
por nota.

### 6.1 Ordem normativa dos movimentos

Antes de cada passe, canonicalizar times e jogadores; chamar os times `A=0..K-1`.

1. 1↔1: tuplas `(0,A,B,uuid_a,uuid_b)`, com `A<B`, em ordem lexicográfica.
2. 2↔2: tuplas `(1,A,B,a1,a2,b1,b2)`, `A<B`, cada par em UUID crescente, em ordem
   lexicográfica.

Cada vizinho é canonicalizado e pontuado. Só movimento estritamente melhor que o estado
corrente é elegível. Entre movimentos com o melhor score do passe usa-se reservoir sampling
na ordem acima. Ao fim do passe completo, aplica-se o escolhido; sem melhoria, encerra.
Cálculo incremental de score é recomendado, mas precisa produzir a mesma fração reduzida
do recálculo integral; testes diferenciais comparam ambos para cada vizinho. Uma avaliação
conta por candidato pontuado, independentemente de ser incremental ou integral.

Antes de iniciar um passe, calcula-se o número integral de vizinhos:
`Σ_(A<B) size(A)*size(B) + C(size(A),2)*C(size(B),2)`. Se o orçamento restante não cobre
o passe **inteiro**, o início termina no estado do último passe completo; nenhum prefixo é
avaliado. Também termina em 100 passes.

Os 60 resultados são deduplicados por `canonical_key`. Entre os de melhor score, ordenar
as chaves e escolher índice `nextInt(M)`. Guardar no máximo 60 resultados é permitido; o
reservoir obrigatório de memória limitada aplica-se ao ramo exato.

Fim de orçamento é parte determinística do algoritmo e retorna o estado completo alcançado.
Timeout de parede é apenas disjuntor operacional: se ocorrer em qualquer ponto, a Edge
retorna `DRAW_TIMEOUT`, descarta cálculo/outcome e **não** chama `commit_draw`. Nunca retorna
“melhor até agora” por timeout.

## 7. HMAC da entrada

Chave de teste/produção vem de cofre fora do banco e tem versão. Mensagem:

```text
u8(domain_len) || UTF8("colete/draw-input/v3") ||
u16(version_len) || UTF8("v3") ||
u16(K) || u16(N) ||
for player in uuid_ascending: uuid_bytes(16) || u8(rating)
```

`input_hmac = HMAC-SHA-256(key_version, message)`. O domínio participa dos bytes e impede
reuso entre finalidades. Dump sem chave não permite enumerar notas 1–5. `seed_hex`, HMAC,
entrada, score e snapshots ficam apenas em `draw_private_artifacts`.

## 8. Consumo normativo do PRNG

1. O ramo exato consome apenas o reservoir de empates, na ordem da seção 5.
2. A serpentina não consome PRNG.
3. Cada início aleatório consome o Fisher–Yates; depois, cada passe consome reservoir apenas
   em empates entre movimentos com melhor score estritamente melhor.
4. Após os 60 inícios, a escolha global consome um `nextInt(M)`, mesmo se `M=1`
   (`nextInt(1)` consome `nextU64`).
5. Score, HMAC, canonicalização, logging e serialização não consomem PRNG.

## 9. Vetores dourados v3

Estes valores são assertados literalmente em runtimes TypeScript/PostgreSQL de teste.
Semente: `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f`.

| Vetor | Resultado esperado |
|---|---|
| seis primeiros `nextU64`, hex de 16 dígitos | `cb61f88f25bc5234`, `34cb61f88f25bb9c`, `3b002d5a891e1d0e`, `4407cb349c43dbd7`, `f2ac9857862c2cff`, `fc5479354710d01e` |
| gerador novo; `nextInt(2), nextInt(3), nextInt(10), nextInt(1000)` | `0, 1, 4, 47` |
| gerador novo; Fisher–Yates de `[1,2,3,4,5]` | `[4,2,3,5,1]` |
| partição aleatória desse shuffle para `N=5,K=2`, tamanhos `[3,2]` | `[4,2,3]` e `[5,1]` |

Fixture binária: UUIDs `00000000-0000-0000-0000-000000000001` a `...0004`, notas
`[5,4,2,1]`, `K=2`; chave HMAC **somente de teste** igual aos bytes `00..1f`.

| Vetor | Resultado esperado |
|---|---|
| bytes de input, hex | `14636f6c6574652f647261772d696e7075742f763300027633000200040000000000000000000000000000000105000000000000000000000000000000020400000000000000000000000000000003020000000000000000000000000000000401` |
| HMAC-SHA-256 | `35fadc2a72309e86a5288ae80a1e88286ad60f9d67c6055632444682dbf6ea0c` |
| partições únicas visitadas no ramo exato | `3` |
| ótimo único | `{...0001,...0004}` e `{...0002,...0003}` |
| score | seis vezes `{num:"0",den:"1"}` |
| `canonical_key` | `00020002000000000000000000000000000000010000000000000000000000000000000400020000000000000000000000000000000200000000000000000000000000000003` |

## 10. Concorrência, persistência e retenção

1. Edge lê snapshot privado e `match_revision`.
2. Calcula sem transação aberta. Benchmark/timeout não congela a lista.
3. `commit_draw(expected_revision, request_id, result)` trava/reconcilia o racha, revalida
   conjunto, notas, pagamentos e formato binário.
4. Revisão diferente retorna `DRAW_STALE`; sucesso grava `draws`,
   `draw_private_artifacts`, fecha lista e audita na mesma transação.
5. Outcome idempotente contém só draw ID/versão/revisão. A proposta privada vem de
   `get_draw_proposal(draw_id)` com autorização fresca.

Após 12 meses, input, seed, HMAC, score, métricas privadas e `team_rating_snapshots` são
apagados fisicamente. `team_members` mantém somente a composição publicada sem estrelas.

## 11. Gate de desempenho e testes

Não há promessa documental de 500 ms. Antes do beta, o mesmo build/runtime da Edge executa
no mínimo 100 seeds por fixture, com warm-up separado, e registra p50/p95/p99, pico de memória,
avaliações e timeout. Gate: zero timeout/erro/OOM nas fixtures aceitas e p95 abaixo do limite
operacional aprovado no roadmap; se falhar, otimiza-se sem mudar bytes ou lança-se v4.

Fixtures adversariais incluem: **N=12,K=5, todas as notas iguais**; N=12 nos K que
maximizam partições; **N=30,K=2**; N=13; K=10; extremos 5/1; tamanhos desiguais; muitos
ótimos; estados construídos para muitas melhorias locais; contraexemplo v2
`(3,2,2,1,1,1,1),K=2`; e quatro ou mais times com interiores diferentes.

| Família | Garantia |
|---|---|
| Vetores dourados | PRNG, rejection, shuffle, bytes, HMAC, chave, score e ótimo literais |
| Propriedades | Cada UUID exatamente uma vez; tamanhos válidos; score racional/canônico |
| Exato | Score igual a um oráculo independente para todas as instâncias pequenas geradas |
| Heurístico | Mesma entrada/seed/versão produz bytes iguais; avaliações nunca excedem orçamento |
| Variedade | Seeds diferentes alcançam mais de uma composição quando há ótimos múltiplos |
| Segurança | HMAC/seed/nota/score não aparecem em auditoria, outcome, logs ou projeção pública |
| Concorrência | Mudança de lista/nota durante cálculo dá `DRAW_STALE`; retry não duplica draw |
| Falhas | K/N/nota inválidos, orçamento, timeout injetado e artefato privado expirado |

Auditoria pública aceita somente o payload tipado de `10-schema-db.md`: identificador opaco,
versão, K, tamanhos e contador. Ela não é prova criptográfica reproduzível pelo grupo.
