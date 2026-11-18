# AgroTrac Core — MVP transacional

Node.js 22 + TypeScript, Fastify, pg e amqplib. Implementa silos, janelas, reservas, cancelamento e outbox atômica. Os contratos canônicos estão em [docs/contracts.md](docs/contracts.md); evidências reais em [docs/validation.md](docs/validation.md).

## Executar

```powershell
npm ci
npm run build
npm run typecheck
npm test
```

Unidade funciona sem Docker, PostgreSQL ou RabbitMQ. O build gera `dist/`; testes usam `tsx` com o runner nativo Node.

Configure conexão por ambiente. Nenhum `.env` é descoberto automaticamente. Para usar o arquivo local da infraestrutura, informe explicitamente seu caminho; as variáveis exportadas têm precedência:

```powershell
$env:CORE_INFRA_ENV_PATH = (Resolve-Path '../agrotrac-infra/.env').Path
$env:CORE_DB_SCHEMA = 'agrotrac_core_mvp'
$env:PGHOST = '127.0.0.1'
$env:PGPORT = '15432' # relay local descrito abaixo; 5432 somente se apontar ao banco correto
npm run migrate
$env:CORE_PORT = '3001'
npm start
```

Migração é explícita, aditiva e qualificada por schema; inspeciona o schema antes de criar tabelas. Recusa `public`, schemas de sistema e schema já ocupado sem marcador reconhecido. Não execute contra outro banco por suposição. O servidor não aplica migrações automaticamente.

Configuração alternativa: `DATABASE_URL` ou `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`; `RABBITMQ_URL` para broker. O arquivo explicitamente indicado também pode fornecer POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB e RABBITMQ_DEFAULT_USER/RABBITMQ_DEFAULT_PASS. Não grave nem imprima valores reais em exemplos/logs. `CORE_DB_SCHEMA` é obrigatório para execução normal. CORE_HOST padrão `127.0.0.1`, CORE_PORT padrão `3001`. RabbitMQ usa 5672 no host por padrão ao derivar a URL do arquivo da infra.

Sem autenticação: o bind local é intencional. Gateway/autenticação são trabalho futuro; não exponha como serviço protegido.

## Conflito local PostgreSQL 5432

Na validação de 15/11/2026, um PostgreSQL Windows ocupava a porta host 5432 e rejeitava a credencial da infra. A coordenação autorizou um relay temporário exclusivo ligado à rede Docker, sem alterar Compose, credenciais, volumes ou processos existentes:

```powershell
# Verifique que 15432 está livre antes de criar; se o container já existe, use docker start.
Get-NetTCPConnection -LocalPort 15432 -State Listen -ErrorAction SilentlyContinue
# Só executar se a porta estiver livre:
docker run -d --name agrotrac-core-test-relay-cf6006 --network agrotrac-infra_default -p 127.0.0.1:15432:15432 alpine/socat TCP-LISTEN:15432,fork,reuseaddr TCP:postgres:5432
```

O relay só encaminha TCP; não contém credenciais nem volume. Depois dos testes desta entrega ele foi parado e preservado. Para reutilizá-lo, `docker start agrotrac-core-test-relay-cf6006`; para parar, `docker stop agrotrac-core-test-relay-cf6006`. Não use `docker compose down -v`, não pare o PostgreSQL Windows e não altere a infraestrutura para contornar esse conflito.

## Integração real

Com a infra healthy e o relay acima ativo quando necessário:

```powershell
$env:CORE_INFRA_ENV_PATH = (Resolve-Path '../agrotrac-infra/.env').Path
$env:PGHOST = '127.0.0.1'
$env:PGPORT = '15432'
npm run test:integration
```

Sem skip silencioso: falta de banco, broker ou credenciais falha o comando. O teste gera e imprime um schema novo `core_it_<timestamp>_<id>`, ignorando CORE_DB_SCHEMA operacional, recusa reutilização e preserva todas as fixtures. Usa HTTP TCP real com fetch, PostgreSQL e RabbitMQ reais; não precisa iniciar o servidor manualmente. Usa exchange e duas filas duráveis UUID isoladas, sem publicar ou consumir filas operacionais, e preserva esses recursos ao final. Não execute limpeza automática: o schema/IDs impressos permitem inspeção posterior. Recuperação é simulada por conexão recusada e proxies locais próprios; nunca para o broker compartilhado.

## API e eventos

Prefixo `/v1/core`: POST/GET silos e windows, GET por ID, POST/GET bookings, GET booking por ID, DELETE booking por ID, PATCH windows/:id/status. Consulte schemas, filtros e códigos em contracts.md. Todos os erros usam envelope AgroTrac com correlation_id; Core gera o header quando ausente. Corpo limitado a 64 KiB.

Casos de uso em `src/application/core.ts`, invariantes/Result em `src/domain/`, portas em `src/application/ports.ts`; PostgreSQL, HTTP e mensageria em arquivos separados de `src/infra/`. O adapter in-memory transacional/mutex fica em `tests/support/memory.ts`.

Cada mutação salva seu evento no mesmo COMMIT dos dados. Publisher usa mensagens persistentes, confirm individual, mandatory/return, topologia durável, timeout/reconexão e backoff de até 60s, sem desistir após cinco falhas. Exchange canônica `agrotrac.events`; Live binding `agrotrac.core.#`; Audit bindings `agrotrac.core.#` e `agrotrac.live.#`. Event_id é preservado em reenvios; consumidores deduplicam e comparam versões dos agregados. A entrega é pelo menos uma vez e pode chegar fora de ordem.

Limites: sem Idempotency-Key, paginação, autenticação, no-show ou multa. Bloquear/encerrar janela preserva reservas. Reserva não equivale a estoque físico; nenhuma pesagem converte reserva em ocupação nesta entrega. Escrita externa direta nas tabelas pode quebrar coerência das somas; mutações devem passar pelo Core.
