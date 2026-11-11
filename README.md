# AgroTrac Core — Serviço Core A (Operações e Vagas)

Microsserviço responsável pelo núcleo transacional e regras de negócio do sistema **AgroTrac**, em estrita conformidade com a especificação original (`acac36b6`).

---

## 1. Responsabilidades

- **Gestão de Silos e Capacidade**: Cadastro, consulta e controle rígido do saldo de capacidade física dos silos.
- **Janelas de Agendamento**: Criação, consulta, bloqueio e liberação de janelas operacionais de descarga.
- **Resolução de Disputa de Agendamento**: Processamento de reservas sob concorrência, impedindo *race conditions* e *overbooking* através de consistência transacional relacional.
- **Cancelamento Atômico**: Estorno e devolução atômica da capacidade da janela e saldo do silo em caso de cancelamento de reservas.
- **Publicação de Eventos**: Disparo de eventos de domínio no RabbitMQ (`agrotrac.events`) após a confirmação transacional de reservas e alterações operacionais.

---

## 2. Ferramentas e Tecnologias

- **Runtime**: Node.js com TypeScript.
- **Banco de Dados Relacional**: PostgreSQL (instância/database `agrotrac_core`).
- **Acesso a Dados**: Knex.js / Driver `pg` para execução de transações controladas e bloqueios pessimistas (`SELECT ... FOR UPDATE`).
- **Broker de Mensageria**: `amqplib` (publicação no RabbitMQ).
- **Framework Web / HTTP**: Fastify ou Express (camada fina de apresentação).
- **Testes Automatizados**: Vitest ou Jest com Repositórios em Memória (`InMemoryRepositories`).

---

## 3. Arquitetura (Clean Architecture)

A estrutura do microsserviço segue estritamente a separação entre regras de negócio e infraestrutura:

```text
agrotrac-core/
├── src/
│   ├── core/                    # Regras puras e Casos de Uso
│   │   ├── domain/              # Entidades, Value Objects e Erros de Domínio
│   │   │   ├── entities/        # Silo, JanelaDescarga, Reserva
│   │   │   ├── value-objects/   # CapacidadeKg (padronizado em kg), Placa, TimeSlot
│   │   │   ├── errors/          # Erros explícitos de negócio (Result / Either)
│   │   │   └── repositories/    # Interfaces de contratos de persistência
│   │   └── use-cases/           # Casos de uso da aplicação
│   │       ├── CreateBookingUseCase.ts
│   │       ├── CancelBookingUseCase.ts
│   │       ├── OpenWindowUseCase.ts
│   │       ├── BlockWindowUseCase.ts
│   │       ├── dtos/            # DTOs de entrada e saída
│   │       └── ports/           # Interfaces de mensageria (EventPublisher)
│   ├── infra/                   # Implementações de infraestrutura externa
│   │   ├── database/            # Conexão PostgreSQL, Migrations e Repositórios SQL
│   │   ├── http/                # Controllers, Rotas HTTP e Middlewares
│   │   └── messaging/           # Publisher de eventos no RabbitMQ
│   └── main.ts                  # Ponto de entrada e injeção de dependências
├── tests/
│   ├── in-memory/               # Repositórios em memória para testes sem banco
│   └── unit/                    # Testes de unidade dos casos de uso
├── package.json
└── tsconfig.json
```

---

## 4. Conexões e Integrações

- **Entrada (HTTP via Gateway)**:
  - `GET /v1/core/silos`: Lista silos e saldos de capacidade.
  - `GET /v1/core/windows`: Consulta janelas de agendamento disponíveis.
  - `POST /v1/core/bookings`: Solicita reserva de descarga (com bloqueio transacional).
  - `DELETE /v1/core/bookings/:id`: Cancela reserva e devolve capacidade atomicamente.
  - `PATCH /v1/core/windows/:id/status`: Bloqueia ou libera janela de descarga.
- **Saída (Banco de Dados)**:
  - Conexão com PostgreSQL (`agrotrac_core`) na porta `5432`.
- **Saída (Mensageria RabbitMQ)**:
  - Conexão na porta `5672`.
  - Publica mensagens na exchange `agrotrac.events` (Topic) com as chaves:
    - `agrotrac.core.booking.created`
    - `agrotrac.core.booking.cancelled`
    - `agrotrac.core.window.updated`
