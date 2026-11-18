# Contratos Canônicos de Integração e Especificação Técnica do MVP — AgroTrac Core

> **Documento Oficial de Engenharia e Arquitetura**  
> **Módulo:** `agrotrac-core` (Serviço Core A — Operações, Vagas e Capacidade)  
> **Status:** Revisado pela coordenação; implementar com as correções vinculantes abaixo.  
> **Autor:** Arquiteto AgroTrac  
> **Data:** Novembro de 2026  
> **Destinatário Principal:** Desenvolvedor / Agente Codex (Core A)

---

## Revisão vinculante da coordenação — 15/11/2026

Esta seção prevalece sobre exemplos e recomendações conflitantes abaixo. O documento define contratos técnicos, não autorização para inventar políticas de negócio.

- Incluir `POST /v1/core/silos` (codigo, nome, tipo_grao, capacidade_total_kg, ocupacao_fisica_kg inicial opcional, padrão zero), `POST /v1/core/windows` (silo_id, inicio_em, termino_em, capacidade_maxima_kg) e `GET /v1/core/bookings` (filtros silo_id/window_id/status). Criações retornam 201; dados inválidos 400; silo ausente 404; codigo duplicado 409. Capacidades são positivas e seguras; ocupação inicial fica entre zero e a capacidade. Janela exige término posterior ao início; cota da janela pode exceder capacidade livre do silo, pois ambas são verificadas na reserva.
- Bloquear uma janela impede NOVAS reservas e preserva reservas confirmadas; não exigir cancelamentos prévios. Janela CLOSED não reabre nesta entrega. Silo INACTIVE não aceita novas reservas. Nenhuma regra de no-show, multa, documento fiscal obrigatório ou conclusão automática de descarga é autorizada. `motorista_documento` é opcional; não implementar validação fiscal não especificada.
- O saldo do silo considera TODAS as reservas CONFIRMED, inclusive de janelas bloqueadas ou encerradas. A pesagem no Audit não altera automaticamente esse saldo nesta entrega; a transição para ocupação física continua pendente de definição de domínio. Informar essa limitação sem representar reserva como estoque físico.
- Toda mutação com múltiplos recursos usa ordem de locks SILO → JANELA → RESERVA. Leituras iniciais sem lock podem localizar IDs imutáveis; revalidar estado após locks. Cancelamento não adquire primeiro lock da reserva. A ordem reduz riscos; não afirmar impossibilidade absoluta de deadlocks.
- O erro `{error:{code,message,details,correlation_id,timestamp}}` é formato próprio AgroTrac, NÃO RFC 7807. Usar application/json. Core gera correlation_id quando ausente; não depende de Gateway ainda inexistente. Não prometer suporte a Idempotency-Key sem implementação e teste do replay e conflito de payload; documentar claramente se não suportado.
- Outbox mantém eventos PENDING elegíveis para novas tentativas com backoff limitado, SEM abandono silencioso após cinco falhas. Persistir next_attempt_at e attempts, usar transação real para SKIP LOCKED, confirmar publicação persistente e tratar timeout/reconexão. Publish confirm não comprova roteamento: declarar filas duráveis canônicas e bindings ANTES da primeira publicação ou tratar mandatory/return sem marcar mensagem não roteada como publicada. Audit usa dois bindings explícitos agrotrac.core.# e agrotrac.live.#. Preservar event_id em reenvios.
- Incluir versão monotônica do silo e da janela nos snapshots de eventos para Live ignorar atualizações antigas. Criação de silo e janela também produz evento versionado; catálogo deve documentar payloads consistentes. Timestamp isolado não garante ordem de atualizações.
- Domínio deve validar invariantes independente do HTTP. PostgreSQL usa constraints para massas seguras, não negativas, capacidade e integridade dos vínculos; mapper BIGINT não perde precisão. Casos de uso usam Result e portas de transação/repositórios; não escondê-los em controllers ou SQL.
- Testes unitários funcionam sem Docker. Integração usa schema exclusivo de teste, sem apagar ou alterar dados preexistentes, sem DROP/TRUNCATE ou remover volumes; pode deixar fixtures no schema identificado. Asserções de contagem da outbox filtram eventos por tipo/IDs do cenário, pois cadastros também emitem eventos. Simular falha após mudanças e confirmar rollback completo. Datas de teste relativas ao relógio para não expirar.
- Sem autenticação pronta, servidor local deve escutar 127.0.0.1 por padrão e documentar que uso externo está pendente do Gateway e autenticação. Não representar endpoints como protegidos nesta entrega.

---

## 1. Contrato implementado do MVP

A revisão vinculante acima é preservada integralmente. As seções seguintes substituem os exemplos antigos conflitantes e descrevem o comportamento executável em `src/` e `tests/`.

### Tipos e invariantes

- Massas são números inteiros seguros em kg, de zero a `9007199254740991`; capacidades e peso solicitado são estritamente positivos. BIGINT é convertido com verificação de precisão, nunca com coerção global do driver.
- IDs e correlation_id recebidos são UUID v4 canônicos minúsculos. Core gera IDs com `crypto.randomUUID()` e gera correlation_id quando ausente. Header fornecido inválido retorna 400 com um novo ID válido.
- Datas de entrada são UTC estrito `YYYY-MM-DDTHH:mm:ss[.sss]Z`, com validação do calendário real; saída normalizada com milissegundos.
- `saldo_disponivel_silo_kg = capacidade_total_kg - ocupacao_fisica_kg - saldo_reservado_kg`.
- `saldo_disponivel_janela_kg = capacidade_maxima_kg - saldo_reservado_kg`.
- `saldo_reservado_kg` do silo inclui TODAS as reservas CONFIRMED, sem depender do status ou horário da janela.
- A janela pode ter cota superior à capacidade do silo. Cada reserva precisa caber nos dois saldos.
- Domínio/casos de uso retornam `Result<T>` discriminado por `ok`. Exceções são reservadas a falhas técnicas. Os casos de uso dependem de portas Store/Repository/Runtime; não de HTTP, pg ou RabbitMQ.

### HTTP

Sem autenticação nesta entrega. Bind padrão `127.0.0.1:3001`; exposição externa depende de Gateway e autenticação futuros. `Idempotency-Key` não é implementado e não oferece replay nem deduplicação: dois POSTs iguais podem criar duas reservas. DELETE é idempotente pelo estado da reserva.

| Método e caminho (prefixo `/v1/core`) | Entrada | Sucesso |
| --- | --- | --- |
| POST `/silos` | codigo (1–50), nome (1–100), tipo_grao (1–50), capacidade_total_kg; ocupacao_fisica_kg opcional, padrão 0 | 201, silo ACTIVE, version 1 |
| GET `/silos` | query status opcional ACTIVE/INACTIVE | 200, array |
| GET `/silos/:id` | UUID v4 | 200, silo |
| POST `/windows` | silo_id, inicio_em, termino_em, capacidade_maxima_kg | 201, janela OPEN, version 1 |
| GET `/windows` | query silo_id, status OPEN/BLOCKED/CLOSED, data_inicio, data_fim opcionais | 200, array; início >= data_inicio e término <= data_fim |
| GET `/windows/:id` | UUID v4 | 200, janela |
| PATCH `/windows/:id/status` | status OPEN/BLOCKED/CLOSED, motivo opcional/nulo (até 500) | 200, janela; mesmo status não gera evento novo |
| POST `/bookings` | window_id, placa, motorista_nome, peso_estimado_kg; motorista_documento opcional/nulo | 201, reserva CONFIRMED |
| GET `/bookings` | query silo_id, window_id, status CONFIRMED/CANCELLED/COMPLETED opcionais | 200, array |
| GET `/bookings/:id` | UUID v4 | 200, reserva |
| DELETE `/bookings/:id` | corpo opcional com motivo (até 500) | 200, reserva CANCELLED; repetição retorna a mesma reserva |

Placa: `^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$` (tradicional ou Mercosul). motorista_nome tem 2–100 caracteres; motorista_documento, quando fornecido, é texto livre de 1–100 caracteres, sem validação fiscal. Não há campo fiscal obrigatório. Strings obrigatórias não podem ser vazias ou só espaços. Filtros desconhecidos/inválidos retornam 400.

Silo retorna id, codigo, nome, tipo_grao, capacidade_total_kg, ocupacao_fisica_kg, saldo_reservado_kg, saldo_disponivel_kg, status, version, created_at, updated_at. Janela retorna id, silo_id, inicio_em, termino_em, capacidade_maxima_kg, saldo_reservado_kg, saldo_disponivel_kg, status, version, created_at, updated_at. Reserva retorna id, silo_id, window_id, placa, motorista_nome, motorista_documento, peso_estimado_kg, status, cancelled_at, motivo, created_at, updated_at; a visualização CANCELLED também informa peso_estornado_kg.

Bloqueio não cancela reservas e não altera saldos. CLOSED não reabre; cancelamento de reservas existentes continua permitido. Silo INACTIVE impede novas reservas; não existe endpoint de transição de status do silo neste escopo. `COMPLETED` é reconhecido defensivamente para rejeitar cancelamento, mas nenhuma transição de pesagem/descarga para esse estado é implementada.

Erros usam `application/json`, header `X-Correlation-Id` e formato próprio AgroTrac (não RFC 7807):

```json
{"error":{"code":"CAPACITY_EXCEEDED","message":"CAPACITY_EXCEEDED","details":null,"correlation_id":"b3e2a109-7654-4321-abcd-ef0123456789","timestamp":"2026-11-15T16:05:00.789Z"}}
```

| Código | HTTP |
| --- | --- |
| INVALID_PAYLOAD | 400 (limite do corpo e mídia inválida preservam 413/415) |
| SILO_NOT_FOUND, WINDOW_NOT_FOUND, BOOKING_NOT_FOUND, NOT_FOUND | 404 |
| SILO_CODE_DUPLICATE, SILO_INACTIVE, WINDOW_NOT_OPEN, WINDOW_CLOSED | 409 |
| CAPACITY_EXCEEDED, SILO_CAPACITY_EXCEEDED, BOOKING_ALREADY_COMPLETED | 409 |
| CONCURRENCY_TIMEOUT (lock/statement timeout, deadlock, serialização) | 409 |
| WINDOW_EXPIRED | 422 |
| INTERNAL_SERVER_ERROR | 500 |

### Transações e persistência

PostgreSQL READ COMMITTED. A operação localiza IDs sem lock e, em seguida, adquire SILO → JANELA → RESERVA (quando existente). Revalida estado e vínculos depois dos locks. Cancelamento nunca bloqueia primeiro a reserva. A ordem reduz riscos de deadlocks; não há promessa de impossibilidade absoluta. lock_timeout=5s e statement_timeout=15s nas transações dos casos de uso.

Reserva incrementa os dois saldos e suas versões, insere a reserva e a outbox na mesma transação. Cancelamento CONFIRMED decrementa os dois saldos e incrementa versões, grava CANCELLED e evento na mesma transação. Repetição CANCELLED não altera saldos, versões ou eventos. Status de janela incrementa somente a versão da janela. IDs parentais não são alterados pelos casos de uso.

DDL aditivo implementado em `src/infra/migration.ts`: tabelas silos, windows, bookings, outbox_events e core_migrations, sempre qualificadas por schema explicitamente configurado. Constraints: massas seguras/não negativas, ocupação+reserva <= capacidade, reserva da janela <= cota, datas ordenadas, estados válidos, código único, FKs e vínculo composto `(window_id,silo_id)`. Coerência das somas entre várias linhas é mantida pelas transações do Core; clientes externos não devem escrever diretamente nessas tabelas. Não há trigger de soma entre tabelas.

Migração inspeciona tabelas do schema e recusa schema desconhecido já ocupado; usa advisory lock e marcador de versão para reaplicação. `public`, schemas de sistema e nomes inseguros são recusados. Integração exige schema novo único e não apaga fixtures ou dados preexistentes.

### Eventos versionados

Envelope comum, persistido integralmente em outbox_events.payload:

```typescript
{
  event_id: UUIDv4,
  type: string,             // idêntico à routing key
  version: '1.0.0',          // versão do contrato, não do agregado
  producer: 'agrotrac-core',
  occurred_at: UTC,
  correlation_id: UUIDv4,
  payload: { /* catálogo abaixo */ }
}
```

Todos os eventos incluem `silo_id`, `silo_version`, `silo` (snapshot completo com version/saldos/datas) e `saldo_disponivel_silo_kg`. Eventos com janela incluem `window_id`, `window_version`, `window` (snapshot completo), `inicio_em`, `termino_em`, `status` da janela, `updated_at` da janela, `motivo` e `saldo_disponivel_janela_kg`. Em eventos de reserva, `booking.status` é o estado da reserva; `payload.status` continua sendo o estado da janela.

| Type/routing key | Campos adicionais |
| --- | --- |
| agrotrac.core.silo.created | snapshot de silo, sem janela |
| agrotrac.core.window.created | campos comuns da janela, motivo null |
| agrotrac.core.window.updated | campos comuns da janela, motivo fornecido ou null |
| agrotrac.core.booking.created | booking_id, booking completo, placa, motorista_nome, peso_estimado_kg |
| agrotrac.core.booking.cancelled | campos da reserva acima, peso_estornado_kg, cancelled_at, motivo do cancelamento |

A versão inicial de cada agregado é 1; alterações no saldo ou estado desse agregado incrementam sua versão sob lock. Criação de janela não muda a versão do silo (o saldo/estado do silo não mudou). Live deve comparar versões por agregado, não timestamps nem a versão semântica do envelope. Em entrega fora de ordem, aplicar apenas snapshot com versão maior que a já conhecida. Snapshots têm dados pessoais da reserva; proteção de acesso/retencão depende da etapa de segurança futura.

### Outbox e RabbitMQ

- Exchange topic durável `agrotrac.events`, autoDelete false.
- Fila durável `agrotrac.live.events`: binding `agrotrac.core.#`.
- Fila durável `agrotrac.audit.events`: DOIS bindings explícitos `agrotrac.core.#` e `agrotrac.live.#`.
- O publisher declara exchange/filas/bindings antes da primeira publicação de cada conexão. Erro de topologia mantém o evento pendente.
- Usa canal confirm, mensagem persistente, mandatory true, messageId=event_id e correlationId. Aguarda callback confirm individual com deadline; return obrigatório é falha, mesmo com ACK do broker.
- Worker abre transação, lê uma linha PENDING elegível com `FOR UPDATE SKIP LOCKED` e mantém lock até o resultado de publicação e update. Poll vazio a cada 500ms. Timeout padrão de I/O e conexão RabbitMQ: 5s; fechamento também limitado, com encerramento do próprio socket em falha.
- Sucesso: PUBLISHED, published_at, attempts+1. Falha: continua PENDING, attempts+1, last_error sanitizado, next_attempt_at com backoff exponencial de 250ms até teto 60s. Não há abandono após cinco falhas.
- Reconecta após falha de canal, rede, confirm timeout ou retorno sem rota. Mesmo event_id em todos os reenvios.
- Semântica pelo menos uma vez: falha depois do confirm e antes do COMMIT SQL pode duplicar. Consumidores devem deduplicar event_id. Vários workers podem entregar eventos fora de ordem, resolvida pelas versões dos agregados.
- Não há publicação dentro das transações de negócio; rollback remove reserva, saldos e evento juntos.
- Integração substitui nomes por exchange e duas filas duráveis UUID isoladas; não publica nem consome nas filas operacionais. Fixtures são preservadas.

### Limites de domínio e aceite

Não há autenticação, no-show, multa, reagendamento atômico, transição de pesagem para ocupação física ou política de excedente da balança. Reservas são compromissos operacionais; não são estoque físico. Sem paginação e sem garantia de ordem global entre agregados; limites para futura evolução.

Comandos e evidências reais estão em `README.md` e `docs/validation.md`. Unidade usa adapter in-memory transacional com mutex, sem Docker. Integração executa HTTP via TCP/fetch, PostgreSQL real e RabbitMQ real: 10 concorrentes, disputa entre janelas, cancelamentos paralelos, rollback, inválidos, bloqueio, consultas persistentes, constraints, confirmação/roteamento, falhas/retries, timeout e reconexão sem parar broker compartilhado.