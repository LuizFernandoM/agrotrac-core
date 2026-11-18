# Validação real do MVP Core

Executada em 15/11/2026, aproximadamente 16:08 America/Sao_Paulo, Windows PowerShell, Node v22.14.0 e npm 10.9.2. Código não commitado e não publicado. Apenas agrotrac-core foi editado.

## Comandos e resultado final

A partir de agrotrac-core:

```powershell
$env:CORE_INFRA_ENV_PATH = (Resolve-Path '../agrotrac-infra/.env').Path
$env:PGHOST = '127.0.0.1'
$env:PGPORT = '15432'
npm run build
npm run typecheck
npm test
npm run test:integration
```

| Comando | Resultado real |
| --- | --- |
| npm run build | exit 0, tsc gerou dist/ |
| npm run typecheck | exit 0, incluindo testes |
| npm test | exit 0; 7 aprovados, 0 falhas, 0 skipped; 294 ms |
| npm run test:integration | exit 0; 11 cenários + teste pai (12 aprovados no runner), 0 falhas, 0 skipped; 3456 ms |

Unidade usa apenas memória/mutex e não acessa Docker. A integração usa Fastify ouvindo 127.0.0.1 em porta efêmera e fetch por TCP; não usa inject/mocks para HTTP, SQL ou entrega RabbitMQ.

## Recursos isolados da execução final

- Banco: agrotrac_core no PostgreSQL 16 Docker existente.
- Schema novo preservado: `core_it_1794769722092_63323244`.
- Exchange topic durável: `agrotrac.test.df3b5aeda12c47f3b0fa0d5510e1802b`.
- Filas duráveis: `agrotrac.test.df3b5aeda12c47f3b0fa0d5510e1802b.live` e `agrotrac.test.df3b5aeda12c47f3b0fa0d5510e1802b.audit`.
- Contagens finais do schema: 11 silos, 8 janelas, 10 reservas, 33 eventos outbox, todos os 33 PUBLISHED.
- Consultas repetidas usando a mesma conexão PostgreSQL retornaram o mesmo backend PID `1538` e saldo real de 10000 kg.

A inspeção inicial de information_schema encontrou apenas `public.teste_persistencia`. Nenhuma instrução de escrita foi emitida para public. Cada execução posterior inspecionou os schemas existentes antes de criar um novo; a migração recusa reutilização no modo de integração e também foi testada para reaplicação no schema reconhecido. Não houve DROP, TRUNCATE, DELETE SQL, limpeza de fixtures ou remoção de volumes.

## Evidências dos cenários finais

| Cenário | Asserções e observações reais |
| --- | --- |
| 10 reservas simultâneas de 2000 kg em 10000 | exatamente 5×201 e 5×409 CAPACITY_EXCEEDED; saldo reservado 10000, disponível 0; exatamente 5 booking.created filtrados por tipo/window_id |
| Duas janelas, mesmo silo de 5000 kg | pedidos 4000 e 3000 em paralelo: 1×201 e 1×409 SILO_CAPACITY_EXCEEDED; vencedor reservou 4000 na execução final; ambas as ordens (3000 ou 4000) foram observadas em execuções anteriores |
| 10 cancelamentos paralelos da mesma reserva de 5000 | 10×200, um único estorno de 5000, saldo silo/janela 0, exatamente um booking.cancelled |
| Rollback de criação | falhas após update da janela (ambos saldos já alterados), após INSERT booking e após INSERT outbox: 500 em todos; saldos 0, nenhuma reserva e nenhum booking.created residual |
| Rollback de cancelamento | falha após INSERT outbox: 500; reserva permaneceu CONFIRMED, saldo reservado 2000, nenhum booking.cancelled residual |
| Janela bloqueada/encerrada | reserva confirmada preservada; nova reserva negada; saldo mantido; CLOSED não reabre; cancelamento continua permitido |
| Dados inválidos | negativos, zero, frações, inteiro inseguro, string/null como peso, placa inválida, UUID inválido, filtros inválidos, calendário inválido, intervalo invertido, ocupação maior que capacidade e correlation header inválido rejeitados |
| Erros e constraints reais | IDs ausentes 404, código duplicado 409, janela expirada 422; UPDATE negativo/inseguro rejeitado por CHECK 23514; vínculo reserva/silo divergente rejeitado por FK composta 23503 |
| Precisão | capacidade Number.MAX_SAFE_INTEGER persistida e consultada sem perda; unidade testa rejeição explícita de BIGINT inseguro no mapper |
| Entrega broker | 30 eventos iniciais da outbox recebidos em CADA fila isolada, IDs conferidos, deliveryMode=2, messageId=event_id, versões de silo/janela inteiras |
| Roteamento | publish de chave sem binding foi rejeitado via mandatory/return mesmo com confirm; publicação posterior reconectou; binding Live recebeu core; Audit recebeu core e live; fila Live não recebeu live |
| Falha/retry | conexão em porta local 1 simulou indisponibilidade sem parar broker; evento seguiu PENDING por 6 falhas, attempts e next_attempt_at persistidos; tentativa 7 com broker real marcou PUBLISHED e entregou o mesmo event_id em ambas filas |
| SKIP LOCKED | primeiro worker bloqueado aguardando publisher manteve transação SQL aberta; segundo worker publicou outra linha; terceiro não encontrou elegível; liberação concluiu o primeiro sem duplicação nas filas |
| Handshake silencioso | servidor TCP de teste aceitou sem responder AMQP; falha limitada em 211 ms com deadline 200 ms e liberação da conexão |
| Confirm silencioso e reconexão | proxy TCP próprio congelou tráfego depois do handshake real; publicação expirou, socket próprio foi encerrado, publisher reconectou e recebeu confirm real; conjunto timeout+fechamento+reenvio em 668 ms com deadline 300 ms |

Backoff de produção: 250ms exponencial até 60000ms, sem limite de cinco tentativas. Para testar seis falhas sem espera longa, somente next_attempt_at da fixture nova foi adiantado para now(); isso está explícito no teste. O teste não parou broker, não mudou configuração do RabbitMQ e não consumiu filas operacionais. Topologia canônica é implementada, mas a execução real usa nomes isolados com os mesmos tipos de exchange, durabilidade e bindings.

## Ajustes descobertos durante execução

O primeiro acesso a 127.0.0.1:5432 falhou com SQLSTATE 28P01. A coordenação identificou PostgreSQL nativo Windows nessa porta; o banco Docker autenticava internamente. Foi autorizado e criado o container próprio `agrotrac-core-test-relay-cf6006` (alpine/socat, sem volume/credenciais), conectado a agrotrac-infra_default e publicado somente em 127.0.0.1:15432, encaminhando postgres:5432. O relay foi parado ao concluir e preservado para reutilização; README documenta como iniciar. Compose, portas dos serviços existentes, .env, senhas e volumes não foram alterados.

Os testes ampliados de timeout inicialmente concluíram suas asserções mas mantiveram o processo vivo: o encerramento abrupto do socket não notificava o driver para limpar heartbeat. Esses dois runs foram interrompidos e não são declarados aprovação integral. O fechamento passou a destruir o socket com erro sanitizado, liberando os recursos do driver; a execução final terminou naturalmente com exit 0. Também foi corrigida a comparação de datas UTC com/sem milissegundos para comparar instantes numéricos, com cobertura unitária.

Schemas de desenvolvimento preservados além do final: `core_it_1794769380075_8a31b1cf` (primeira bateria concluída), `core_it_1794769454728_2426af8c` e `core_it_1794769480207_302c70f0` (runs interrompidos por heartbeat pendente), `core_it_1794769526145_4f8d6fa9` (bateria ampliada concluída antes da verificação final). Exchanges/filas desses runs também foram preservadas com IDs isolados impressos em seus resultados. Nenhuma limpeza foi executada.

## Limites das evidências e pendências de produto

- Testes demonstram os cenários executados; não são benchmark nem prova de inexistência absoluta de deadlocks. A ordem de locks é silo → janela → reserva; timeouts/deadlock são mapeados para conflito e não fazem retry transparente do comando HTTP.
- Entrega é pelo menos uma vez; queda entre confirm e commit da outbox pode duplicar. Consumidores Live/Audit ainda precisam deduplicar event_id e comparar versões dos agregados. Sem garantia de ordem global.
- A topologia operacional canônica não foi usada para publicar fixtures; não foi realizado teste ponta a ponta com consumidores Live/Audit ainda inexistentes.
- Sem auth/Gateway, bind local padrão; sem Idempotency-Key, paginação, multa/no-show, reagendamento atômico ou transição de pesagem para ocupação. São limites documentados, não testes pulados.
- Nenhum serviço de aplicação fica rodando após o teste; todos os servidores/proxies de teste e conexões foram fechados. Para executar o Core, iniciar relay se necessário, escolher schema explícito, aplicar migrate e npm start.
- `PgStore` mantém coerência das somas pelas transações do Core; SQL externo direto deve ser vedado pela operação. Constraints impedem massas inválidas e vínculos incorretos, mas não calculam somas entre múltiplas tabelas por trigger.
